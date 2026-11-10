"""Pure personal routing inference from authorized observations, without lexicons.

All names retain their identity. Exact field history wins, then complete learned
phrases, then corpus-weighted word overlap. A final bounded single-edit fallback
compares only personal model words for route inference; it never corrects titles.
No external synonyms, products, stopwords or linguistic exceptions are supplied.
"""

import copy
import json
import math
import unicodedata
from pathlib import Path

RULES = json.loads(
    (
        Path(__file__).resolve().parents[1] / "resources/routing_memory_rules.json"
    ).read_text()
)
FIELDS = ("list", "section", "stores")
_UNKNOWN = object()


class _PreparedRows(list):
    """Owned immutable input plus lazy analysis; never wraps caller-owned data."""

    def __init__(self, rows, context=None):
        super().__init__(rows)
        self.context = context if context is not None else {"names": {}, "tokens": {}}
        self.subsets, self.documents = {}, {}
        self.vocabulary = None


class _PreparedDocuments(list):
    def __init__(self, rows):
        super().__init__(rows)
        self.analysis = None
        self.words = None


def _subset(entries, key, build):
    if not isinstance(entries, _PreparedRows):
        return build()
    if key in entries.subsets:
        return entries.subsets[key]
    rows = build()
    # Do not retain arbitrary absent container/workspace IDs.
    if rows:
        rows = _PreparedRows(rows, entries.context)
        entries.subsets[key] = rows
    return rows


def _scoped_rows(entries, container_id):
    return entries if container_id is None else _subset(
        entries, ("scope", str(container_id)),
        lambda: [row for row in entries if str(row.get("shopping_list_id")) == str(container_id)],
    )


def _model_rows(entries):
    return _subset(entries, ("model",),
                   lambda: [row for row in entries if not row.get("inference_direct_only", False)])


def _source_name(entries, value):
    if not isinstance(entries, _PreparedRows):
        return normalize_route_name(value)
    raw = str(value or "")
    cache = entries.context["names"]
    if raw not in cache:
        cache[raw] = normalize_route_name(raw)
    return cache[raw]


def _source_tokens(entries, value):
    if not isinstance(entries, _PreparedRows):
        return routing_tokens(value)
    raw = str(value or "")
    cache = entries.context["tokens"]
    if raw not in cache:
        cache[raw] = routing_tokens(raw)
    return cache[raw]


def _document_words(documents):
    if isinstance(documents, _PreparedDocuments) and documents.words is not None:
        return documents.words
    words = {word for doc in documents for word in doc["words"]}
    if isinstance(documents, _PreparedDocuments):
        documents.words = words
    return words


def _typo_vocabulary(entries):
    if isinstance(entries, _PreparedRows) and entries.vocabulary is not None:
        return entries.vocabulary
    words = sorted({word for row in entries for word in _source_tokens(entries, row.get("name_key"))
                    if _eligible_typo_word(word)})
    if isinstance(entries, _PreparedRows):
        entries.vocabulary = words
    return words


def normalize_route_name(value):
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).casefold().split())


def is_ideographic(char):
    code = ord(char)
    return any(start <= code <= end for start, end in RULES["ideographic_ranges"])


def _token_spans(value):
    """Unicode word boundaries; ideographs are standard character tokens."""
    result, start = [], None
    for index, char in enumerate(value):
        ideographic = is_ideographic(char)
        word = unicodedata.category(char)[0] in ("L", "M", "N")
        if ideographic or not word:
            if start is not None:
                result.append((value[start:index], start, index))
                start = None
            if ideographic:
                result.append((char, index, index + 1))
        elif start is None:
            start = index
    if start is not None:
        result.append((value[start:], start, len(value)))
    return result


def routing_tokens(value):
    key = normalize_route_name(value)
    if len(key) > RULES["max_input_characters"]:
        return []
    tokens = [word for word, _, _ in _token_spans(key)]
    return tokens if len(tokens) <= RULES["max_tokens"] else []


def routing_lookup_names(value):
    """Bounded literal spans keep imported ideographic phrases retrievable."""
    key = normalize_route_name(value)
    spans = _token_spans(key) if len(key) <= RULES["max_input_characters"] else []
    if len(spans) > RULES["max_tokens"]:
        return [key]
    return list(
        dict.fromkeys(
            [
                key,
                *(
                    key[spans[start][1] : spans[end][2]]
                    for start in range(len(spans))
                    for end in range(start, len(spans))
                ),
            ]
        )
    )


def _known(row, field):
    known = (
        (row.get("preferred") or row.get("list_known"))
        if field == "list"
        else row.get(field + "_known")
    )
    return bool(known and row.get("evidence", {}).get(field, {}).get("reliable", True))


def _observed(row, field):
    return field in row.get("history_fields", []) or _known(row, field)


def _target(row, field):
    if field == "list":
        return row.get("shopping_list_id")
    if field == "section":
        return row.get("section_id")
    if field == "module":
        return row.get("module_value")
    return sorted(
        {str(value): value for value in row.get("store_ids", [])}.values(), key=str
    )


def _signature(value):
    if isinstance(value, list):
        return json.dumps(sorted(set(map(str, value))), ensure_ascii=False)
    return None if value is None else str(value)


def _resolve_rows(rows, field):
    observed = [row for row in rows if _observed(row, field)]
    if not observed:
        return "none", None
    if field == "list":
        winners = [row for row in observed if _known(row, field)]
        values = {_signature(_target(row, field)) for row in winners}
        return (
            ("value", _target(winners[0], field))
            if len(values) == 1
            else ("blocked", None)
        )
    if any(not _known(row, field) for row in observed):
        return "blocked", None
    values = {_signature(_target(row, field)) for row in observed}
    return (
        ("value", _target(observed[0], field))
        if len(values) == 1
        else ("blocked", None)
    )


def _documents(entries, field):
    if isinstance(entries, _PreparedRows) and field in entries.documents:
        return entries.documents[field]
    groups = {}
    for row in entries:
        key = _source_name(entries, row.get("name_key"))
        if key:
            groups.setdefault(key, {}).setdefault(
                row.get("key_kind", "exact"), []
            ).append(row)
    documents = []
    for key, kinds in sorted(groups.items()):
        for kind in ("exact", "token"):
            status, value = _resolve_rows(kinds.get(kind, []), field)
            if status == "none":
                continue
            documents.append(
                dict(
                    name_key=key,
                    key_kind=kind,
                    status=status,
                    value=value,
                    words=_source_tokens(entries, key),
                    inference_direct_only=all(
                        row.get("inference_direct_only", False)
                        for row in kinds[kind]
                        if _observed(row, field)
                    ),
                )
            )
            break
    if isinstance(entries, _PreparedRows) and documents:
        documents = _PreparedDocuments(documents)
        entries.documents[field] = documents
    return documents


def _source_keys(documents):
    return [
        dict(name_key=name, key_kind=kind)
        for name, kind in sorted(
            {(doc["name_key"], doc["key_kind"]) for doc in documents}
        )
    ]


def _result(status="none", value=None, kind=None, documents=(), score=0):
    return dict(
        status=status,
        value=value,
        match_kind=kind,
        source_keys=_source_keys(documents),
        score=round(score, 6),
    )


def _uniform_documents(documents, kind, score=1):
    if any(doc["status"] != "value" for doc in documents):
        return _result("blocked", kind=kind, documents=documents, score=score)
    values = {_signature(doc["value"]) for doc in documents}
    if len(values) != 1:
        return _result("blocked", kind=kind, documents=documents, score=score)
    return _result("value", documents[0]["value"], kind, documents, score)


def _subsequence(source, target):
    index = 0
    for word in target:
        if index < len(source) and source[index] == word:
            index += 1
    return index == len(source)


def _ideographic_words(words):
    return bool(words) and all(
        len(word) == 1 and is_ideographic(word) for word in words
    )


def _contains_phrase(source, query, source_name, query_name):
    if not source:
        return False
    if _ideographic_words(source):
        if source_name == query_name:
            return True
        if len(source) < RULES["min_ideographic_phrase_chars"]:
            return False
        return source_name in query_name
    return _subsequence(source, query)


def _corpus(documents):
    """Each complete personal phrase votes once; historical hits never inflate DF."""
    if isinstance(documents, _PreparedDocuments) and documents.analysis is not None:
        return documents.analysis
    frequencies, routes = {}, {}
    for doc in documents:
        signature = _signature(doc["value"]) if doc["status"] == "value" else _UNKNOWN
        for word in set(doc["words"]):
            frequencies[word] = frequencies.get(word, 0) + 1
            choices = routes.setdefault(word, {})
            choices[signature] = choices.get(signature, 0) + 1
    reliable = {}
    for word, choices in routes.items():
        ranked = sorted(choices.items(), key=lambda pair: pair[1], reverse=True)
        winner, count = ranked[0]
        if (
            winner is not _UNKNOWN
            and count / sum(choices.values()) >= RULES["min_term_route_fraction"]
            and (len(ranked) == 1 or count > ranked[1][1])
        ):
            reliable[word] = winner
    size = len(documents)

    def weight(word):
        if word not in frequencies:
            return RULES["unknown_term_weight"] * (1 + math.log((size + 1) / 2))
        frequency = frequencies[word]
        choices = routes[word]
        purity = max(choices.values()) / sum(choices.values())
        return (
            (1 + math.log((size + 1) / (frequency + 1)))
            * math.log(1 + frequency)
            * purity
        )

    result = (reliable, weight)
    if isinstance(documents, _PreparedDocuments):
        documents.analysis = result
    return result


def _match_field_without_typos(entries, name, field, container_id=None):
    """One decision engine for Tasks, Shopping, modules and imported memories."""
    key = normalize_route_name(name)
    entries = _scoped_rows(entries, container_id)
    documents = _documents(entries, field)
    model_documents = _documents(_model_rows(entries), field)
    exact = [
        doc
        for doc in documents
        if doc["name_key"] == key and doc["key_kind"] == "exact"
    ]
    if exact:
        return _uniform_documents(exact, "exact")
    query = routing_tokens(key)
    if not query:
        return _result()
    reliable, weight = _corpus(model_documents)
    model_words = _document_words(model_documents)
    complete = []
    for doc in documents:
        if not _contains_phrase(doc["words"], query, doc["name_key"], key):
            continue
        if (
            len(doc["words"]) == 1
            and doc["status"] == "value"
            and reliable.get(doc["words"][0], _UNKNOWN) != _signature(doc["value"])
            and not (
                doc["inference_direct_only"] and doc["words"][0] not in model_words
            )
        ):
            continue
        complete.append(doc)
    if complete:
        if len(complete) > RULES["max_candidate_phrases"]:
            return _result("blocked", kind="phrase")
        maximal = [
            doc
            for doc in complete
            if not any(
                len(other["words"]) > len(doc["words"])
                and _subsequence(doc["words"], other["words"])
                for other in complete
            )
        ]
        return _uniform_documents(maximal, "phrase")
    candidates = []
    query_words = set(query)
    query_weight = sum(weight(word) for word in query_words)
    for doc in model_documents:
        words = set(doc["words"])
        shared = words & query_words
        if not shared or all(_ideographic_words([word]) for word in shared):
            continue
        target = _signature(doc["value"]) if doc["status"] == "value" else _UNKNOWN
        useful = (
            shared
            if target is _UNKNOWN
            else {word for word in shared if reliable.get(word, _UNKNOWN) == target}
        )
        overlap = sum(weight(word) for word in useful)
        source_coverage = overlap / sum(weight(word) for word in words) if words else 0
        score = min(overlap / query_weight, source_coverage)
        if (
            score + 1e-12 >= RULES["min_statistical_similarity"]
            and source_coverage > RULES["min_statistical_source_coverage"] + 1e-12
        ):
            candidates.append((doc, score, target))
    if not candidates:
        return _result()
    if len(candidates) > RULES["max_candidate_phrases"]:
        return _result("blocked", kind="statistical")
    targets = {}
    for doc, score, target in candidates:
        targets[target] = max(score, targets.get(target, 0))
    ranked = sorted(targets.items(), key=lambda pair: pair[1], reverse=True)
    target, score = ranked[0]
    if (
        target is _UNKNOWN
        or score / sum(targets.values()) < RULES["min_target_route_fraction"]
        or (len(ranked) > 1 and score - ranked[1][1] < RULES["min_target_score_margin"])
    ):
        return _result(
            "blocked",
            kind="statistical",
            documents=[doc for doc, _, _ in candidates],
            score=score,
        )
    winners = [
        doc
        for doc, value, choice in candidates
        if choice == target and abs(value - score) < 1e-12
    ]
    return _result("value", winners[0]["value"], "statistical", winners, score)


def _eligible_typo_word(word):
    return len(word) >= RULES["min_typo_word_characters"] and all(
        unicodedata.category(char).startswith("L") and not is_ideographic(char)
        for char in word
    )


def single_typo_edit(left, right):
    """Exactly one elementary edit between long personal Unicode letter words."""
    left, right = normalize_route_name(left), normalize_route_name(right)
    if (
        RULES["max_typo_edits"] != 1
        or not _eligible_typo_word(left)
        or not _eligible_typo_word(right)
        or left == right
        or abs(len(left) - len(right)) > 1
    ):
        return False
    if len(left) == len(right):
        different = [index for index, (a, b) in enumerate(zip(left, right)) if a != b]
        if len(different) == 1:
            return True
        return (
            len(different) == 2
            and different[1] == different[0] + 1
            and left[different[0]] == right[different[1]]
            and left[different[1]] == right[different[0]]
        )
    short, long = (left, right) if len(left) < len(right) else (right, left)
    index = 0
    while index < len(short) and short[index] == long[index]:
        index += 1
    return short[index:] == long[index + 1 :]


def _typo_alignment(source, query, neighbors):
    # States retain both exact and edited alignments; skipping input words is
    # the same ordered-subsequence rule as complete personal phrase matching.
    states = {(0, False, False)}
    for word in query:
        following = set(states)
        for index, edited, ambiguous in states:
            if index == len(source):
                continue
            if source[index] == word:
                following.add((index + 1, edited, ambiguous))
            elif not edited and source[index] in neighbors.get(word, ()):
                following.add((index + 1, True, len(neighbors[word]) > 1))
        states = following
    complete = [
        ambiguous
        for index, edited, ambiguous in states
        if index == len(source) and edited
    ]
    return (bool(complete), any(complete))


def typo_field_match(entries, name, field, container_id=None):
    """Last, cautious personal-word fallback; no external dictionary or writes.

    Spelling uniqueness uses the full authorized model vocabulary. Edit
    protection uses observed history for this field, so an unobserved child of
    a newly learned list-only phrase is not accidentally treated as an exception.
    """
    query = routing_tokens(name)
    if not query:
        return _result()
    model = _model_rows(entries)
    observed = _documents(model, field)
    protected = _document_words(observed)
    vocabulary = _typo_vocabulary(model)
    neighbors = {}
    comparisons = 0
    for word in sorted(set(query)):
        if word in protected or not _eligible_typo_word(word):
            continue
        adjacent = set()
        for spelling in vocabulary:
            if spelling == word or abs(len(word) - len(spelling)) > 1:
                continue
            comparisons += 1
            if comparisons > RULES["max_typo_comparisons"]:
                return _result("blocked", kind="typo")
            if single_typo_edit(word, spelling):
                adjacent.add(spelling)
        if adjacent:
            neighbors[word] = adjacent
    if not neighbors:
        return _result()
    model = _scoped_rows(model, container_id)
    documents = _documents(model, field)
    possible = {word for words in neighbors.values() for word in words}
    candidates = [
        doc for doc in documents if any(word in possible for word in doc["words"])
    ]
    if len(candidates) > RULES["max_candidate_phrases"]:
        return _result("blocked", kind="typo")
    reliable, _weight = _corpus(documents)
    matched = []
    for doc in candidates:
        complete, ambiguous = _typo_alignment(doc["words"], query, neighbors)
        if not complete:
            continue
        if ambiguous:
            return _result("blocked", kind="typo")
        if (
            len(doc["words"]) == 1
            and doc["status"] == "value"
            and reliable.get(doc["words"][0], _UNKNOWN) != _signature(doc["value"])
        ):
            doc = {**doc, "status": "blocked"}
        matched.append(doc)
    if not matched:
        return _result()
    maximal = [
        doc
        for doc in matched
        if not any(
            len(other["words"]) > len(doc["words"])
            and _subsequence(doc["words"], other["words"])
            for other in matched
        )
    ]
    decision = _uniform_documents(maximal, "typo")
    # Rejected spellings were never applied; their imported observations must
    # not become correction provenance in a later deliberate content write.
    return (
        decision if decision["status"] == "value" else _result("blocked", kind="typo")
    )


def match_field(entries, name, field, container_id=None):
    decision = _match_field_without_typos(entries, name, field, container_id)
    return (
        typo_field_match(entries, name, field, container_id)
        if decision["status"] == "none"
        else decision
    )


def _suggest_scoped_route(entries, name, list_id=None, *, task=False):
    sources, values = {}, {}
    if list_id is None:
        choice = match_field(entries, name, "list")
        if choice["status"] != "value":
            return None
        list_id, sources["list"] = choice["value"], choice["match_kind"]
    for field in ("section",) if task else ("section", "stores"):
        choice = match_field(entries, name, field, list_id)
        if choice["status"] == "value":
            values[field], sources[field] = choice["value"], choice["match_kind"]
    if not sources:
        return None
    kinds = set(sources.values())
    return dict(
        name_key=normalize_route_name(name),
        shopping_list_id=list_id,
        list_known="list" in sources,
        preferred="list" in sources,
        section_known="section" in sources,
        section_id=values.get("section"),
        stores_known="stores" in sources,
        store_ids=values.get("stores", []),
        memory_fields=[field for field in FIELDS if field in sources],
        memory_sources=sources,
        match_kind=next(iter(kinds)) if len(kinds) == 1 else "mixed",
    )


def suggest_route(entries, name, list_id=None):
    return _suggest_scoped_route(
        _subset(entries, ("shopping",), lambda: [row for row in entries if row.get("shopping_list_id") is not None]),
        name,
        list_id,
    )


def task_routing_entries(entries, workspace_id=None):
    return _subset(entries, ("tasks", None if workspace_id is None else str(workspace_id)), lambda: [
        {
            **row,
            "shopping_list_id": row["project_id"],
            "list_known": row.get(
                "list_known", row.get("project_known", row.get("preferred", False))
            ),
        }
        for row in entries
        if row.get("project_id") is not None
        and (
            (row.get("workspace_id") is None and workspace_id is None)
            or (
                row.get("workspace_id") is not None
                and workspace_id is not None
                and str(row["workspace_id"]) == str(workspace_id)
            )
        )
    ])


def suggest_task_route(entries, name, workspace_id=None, project_id=None):
    route = _suggest_scoped_route(
        task_routing_entries(entries, workspace_id), name, project_id, task=True
    )
    if route is None:
        return None
    route.update(
        workspace_id=workspace_id,
        project_id=route.pop("shopping_list_id"),
        project_known=route["list_known"],
    )
    route.pop("store_ids")
    route.pop("stores_known")
    return route


def has_route_field_history(entries, name, field, list_id=None, *, task=False):
    decision = match_field(entries, name, field, list_id)
    return any(source["key_kind"] == "exact" for source in decision["source_keys"])


def has_route_history(entries, name, list_id=None):
    return any(
        has_route_field_history(entries, name, field, list_id) for field in FIELDS
    )


class _PreparedRoutingMatcher:
    def __init__(self, entries):
        self._source = copy.deepcopy(entries)
        self._policy = None
        self._rows = None

    def _current(self):
        policy = json.dumps(RULES, sort_keys=True)
        if policy != self._policy:
            self._policy = policy
            self._rows = _PreparedRows(self._source)
        return self._rows

    def suggest(self, name, list_id=None):
        return copy.deepcopy(suggest_route(self._current(), name, list_id))

    def suggest_task(self, name, workspace_id=None, project_id=None):
        return copy.deepcopy(suggest_task_route(self._current(), name, workspace_id, project_id))

    def match_field(self, name, field, container_id=None):
        return copy.deepcopy(match_field(self._current(), name, field, container_id))


def prepare_route_matcher(entries):
    """Own a model snapshot and reuse its analysis without caching query results."""
    return _PreparedRoutingMatcher(entries)
