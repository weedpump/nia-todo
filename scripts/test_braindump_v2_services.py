#!/usr/bin/env python3
"""BrainDump v2 service/domain tests."""

import sqlite3
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / "api"))

from services.braindump_v2 import (  # noqa: E402
    append_text_segment,
    create_session,
    ensure_braindump_enabled,
    finalize_session,
    reset_sessions_for_tests,
)


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


def test_user_gate_defaults_to_disabled():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, braindump_enabled INTEGER NOT NULL DEFAULT 0)")
    db.execute("INSERT INTO users (id) VALUES (1)")
    try:
        ensure_braindump_enabled(db, 1)
    except PermissionError as exc:
        assert_true(str(exc) == "braindump_not_enabled", "disabled user should be rejected")
    else:
        raise AssertionError("disabled user was allowed")
    db.execute("UPDATE users SET braindump_enabled = 1 WHERE id = 1")
    ensure_braindump_enabled(db, 1)


def test_incremental_candidates_are_newest_first_and_not_lost_on_finalize():
    reset_sessions_for_tests()
    session = create_session(user_id=7)
    session = append_text_segment(session.id, 7, "Milch kaufen bis morgen.")
    first_titles = [candidate["title"] for candidate in session.to_dict()["candidates"]]
    assert_true(first_titles == ["Milch kaufen"], f"unexpected first candidates: {first_titles}")

    session = append_text_segment(session.id, 7, "Auto tanken außerdem Steuerunterlagen vorbereiten bis Freitag.")
    live = session.to_dict()
    live_titles = [candidate["title"] for candidate in live["candidates"]]
    assert_true(live_titles[:2] == ["Auto tanken", "Steuerunterlagen vorbereiten"], f"new candidates should be on top: {live_titles}")
    assert_true("Milch kaufen" in live_titles, "committed candidate was lost during incremental update")
    assert_true(live["last_processed_segment_id"] == 2, "final text segments should advance processed offset")

    finalized = finalize_session(session.id, 7).to_dict()
    final_titles = [candidate["title"] for candidate in finalized["candidates"]]
    assert_true(finalized["status"] == "ready", "finalized session should be ready")
    assert_true(set(final_titles) == set(live_titles), f"finalize should not drop committed candidates: {final_titles}")
    assert_true(all(candidate["status"] == "final" for candidate in finalized["candidates"]), "all candidates should be final")
    assert_true(any(event.get("type") == "tail_skipped" for event in finalized["events"]), "fully processed transcript should skip tail work")


def test_finalize_processes_only_unprocessed_tail():
    reset_sessions_for_tests()
    session = create_session(user_id=9)
    session = append_text_segment(session.id, 9, "Hund Futter bestellen.")
    # Simulate an unfinished STT tail. It must not advance last_processed_segment_id
    # during live processing, but finalize should process it without full replay.
    session = append_text_segment(session.id, 9, "Erinnere mich morgen Müll rausbringen", final=False)
    before = session.to_dict()
    assert_true(before["last_processed_segment_id"] == 1, "draft tail should remain unprocessed before finalize")

    finalized = finalize_session(session.id, 9).to_dict()
    titles = [candidate["title"] for candidate in finalized["candidates"]]
    assert_true("Hund Futter bestellen" in titles, "stable candidate missing after tail finalize")
    assert_true(any("Müll rausbringen" in title or "müll rausbringen" in title.lower() for title in titles), f"tail candidate missing: {titles}")
    assert_true(any(event.get("source") == "tail_only_finalize" and event.get("segment_ids") == [2] for event in finalized["events"]), "finalize should record tail-only segment processing")


def main():
    tests = [
        test_user_gate_defaults_to_disabled,
        test_incremental_candidates_are_newest_first_and_not_lost_on_finalize,
        test_finalize_processes_only_unprocessed_tail,
    ]
    for test in tests:
        test()
        print(f"✅ {test.__name__}")
    print(f"\nBrainDump v2 service tests passed: {len(tests)}/{len(tests)}")


if __name__ == "__main__":
    main()
