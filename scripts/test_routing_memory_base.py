#!/usr/bin/env python3
"""Pure personal-corpus matching regressions; no DB, service or dictionaries."""

import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
from services.routing_matcher import (
    RULES,
    match_field,
    routing_tokens,
    routing_lookup_names,
    suggest_route,
    suggest_task_route,
    single_typo_edit,
)


def shopping(name, listing=10, section=20, **extra):
    result = dict(
        name_key=name,
        key_kind="exact",
        shopping_list_id=listing,
        list_known=True,
        preferred=True,
        section_known=True,
        section_id=section,
        stores_known=True,
        store_ids=[30],
        history_fields=["list", "section", "stores"],
    )
    result.update(extra)
    return result


def task(name, workspace=9, project=10, section=20, **extra):
    result = dict(
        name_key=name,
        key_kind="exact",
        workspace_id=workspace,
        project_id=project,
        list_known=True,
        project_known=True,
        preferred=True,
        section_known=True,
        section_id=section,
        history_fields=["list", "section"],
    )
    result.update(extra)
    return result


def test_registry_contains_only_numeric_policy_and_unicode_metadata():
    def numeric(value):
        if isinstance(value, dict):
            return all(numeric(child) for child in value.values())
        if isinstance(value, list):
            return all(numeric(child) for child in value)
        return type(value) in (int, float)

    assert numeric(RULES)
    assert {
        "aliases",
        "stopwords",
        "excluded_forms",
        "base_rules",
        "legacy_token_rules",
    }.isdisjoint(RULES)
    assert routing_tokens("Bitte Öl 2 TK und 123") == [
        "bitte",
        "öl",
        "2",
        "tk",
        "und",
        "123",
    ]


def test_unknown_full_products_and_modifiers_need_no_application_vocabulary():
    rows = [shopping("Margerine")]
    assert suggest_route(rows, "pflanzliche Margerine")["section_id"] == 20
    assert (
        suggest_route(rows, "arbiträrselbstgeschrieben Margerine")["section_id"] == 20
    )
    typo = suggest_route([shopping("Margarine")], "Margerine")
    assert typo["match_kind"] == "typo" and typo["name_key"] == "margerine"
    assert suggest_route([shopping("butter")], "beurre") is None
    assert suggest_route([shopping("tomato")], "tomatoes") is None
    assert suggest_route([shopping("Lita")], "Liter") is None
    assert suggest_route([shopping("TK")], "2 TK Produkte")["section_id"] == 20


def test_complete_personal_phrases_allow_insertions_and_nested_specificity():
    rows = [shopping("Tomaten"), shopping("getrocknete Tomaten", section=21)]
    route = suggest_route(rows, "getrocknete Bio Tomaten")
    assert route["section_id"] == 21 and route["memory_sources"]["section"] == "phrase"
    rows.append(shopping("getrocknete Bio Tomaten", section=22))
    assert suggest_route(rows, "getrocknete Bio Tomaten")["section_id"] == 22
    assert (
        suggest_route(
            [shopping("Bio Butter", section=21), shopping("Butter")],
            "Bio regionale Butter",
        )["section_id"]
        == 21
    )


def test_incomparable_complete_sources_do_not_win_by_title_length():
    rows = [shopping("bitte kaufen", listing=11, section=21), shopping("Margerine")]
    assert suggest_route(rows, "bitte Margerine kaufen") is None
    route = suggest_route(
        [shopping("rote Tomaten", section=21), shopping("Bio Tomaten")],
        "rote Bio Tomaten",
    )
    assert route["list_known"] and not route["section_known"] and route["stores_known"]
    unknown = shopping(
        "getrocknete Tomaten",
        section_known=False,
        evidence={"section": {"reliable": False}},
    )
    route = suggest_route([shopping("Tomaten"), unknown], "getrocknete Bio Tomaten")
    assert route["list_known"] and not route["section_known"] and route["stores_known"]


def test_modern_partial_overlap_is_bidirectional_and_has_no_verb_dictionary():
    assert suggest_task_route([task("Wäsche waschen")], "Wäsche machen", 9) is None
    assert suggest_task_route([task("Wäsche waschen")], "Auto waschen", 9) is None
    rows = [task("Wäsche waschen"), task("Auto waschen", project=11)]
    route = suggest_task_route(rows, "Wäsche machen", 9)
    assert (
        route["project_id"] == 10 and route["memory_sources"]["list"] == "statistical"
    )
    assert (
        suggest_task_route(
            [task("Wäsche machen"), task("Auto machen", project=11)],
            "Wäsche waschen",
            9,
        )["project_id"]
        == 10
    )
    assert (
        suggest_task_route(
            [task("unbekanntes Xylofon"), task("unbekanntes Dings", project=11)],
            "anderes Xylofon",
            9,
        )["project_id"]
        == 10
    )
    assert suggest_task_route(rows, "Wäschen wascen", 9) is None


def test_term_specificity_is_learned_from_distinct_personal_titles():
    rows = [task("Wäsche waschen", project=10), task("Auto waschen", project=11)]
    assert suggest_task_route(rows, "Wäsche machen", 9)["project_id"] == 10
    assert suggest_task_route(rows, "Auto machen", 9)["project_id"] == 11
    assert (
        suggest_task_route(rows, "Fenster waschen", 9) is None
    ), "the common conflicting action word has no route purity"
    rows.append(task("waschen", project=10))
    assert (
        suggest_task_route(rows, "waschen", 9)["project_id"] == 10
    ), "the exact personal title stays valid"
    assert suggest_task_route(rows, "Fenster waschen", 9) is None
    assert suggest_task_route(rows, "Wäsche Auto", 9) is None


def test_counter_replays_and_identical_rows_never_inflate_document_frequencies():
    rows = [task("Wäsche waschen", project=10), task("Auto waschen", project=11)]
    result = suggest_task_route(rows, "Wäsche machen", 9)
    duplicate = {
        **rows[1],
        "legacy_hits": 1000000,
        "evidence": {"list": {"support": 1000000, "reliable": True}},
    }
    assert (
        suggest_task_route([*rows, *([duplicate] * 200)], "Wäsche machen", 9) == result
    )


def test_exact_field_uncertainty_and_explicit_empty_targets_remain_independent():
    exact = shopping(
        "Bio Butter",
        section_known=False,
        store_ids=[],
        evidence={"section": {"reliable": False}},
    )
    route = suggest_route([shopping("Butter"), exact], "Bio Butter")
    assert route["list_known"] and not route["section_known"] and route["stores_known"]
    assert route["store_ids"] == []
    empty = shopping("Butter", section=None, store_ids=[])
    route = suggest_route([empty], "neue Butter")
    assert (
        route["section_known"]
        and route["section_id"] is None
        and route["store_ids"] == []
    )


def test_imports_share_the_engine_and_precise_personal_titles_override_them():
    imported = shopping("wäsche", key_kind="token", legacy_hits=100)
    route = suggest_route([imported], "Wäsche waschen")
    assert (
        route["shopping_list_id"] == 10 and route["memory_sources"]["list"] == "phrase"
    )
    decision = match_field([imported], "Wäsche waschen", "list")
    assert decision["source_keys"] == [{"name_key": "wäsche", "key_kind": "token"}]
    modern = shopping("wäsche", listing=11, section=21)
    assert suggest_route([imported, modern], "Wäsche waschen")["shopping_list_id"] == 11
    unknown = shopping(
        "wäsche",
        list_known=False,
        preferred=False,
        evidence={"list": {"reliable": False}},
    )
    assert suggest_route([imported, unknown], "Wäsche waschen") is None


def test_lossy_imports_never_pretend_to_be_explicit_full_titles():
    imported = task("waschen", key_kind="token", legacy_hits=100)
    rows = [imported, task("Wäsche waschen"), task("Auto waschen", project=11)]
    assert suggest_task_route(rows, "waschen", 9) is None
    assert (
        suggest_task_route([*rows, task("waschen")], "waschen", 9)["project_id"] == 10
    )


def test_ideographic_sources_use_standard_metadata_and_complete_learned_phrases():
    assert routing_tokens("请洗衣服") == ["请", "洗", "衣", "服"]
    assert suggest_task_route([task("洗衣服")], "请洗衣服", 9)["project_id"] == 10
    assert (
        suggest_route([shopping("人造黄油")], "植物性人造黄油")["shopping_list_id"]
        == 10
    )
    assert suggest_route([shopping("油")], "酱油") is None
    assert suggest_route([shopping("油")], "油")["shopping_list_id"] == 10
    imported = shopping("油", key_kind="token")
    literal = suggest_route([imported], "油")
    assert literal["shopping_list_id"] == 10 and literal["match_kind"] == "phrase"
    assert suggest_route([imported], "酱油") is None
    assert suggest_route([shopping("洗衣服")], "洗地服") is None
    assert suggest_route([shopping("洗衣服")], "洗新衣新服") is None
    assert suggest_route([shopping("人造黄油")], "人,造黄油") is None
    assert suggest_route([shopping("人造黄油")], "人 造黄油") is None
    assert "人造黄油" in routing_lookup_names("植物性人造黄油")


def test_all_supported_locales_are_ordinary_personal_data_not_alias_tables():
    samples = [
        ("de", "Wäsche waschen", "Wäsche machen"),
        ("en", "wash laundry", "do laundry"),
        ("fr", "laver vêtements", "ranger vêtements"),
        ("it", "lavare vestiti", "sistemare vestiti"),
        ("es", "lavar ropa", "ordenar ropa"),
        ("nl", "wasgoed wassen", "wasgoed doen"),
        ("pl", "prać ubrania", "sortować ubrania"),
        ("pt-BR", "lavar roupas", "organizar roupas"),
        ("ru", "стирать бельё", "сортировать бельё"),
        ("sv", "tvätta kläder", "sortera kläder"),
        ("cs", "prát oblečení", "třídit oblečení"),
        ("zh-CN", "洗衣服", "请洗衣服"),
    ]
    for locale, source, query in samples:
        overlap = set(routing_tokens(source)) & set(routing_tokens(query))
        context = [task(source)]
        remainder = [word for word in routing_tokens(source) if word not in overlap]
        if remainder:
            context.append(task("zzzz " + " ".join(remainder), project=11))
        assert suggest_task_route(context, query, 9)["project_id"] == 10, locale


def test_scope_boundaries_and_reads_never_mutate_personal_data():
    rows = [task("Wäsche waschen"), task("Auto waschen", project=11)]
    before = copy.deepcopy(rows)
    assert suggest_task_route(rows, "Wäsche machen", 8) is None
    assert suggest_task_route(rows, "Wäsche machen", 9, 11) is None
    assert suggest_task_route(rows, "Wäsche machen", 9)["project_id"] == 10
    assert rows == before


def test_numeric_budgets_abstain_without_masking_conflicts_or_exact_memories():
    old = RULES["max_tokens"]
    try:
        RULES["max_tokens"] = 2
        row = shopping("a b c")
        assert suggest_route([row], "a b c")["shopping_list_id"] == 10
        assert suggest_route([row], "d a b c") is None
    finally:
        RULES["max_tokens"] = old
    old = RULES["max_candidate_phrases"]
    try:
        RULES["max_candidate_phrases"] = 1
        assert suggest_route([shopping("a"), shopping("b", listing=11)], "a b") is None
    finally:
        RULES["max_candidate_phrases"] = old


def test_consistent_additional_phrases_reinforce_instead_of_disabling_the_route():
    rows = [task("Wäsche waschen"), task("Auto waschen", project=11)]
    for title in ["Wäsche trocknen", "Wäsche falten", "Wäsche bügeln"]:
        rows.append(task(title))
        assert suggest_task_route(rows, "Wäsche machen", 9)["project_id"] == 10


def test_direct_only_old_literal_recall_never_changes_shared_model_statistics():
    rows = [shopping("Wäsche waschen"), shopping("Auto waschen", listing=11)]
    before = match_field(rows, "Wäsche machen", "list")
    extra = shopping("Wäsche trocknen", listing=12, inference_direct_only=True)
    assert match_field([*rows, extra], "Wäsche machen", "list") == before
    extra = shopping("token0000", key_kind="token", inference_direct_only=True)
    assert suggest_route([*rows, extra], "token0000 morgen")["shopping_list_id"] == 10
    conflict = shopping("token0000 machen", listing=11)
    assert suggest_route([conflict, extra], "token0000 morgen") is None


def test_typo_distance_allows_only_one_long_letter_edit():
    for spelling in ["margarinee", "margarin", "margerine", "magrarine"]:
        assert single_typo_edit("margarine", spelling), spelling
        assert single_typo_edit(spelling, "margarine"), spelling
    assert single_typo_edit("christian", "christina")
    for spelling in [
        "margarine",
        "margarinexx",
        "marzerin",
        "margarine1",
        "margariq\u0301ne",
    ]:
        assert not single_typo_edit("margarine", spelling), spelling
    assert not single_typo_edit("tomaten", "tomatn")
    assert not single_typo_edit("植物性人造黄油", "植物生人造黄油")


def test_typo_is_a_last_resort_with_observed_uncertainty_and_precise_names_first():
    rows = [shopping("margarine")]
    for name in ["margarinee", "margarin", "margerine", "magrarine"]:
        route = suggest_route(rows, name)
        assert route["shopping_list_id"] == 10 and route["match_kind"] == "typo", name
        assert (
            route["name_key"] == name
        ), "the current displayed/saved identity is never corrected"
    exact = shopping("margerine", listing=11, section=21)
    assert suggest_route([*rows, exact], "margerine")["shopping_list_id"] == 11
    unknown = shopping(
        "margerine",
        list_known=False,
        preferred=False,
        evidence={"list": {"reliable": False}},
    )
    decision = match_field([*rows, unknown], "margerine", "list")
    assert decision["status"] == "blocked" and decision["match_kind"] == "exact"
    assert match_field(
        [
            shopping(
                "christian",
                section_known=False,
                evidence={"section": {"reliable": False}},
            )
        ],
        "christina",
        "section",
        10,
    ) == {
        "status": "blocked",
        "value": None,
        "match_kind": "typo",
        "source_keys": [],
        "score": 0,
    }


def test_typo_uniqueness_uses_all_model_words_not_only_the_destination_field():
    rows = [
        shopping("margarine"),
        shopping(
            "margerine",
            section_known=False,
            stores_known=False,
            history_fields=["list"],
        ),
    ]
    for field in ["list", "section", "stores"]:
        decision = match_field(
            rows, "margirine", field, None if field == "list" else 10
        )
        assert (
            decision["status"] == "blocked"
            and decision["match_kind"] == "typo"
            and decision["source_keys"] == []
        ), field
    assert (
        suggest_route([shopping("margarine"), shopping("margerine")], "margirine")
        is None
    ), "same-destination spellings are still distinct candidates"


def test_typo_edit_protection_is_field_specific_and_precedes_container_filtering():
    source = shopping("christian")
    known = shopping("christina besuchen", listing=11, section=21)
    decision = match_field([source, known], "christina", "section", 10)
    assert (
        decision["status"] == "none"
    ), "a correctly known word in observed field history is protected across containers"
    unobserved = shopping(
        "christina besuchen",
        listing=11,
        section_known=False,
        stores_known=False,
        history_fields=["list"],
    )
    decision = match_field([source, unobserved], "christina", "section", 10)
    assert (
        decision["status"] == "value" and decision["match_kind"] == "typo"
    ), "unobserved fields are never spelling exceptions"


def test_typo_child_fields_survive_list_only_learning_of_the_corrected_full_title():
    rows = [
        shopping("margerine"),
        shopping(
            "pflanzliche margarine",
            section_known=False,
            stores_known=False,
            history_fields=["list"],
        ),
    ]
    route = suggest_route(rows, "pflanzliche margarine")
    assert (
        route["list_known"] and route["section_id"] == 20 and route["store_ids"] == [30]
    )
    assert route["memory_sources"] == {
        "list": "exact",
        "section": "typo",
        "stores": "typo",
    }


def test_typo_alignment_requires_one_edit_in_a_complete_ordered_source_phrase():
    rows = [shopping("margarine vorbereiten")]
    route = suggest_route(rows, "frische margarinee heute vorbereiten")
    assert route and route["match_kind"] == "typo"
    assert (
        suggest_route(rows, "margarinee vorbereitne") is None
    ), "two edited source words are forbidden"
    assert (
        suggest_route(rows, "vorbereiten margarinee") is None
    ), "source order is preserved"
    nested = [
        shopping("margarine", listing=11, section=21),
        shopping("margarine vorbereiten"),
    ]
    assert (
        suggest_route(nested, "frische margarinee heute vorbereiten")[
            "shopping_list_id"
        ]
        == 10
    )
    conflict = [shopping("margarine"), shopping("christian", listing=11, section=21)]
    decision = match_field(conflict, "margarinee christina", "list")
    assert decision["status"] == "blocked" and decision["source_keys"] == []


def test_typo_budget_and_direct_only_rows_never_offer_a_truncated_guess():
    assert (
        suggest_route([shopping("margarine", inference_direct_only=True)], "margerine")
        is None
    )
    old = RULES["max_typo_comparisons"]
    try:
        RULES["max_typo_comparisons"] = 0
        decision = match_field([shopping("margarine")], "margerine", "list")
        assert (
            decision["status"] == "blocked"
            and decision["match_kind"] == "typo"
            and decision["source_keys"] == []
        )
    finally:
        RULES["max_typo_comparisons"] = old


if __name__ == "__main__":
    tests = [fn for name, fn in globals().items() if name.startswith("test_")]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"Personal-corpus routing passed: {len(tests)}/{len(tests)}")
