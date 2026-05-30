#!/usr/bin/env python3
"""Probe a BrainDump audio fixture through the local audio/STT path.

This is a development harness, not product code. It converts an input audio file
(e.g. Telegram OGG/Opus) to 16 kHz mono PCM WAV and transcribes it with the
local whisper.cpp CLI while measuring each step.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = Path("/opt/whisper.cpp/models/ggml-small.bin")
DEFAULT_WHISPER = Path("/usr/local/bin/whisper-cli")
DEFAULT_WORKDIR = BASE / ".local" / "braindump-fixtures"


def run(cmd: list[str]) -> tuple[float, subprocess.CompletedProcess[str]]:
    started = time.perf_counter()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    elapsed_ms = (time.perf_counter() - started) * 1000
    return elapsed_ms, proc


def ffprobe(path: Path) -> dict:
    _, proc = run([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration,size,format_name",
        "-show_streams", "-of", "json", str(path),
    ])
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"ffprobe failed for {path}")
    return json.loads(proc.stdout)


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe BrainDump audio fixture conversion + whisper.cpp STT")
    parser.add_argument("audio", type=Path, help="Input audio file, e.g. Telegram .ogg")
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--whisper", type=Path, default=DEFAULT_WHISPER)
    parser.add_argument("--language", default="de")
    parser.add_argument("--workdir", type=Path, default=DEFAULT_WORKDIR)
    args = parser.parse_args()

    if not args.audio.exists():
        raise SystemExit(f"Input audio not found: {args.audio}")
    if not args.model.exists():
        raise SystemExit(f"Whisper model not found: {args.model}")
    if not args.whisper.exists():
        raise SystemExit(f"whisper-cli not found: {args.whisper}")

    args.workdir.mkdir(parents=True, exist_ok=True)
    wav = args.workdir / f"{args.audio.stem}.16k-mono.wav"

    input_info = ffprobe(args.audio)
    convert_ms, convert = run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(args.audio),
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        str(wav),
    ])
    if convert.returncode != 0:
        raise RuntimeError(convert.stderr.strip() or "ffmpeg conversion failed")
    wav_info = ffprobe(wav)

    stt_ms, stt = run([
        str(args.whisper),
        "-m", str(args.model),
        "-f", str(wav),
        "-l", args.language,
        "-nt", "-np",
    ])
    transcript = stt.stdout.strip()
    if stt.returncode != 0:
        raise RuntimeError(stt.stderr.strip() or "whisper-cli failed")

    result = {
        "input": str(args.audio),
        "wav": str(wav),
        "input_info": input_info.get("format", {}),
        "wav_info": wav_info.get("format", {}),
        "timing_ms": {
            "convert": round(convert_ms, 2),
            "stt": round(stt_ms, 2),
            "total": round(convert_ms + stt_ms, 2),
        },
        "transcript": transcript,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
