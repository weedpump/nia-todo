"""HTML recipe extraction into a normal, unsaved Nia recipe draft."""
from __future__ import annotations

import base64
import math
import json
import re
import threading
import time
import unicodedata
import uuid
from fractions import Fraction
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup, UnicodeDammit
from pydantic import ValidationError
from recipe_scrapers import scrape_html
from recipe_scrapers._grouping_utils import group_ingredients

from services.public_fetch import PublicFetchError, fetch_public
from services.quantity_units import get_unit_definition, normalize_quantity_unit
from services.recipe_content import RecipeCreate
from services.recipe_images import normalize_recipe_image_bytes

_PARSE_LOCK = threading.Lock()
_VULGAR = {"¼": "1/4", "½": "1/2", "¾": "3/4", "⅐": "1/7", "⅑": "1/9", "⅒": "1/10", "⅓": "1/3", "⅔": "2/3", "⅕": "1/5", "⅖": "2/5", "⅗": "3/5", "⅘": "4/5", "⅙": "1/6", "⅚": "5/6", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8"}
_NUMBER = r"(?:\d+\s+\d+/\d+|\d+/\d+|\d+(?:[.,]\d+)?)"
_AMOUNT = re.compile(r"^(?P<number>" + _NUMBER + r")\s*(?P<rest>.*)$")
# Yield labels are intentionally distinct from the unit registry. A numbered
# piece/baking tin is not a person; unknown source wording remains visible.
_SERVING_LABELS = (
    # Explicit people/portion labels in the twelve UI locales. These identify
    # yield semantics, not foods or a guessed ingredient vocabulary.
    "serving", "servings", "serving(s)", "portion", "portions", "portion(s)",
    "Portionen", "Portion(en)", "Person", "Personen", "Person(en)", "persons", "people",
    "porce", "porcí", "osoba", "osoby", "osob",
    "porción", "porciones", "ración", "raciones", "persona", "personas",
    "personne", "personnes", "porzione", "porzioni", "persone",
    "portie", "porties", "persoon", "porcja", "porcje", "porcji", "osób",
    "porção", "porções", "pessoa", "pessoas", "порция", "порции", "порций", "человек",
    "portioner", "personer", "人份", "人", "份",
)
_SERVINGS = re.compile(r"^\s*(\d+(?:[.,]\d+)?)\s*(?P<label>" + "|".join(
    re.escape(label) for label in sorted(_SERVING_LABELS, key=len, reverse=True)
) + r")?\s*$", re.I)
# Leave room for the normal save operation's mutation identity and envelope.
_DRAFT_BYTE_BUDGET = 512 * 1024 - 1024


def _key() -> str:
    return "import-" + str(uuid.uuid4())


def _text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return ", ".join(filter(None, (_text(item) for item in value)))
    if isinstance(value, dict):
        return _text(value.get("name") or value.get("text") or value.get("value"))
    return BeautifulSoup(str(value), "html.parser").get_text(" ", strip=True).strip()


def _read(scraper, method, default=None):
    try:
        return getattr(scraper, method)()
    except Exception:
        return default


def _yield_alternatives(value, budget=None) -> list[str]:
    budget = [64] if budget is None else budget
    budget[0] -= 1
    if budget[0] < 0 or (isinstance(value, list) and len(value) > 32):
        raise PublicFetchError("recipe.import.invalidRecipe")
    if isinstance(value, list):
        return [text for item in value for text in _yield_alternatives(item, budget)]
    if isinstance(value, dict) and value.get("value") is not None:
        value = str(value["value"]) + " " + str(value.get("unitText") or value.get("unitCode") or "")
    text = _text(value)
    return [text] if text else []


def _servings_from_yield(values: list[str]) -> float | None:
    matches = [_SERVINGS.fullmatch(value) for value in values]
    explicit, bare = [], []
    for match in matches:
        if not match or re.search(r"^[1-9]\d*[.,]\d{3}$", match[1]):
            continue
        amount = float(match[1].replace(",", "."))
        if not 0 < amount <= 100000:
            continue
        (explicit if match["label"] else bare).append(amount)
    # Rich explicit labels win over duplicated bare values (Chefkoch commonly
    # publishes ["1", "1 Portionen"]). Piece-only alternatives never turn their
    # otherwise bare number into a serving count.
    if explicit:
        return explicit[0] if len(set(explicit)) == 1 else None
    if bare and len(set(bare)) == 1 and all(matches):
        return bare[0]
    return None


def parse_ingredient(line: str) -> tuple[dict, bool]:
    """Recognize only an unambiguous leading amount and registered unit.

    Compound amounts, ranges and alternatives retain their original wording;
    no learned language model or ingredient vocabulary is required.
    """
    original = _text(line)
    result = {"client_key": _key(), "name": original, "quantity_value": None,
              "quantity_unit": None, "quantity_text": None, "note": ""}
    normalized = original
    for glyph, fraction in _VULGAR.items():
        normalized = normalized.replace(glyph, " " + fraction)
    normalized = unicodedata.normalize("NFKC", normalized).replace("⁄", "/").strip()
    match = _AMOUNT.fullmatch(normalized)
    if not match:
        return result, True
    remainder = match["rest"].strip()
    if re.search(r"^[1-9]\d*[.,]\d{3}$", match["number"]):
        return result, True
    if not remainder or re.match(r"^(?:[0-9.,–—/()×-]|x(?:\s|\d)|bis\b|to\b|à\b)", remainder, re.I):
        return result, True
    try:
        number = match["number"].replace(",", ".")
        amount = sum((Fraction(part) for part in number.split()), Fraction())
        quantity = float(amount)
        if not math.isfinite(quantity) or quantity <= 0:
            return result, True
    except (ValueError, ZeroDivisionError, OverflowError):
        return result, True
    unit, name = None, remainder
    # Long aliases such as "fluid ounce" use the same central registry as
    # manual entry, Quick Add and BrainDump. Never invent a unit spelling.
    words = remainder.split()
    for count in range(min(4, len(words) - 1), 0, -1):
        candidate = " ".join(words[:count])
        if get_unit_definition(candidate) is not None:
            unit, name = normalize_quantity_unit(candidate), " ".join(words[count:])
            break
    if not unit:
        # Handle compact SI spellings ("200g flour", "500毫升 水").
        compact = re.match(r"^([^\s\d]+)\s+(.+)$", remainder)
        if compact and get_unit_definition(compact[1]) is not None:
            unit, name = normalize_quantity_unit(compact[1]), compact[2]
    if not name:
        return result, True
    result.update(name=name, quantity_value=quantity, quantity_unit=unit)
    return result, False


def _minutes(value):
    if isinstance(value, bool):
        return None
    try:
        minutes = float(value)
        return int(math.ceil(minutes)) if math.isfinite(minutes) and 0 <= minutes <= 100000 else None
    except (TypeError, ValueError, OverflowError):
        return None


def _bounded_records(value, maximum: int) -> list | tuple:
    """Reject oversized scraper collections before any per-record parsing."""
    if value is None:
        return []
    if isinstance(value, str):
        value = [value] if value else []
    if not isinstance(value, (list, tuple)) or len(value) > maximum:
        raise PublicFetchError("recipe.import.invalidRecipe")
    return value


def _source_ingredient_groups(scraper, url: str, ingredients: list | tuple, groups: list | tuple):
    """Fill a known adapter gap without changing its canonical ingredient lines.

    Chefkoch's structured recipe has a flat ingredient list; its visible group
    headings live in HTML. The pinned adapter currently checks only generic
    WordPress grouping selectors. Supply its missing source selectors here until
    the adapter supports them, and accept the result only if every original line
    remains in exactly the same order (the library matcher can otherwise guess).
    """
    if len(groups) > 1 or groups and _text(getattr(groups[0], "purpose", None)):
        return groups, False
    selectors = {
        "chefkoch.de": (".ds-ingredients-table .ds-ingredients-table__headline",
                        ".ds-ingredients-table .ds-ingredients-table__tr"),
    }.get((urlsplit(url).hostname or "").lower().removeprefix("www."))
    soup = getattr(scraper, "soup", None)
    if not selectors or soup is None or not ingredients:
        return groups, False
    heading_selector, row_selector = selectors
    headings = soup.select(heading_selector, limit=51)
    if not headings:
        return groups, False
    rows = soup.select(row_selector, limit=501)
    if len(headings) > 50 or len(rows) > 500:
        raise PublicFetchError("recipe.import.invalidRecipe")
    if len(rows) != len(ingredients):
        return groups, True
    try:
        recovered = group_ingredients(list(ingredients), soup, heading_selector, row_selector)
    except Exception:
        return groups, True
    recovered = _bounded_records(recovered, 50)
    if [line for group in recovered for line in group.ingredients] != list(ingredients):
        return groups, True
    return recovered, False


def _bound_instruction_tree(value, *, budget=None, depth=0):
    """Bound nested HowToSection arrays before the scraper flattens them."""
    budget = [512] if budget is None else budget
    budget[0] -= 1
    if budget[0] < 0 or depth > 12:
        raise PublicFetchError("recipe.import.invalidRecipe")
    if isinstance(value, list):
        if len(value) > 100:
            raise PublicFetchError("recipe.import.invalidRecipe")
        for child in value:
            _bound_instruction_tree(child, budget=budget, depth=depth + 1)
    elif isinstance(value, dict) and "itemListElement" in value:
        _bound_instruction_tree(value["itemListElement"], budget=budget, depth=depth + 1)


def _structured_instructions(value) -> list[dict] | None:
    """Read explicit schema step fields before adapters flatten name into text.

    Several adapters return section names and step headings as extra instruction
    lines. Standard structured steps keep those fields separate. Unsupported
    schema shapes fall back to the adapter; no heading is guessed from prose.
    The complete schema tree was bounded before this helper is called.
    """
    steps = []
    def visit(item, context=()):
        if isinstance(item, list):
            return all(visit(child, context) for child in item)
        if not isinstance(item, dict):
            return False
        if "itemListElement" in item:
            name = _text(item.get("name"))
            # Section names carry preparation context but are not separate
            # cooking steps. Keep them with their descendant instructions.
            section_context = (*context, name) if name and not re.fullmatch(r"\d+[.)]?", name) else context
            start = len(steps)
            if not visit(item["itemListElement"], section_context):
                return False
            introduction = _text(item.get("text"))
            if introduction and len(steps) > start and introduction not in steps[start]["text"]:
                steps[start]["text"] = introduction + "\n\n" + steps[start]["text"]
            return True
        if not item.get("text"):
            return False
        body, name = _text(item["text"]), _text(item.get("name"))
        if not body:
            return False
        titles = list(dict.fromkeys((*context, name)))
        headings = []
        for title in titles:
            if not title or title == body or re.fullmatch(r"\d+[.)]?", title):
                continue
            if len(title) > 200:
                # A paragraph placed in name is still source content: retain it
                # as body rather than discarding it or rendering a huge heading.
                if title not in body:
                    body = title + "\n\n" + body
            else:
                headings.append(title)
        title = " · ".join(headings)
        if len(title) > 200:
            body = title + "\n\n" + body
            title = ""
        steps.append({"title": title, "text": body})
        return True
    return steps if visit(value) and steps else None


def extract_recipe_html(html: str, url: str) -> dict:
    """Parse already downloaded HTML. The library is never allowed to fetch."""
    warnings: list[str] = []
    def warn(key):
        if key not in warnings:
            warnings.append(key)
    try:
        # recipe-scrapers attaches parser plugins to classes on first use.
        # Serialize this short operation rather than racing initialization.
        with _PARSE_LOCK:
            scraper = scrape_html(html=html, org_url=url, online=False, supported_only=False, best_image=False)
            schema = getattr(getattr(scraper, "schema", None), "data", {})
            # Inspect raw schema arrays before even asking the library to group
            # ingredients or flatten instructions. The HTML byte limit alone
            # still permits hundreds of thousands of tiny JSON array entries.
            for field, maximum in (("recipeIngredient", 500), ("recipeInstructions", 100)):
                if isinstance(schema.get(field), list) and len(schema[field]) > maximum:
                    raise PublicFetchError("recipe.import.invalidRecipe")
            _bound_instruction_tree(schema.get("recipeInstructions"))
            structured_instructions = _structured_instructions(schema.get("recipeInstructions"))
            raw_ingredients = _bounded_records(_read(scraper, "ingredients", []), 500)
            raw_groups = _bounded_records(_read(scraper, "ingredient_groups"), 50)
            raw_groups, uncertain_groups = _source_ingredient_groups(scraper, url, raw_ingredients, raw_groups)
            if uncertain_groups:
                warn("recipe.import.reviewIngredients")
            group_lines = []
            count = 0
            for group in raw_groups:
                lines = _bounded_records(getattr(group, "ingredients", []), 500)
                count += len(lines)
                if count > 500:
                    raise PublicFetchError("recipe.import.invalidRecipe")
                group_lines.append(lines)
            instructions = _bounded_records(
                structured_instructions if structured_instructions is not None else _read(scraper, "instructions_list", []), 100
            )
            if not instructions:
                instructions = _bounded_records(str(_read(scraper, "instructions", "") or "").splitlines(), 100)
            title, description = _text(_read(scraper, "title")), _text(_read(scraper, "description"))
            author = _text(_read(scraper, "author"))
            site_name = _text(_read(scraper, "site_name")) or urlsplit(url).hostname or ""
            images = _read(scraper, "image") or getattr(getattr(scraper, "schema", None), "data", {}).get("image")
            if isinstance(images, list): images = images[0] if images else None
            if isinstance(images, dict): images = images.get("url") or images.get("contentUrl")
            image_url = images if isinstance(images, str) else None
            prep, cook = _minutes(_read(scraper, "prep_time")), _minutes(_read(scraper, "cook_time"))
            yield_values = _yield_alternatives(_read(scraper, "yields"))
            # Access the original structured yield before the scraper's generic
            # yield normalization can turn "12 cookies" into "12 servings".
            schema_yield = getattr(getattr(scraper, "schema", None), "data", {}).get("recipeYield")
            if schema_yield is not None:
                yield_values = _yield_alternatives(schema_yield)
            raw_yield = ", ".join(yield_values)
            keywords = _read(scraper, "keywords", []) or []
    except PublicFetchError:
        raise
    except Exception:
        raise PublicFetchError("recipe.import.notFound") from None
    if not title or not (raw_groups or raw_ingredients or instructions):
        raise PublicFetchError("recipe.import.notFound")
    groups = []
    if raw_groups:
        for group, lines in zip(raw_groups, group_lines):
            group_name = _text(getattr(group, "purpose", None))
            groups.append({"client_key": _key(), "name": group_name, "ingredients": []})
            for line in lines:
                ingredient, uncertain = parse_ingredient(line)
                if ingredient["name"]:
                    groups[-1]["ingredients"].append(ingredient)
                    if uncertain: warn("recipe.import.reviewIngredients")
    elif raw_ingredients:
        groups = [{"client_key": _key(), "name": "", "ingredients": []}]
        for line in raw_ingredients:
            ingredient, uncertain = parse_ingredient(line)
            if ingredient["name"]:
                groups[0]["ingredients"].append(ingredient)
                if uncertain: warn("recipe.import.reviewIngredients")
    # Some site adapters expose standalone ordinal labels as instruction lines.
    # Nia numbers its own steps; an isolated "1." is not a cooking instruction.
    steps = []
    for line in instructions:
        body = line["text"] if structured_instructions is not None else _text(line)
        if body and not re.fullmatch(r"\d+[.)]", body):
            steps.append({"client_key": _key(), "title": line["title"] if structured_instructions is not None else "",
                          "text": body, "ingredients": []})
    if not any(group["ingredients"] for group in groups) and not steps:
        raise PublicFetchError("recipe.import.notFound")
    servings = _servings_from_yield(yield_values)
    if servings is None:
        servings = 1
        warn("recipe.import.reviewServings")
    if isinstance(keywords, str):
        keywords = keywords.split(",", 40)
    if not isinstance(keywords, (list, tuple)):
        keywords = []
        warn("recipe.import.truncated")
    if len(keywords) > 40:
        keywords = keywords[:40]
        warn("recipe.import.truncated")
    tags = []
    for raw_tag in keywords:
        if not isinstance(raw_tag, str) or len(raw_tag) > 4096:
            warn("recipe.import.truncated")
            continue
        tag = _text(raw_tag)
        if len(tag) > 80:
            warn("recipe.import.truncated")
        elif tag and tag not in tags:
            tags.append(tag)
    if len(groups) > 50 or sum(len(group["ingredients"]) for group in groups) > 500 or len(steps) > 100:
        raise PublicFetchError("recipe.import.invalidRecipe")
    draft = {"title": title, "description": description, "base_servings": servings,
             "prep_minutes": prep, "cook_minutes": cook, "tags": tags,
             "ingredient_groups": groups, "steps": steps, "source_url": url,
             "source_name": site_name[:200], "source_author": author[:500], "source_yield": raw_yield[:500]}
    if len(site_name) > 200 or len(author) > 500 or len(raw_yield) > 500:
        warn("recipe.import.truncated")
    if len(json.dumps(draft, ensure_ascii=False).encode("utf-8")) > _DRAFT_BYTE_BUDGET:
        raise PublicFetchError("recipe.import.tooLarge")
    try:
        RecipeCreate.model_validate({**draft, "client_mutation_id": "import-preview-validation"})
    except (ValidationError, ValueError, TypeError):
        raise PublicFetchError("recipe.import.invalidRecipe") from None
    # This is a reference, never an independently fetchable URL exposed to the
    # browser. Any optional image uses the same public-only pinned downloader.
    return {"draft": draft, "warnings": warnings, "image_url": image_url}


def import_recipe(url: str, *, include_image: bool = True) -> dict:
    started = time.monotonic()
    page = fetch_public(url, timeout=18)
    try:
        html = page.body.decode(page.charset, errors="replace") if page.charset else None
    except LookupError:
        html = None
    if html is None:
        html = UnicodeDammit(page.body, is_html=True).unicode_markup or page.body.decode("utf-8", errors="replace")
    result = extract_recipe_html(html, page.url)
    image_url = result.pop("image_url", None)
    if include_image and image_url:
        try:
            remaining = 30 - (time.monotonic() - started)
            if remaining <= 0:
                raise PublicFetchError("recipe.import.downloadFailed")
            image = fetch_public(urljoin(page.url, str(image_url)), image=True, max_bytes=8 * 1024 * 1024, timeout=min(10, remaining))
            normalized = normalize_recipe_image_bytes(image.body)
            data_uri = "data:image/webp;base64," + base64.b64encode(normalized["content"]).decode("ascii")
            if len(json.dumps({**result["draft"], "image_data": data_uri}, ensure_ascii=False).encode("utf-8")) > _DRAFT_BYTE_BUDGET:
                raise ValueError("Optional image would exceed the recipe aggregate limit")
            result["draft"]["image_data"] = data_uri
        except (PublicFetchError, ValueError, TypeError):
            result["warnings"].append("recipe.import.imageUnavailable")
    return result
