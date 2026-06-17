#!/usr/bin/env python3
"""End-to-end BrainDump audio fixture checks.

This test intentionally starts at a real recorded audio file, runs the local
whisper.cpp STT path, then sends the transcript through the BrainDump semantic
extractor. It is slower than unit tests and requires a local OpenClaw gateway,
but it protects the actual product risk: speech -> useful todo candidates.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from routers.braindump_v2 import _extract_with_openclaw  # noqa: E402

FIXTURE_DIR = ROOT / ".local" / "braindump-fixtures"
DEFAULT_AUDIO = FIXTURE_DIR / "fixture-002-correctness-fillers-sections.ogg"
DEFAULT_MODEL = Path("/opt/whisper.cpp/models/ggml-small.bin")
DEFAULT_WHISPER = Path("/usr/local/bin/whisper-cli")

WORKSPACE_CONTEXT = {
    "projects": [
        {"name": "Inbox", "workspace": "Privat", "is_inbox": True, "sections": []},
        {
            "name": "Einkaufsliste",
            "workspace": "Privat",
            "is_inbox": False,
            "sections": ["Obst und Gemüse", "Milchprodukte", "Tierbedarf"],
        },
        {"name": "Haushalt", "workspace": "Privat", "is_inbox": False, "sections": ["Keller", "Aufräumen"]},
    ]
}

EXPECTED = {
    "include": [
        {"title": "Milch", "project_name": "Einkaufsliste", "section_name": "Milchprodukte", "kind": "shopping"},
        {"title": "Hafermilch", "project_name": "Einkaufsliste", "section_name": "Milchprodukte", "kind": "shopping"},
        {"title": "Bananen", "project_name": "Einkaufsliste", "section_name": "Obst und Gemüse", "kind": "shopping"},
        {"title": "Snoopy Futter", "reminder_contains": "T18:00"},
        {"title": "Steuerunterlagen", "deadline_present": True},
        {"title": "Alte Kartons entsorgen", "project_name": "Haushalt", "section_name": "Keller"},
        {"title": "Werkzeugkiste aufräumen", "project_name": "Haushalt", "section_name": "Keller"},
    ],
    "exclude_title_fragments": ["Kaffee", "Ach nee", "Kaffee nicht"],
}


def run(cmd: list[str]) -> tuple[float, subprocess.CompletedProcess[str]]:
    started = time.perf_counter()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    elapsed_ms = (time.perf_counter() - started) * 1000
    return elapsed_ms, proc


def normalize(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def convert_audio_to_wav(audio: Path, wav: Path) -> float:
    elapsed_ms, proc = run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(audio),
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        str(wav),
    ])
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "ffmpeg conversion failed")
    return elapsed_ms


def transcribe(wav: Path, model: Path = DEFAULT_MODEL) -> tuple[float, str]:
    elapsed_ms, proc = run([
        str(DEFAULT_WHISPER),
        "-m", str(model),
        "-f", str(wav),
        "-l", "de",
        "-nt", "-np",
    ])
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "whisper-cli failed")
    return elapsed_ms, " ".join(proc.stdout.split())


def candidate_matches(candidate: dict, expected: dict) -> bool:
    title = normalize(candidate.get("title"))
    if normalize(expected["title"]) not in title:
        return False
    for key in ("project_name", "section_name", "kind"):
        if key in expected and normalize(candidate.get(key)) != normalize(expected[key]):
            return False
    if expected.get("deadline_present") and not candidate.get("deadline"):
        return False
    if expected.get("reminder_contains") and expected["reminder_contains"] not in str(candidate.get("reminder") or ""):
        return False
    return True


def assert_expected(candidates: list[dict]) -> list[str]:
    failures: list[str] = []
    titles = "\n".join(str(candidate.get("title") or "") for candidate in candidates)
    for fragment in EXPECTED["exclude_title_fragments"]:
        if normalize(fragment) in normalize(titles):
            failures.append(f"rejected title fragment present: {fragment}")
    for expected in EXPECTED["include"]:
        if not any(candidate_matches(candidate, expected) for candidate in candidates):
            failures.append(f"missing expected candidate: {expected}")
    return failures


def main() -> int:
    audio = DEFAULT_AUDIO
    if not audio.exists():
        raise SystemExit(f"Audio fixture missing: {audio}")
    if not DEFAULT_MODEL.exists():
        raise SystemExit(f"Whisper model missing: {DEFAULT_MODEL}")
    if not DEFAULT_WHISPER.exists():
        raise SystemExit(f"whisper-cli missing: {DEFAULT_WHISPER}")

    with tempfile.TemporaryDirectory(prefix="braindump-audio-e2e-") as tmp:
        wav = Path(tmp) / "fixture.wav"
        convert_ms = convert_audio_to_wav(audio, wav)
        stt_ms, transcript = transcribe(wav)

    llm_ms, parsed, usage, _ = _extract_with_openclaw(
        transcript,
        segment_id=30_000,
        workspace_context=WORKSPACE_CONTEXT,
    )
    candidates = parsed.get("candidates") or []
    failures = assert_expected(candidates)

    print(json.dumps({
        "fixture": str(audio),
        "timing_ms": {"convert": round(convert_ms, 2), "stt": round(stt_ms, 2), "llm": round(llm_ms, 2)},
        "transcript": transcript,
        "candidates": candidates,
        "usage": usage,
        "failures": failures,
    }, ensure_ascii=False, indent=2))

    if failures:
        print(f"\nBrainDump audio fixture E2E: FAIL ({len(failures)} issue(s))")
        return 1
    print("\nBrainDump audio fixture E2E: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
