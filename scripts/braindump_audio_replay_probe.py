#!/usr/bin/env python3
"""Replay a BrainDump audio fixture as timed STT windows.

Development harness only. It answers the risky question before UI work:
Can real recorded speech produce useful transcript segments while the user is
still speaking, and does the final tail survive?
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from urllib import request
from urllib.error import URLError

BASE = Path(__file__).resolve().parents[1]
DEFAULT_WORKDIR = BASE / ".local" / "braindump-fixtures" / "replay"
DEFAULT_SERVER = "http://127.0.0.1:8766/inference"


def run(cmd: list[str]) -> tuple[float, subprocess.CompletedProcess[str]]:
    started = time.perf_counter()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    elapsed_ms = (time.perf_counter() - started) * 1000
    return elapsed_ms, proc


def ffprobe_duration(path: Path) -> float:
    _, proc = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", str(path)])
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"ffprobe failed for {path}")
    return float(proc.stdout.strip())


def convert_to_wav(input_path: Path, wav_path: Path) -> float:
    elapsed_ms, proc = run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(input_path),
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        str(wav_path),
    ])
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "ffmpeg conversion failed")
    return elapsed_ms


def slice_wav(source: Path, target: Path, start: float, duration: float) -> None:
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if start > 0:
        cmd += ["-ss", str(start)]
    cmd += ["-i", str(source), "-t", str(duration), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(target)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"failed to slice {target}")


def transcribe_server(server_url: str, wav_path: Path) -> tuple[float, str]:
    boundary = "----niaBraindumpBoundary"
    audio = wav_path.read_bytes()
    parts = []
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"temperature\"\r\n\r\n0.0\r\n".encode())
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"response-format\"\r\n\r\njson\r\n".encode())
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{wav_path.name}\"\r\nContent-Type: audio/wav\r\n\r\n".encode()
        + audio
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = request.Request(server_url, data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}, method="POST")
    started = time.perf_counter()
    try:
        with request.urlopen(req, timeout=120) as response:
            payload = response.read().decode("utf-8", errors="replace")
    except URLError as exc:
        raise RuntimeError(f"STT server request failed: {exc}") from exc
    elapsed_ms = (time.perf_counter() - started) * 1000
    try:
        text = json.loads(payload).get("text", "")
    except json.JSONDecodeError:
        text = payload
    return elapsed_ms, " ".join(text.split())


def replay(wav: Path, workdir: Path, server_url: str, mode: str, step_seconds: float) -> list[dict]:
    duration = ffprobe_duration(wav)
    results = []
    cursor = step_seconds
    index = 1
    while cursor < duration:
        if mode == "accumulated":
            start = 0.0
            slice_duration = cursor
        else:
            start = max(0.0, cursor - step_seconds)
            slice_duration = min(step_seconds, duration - start)
        target = workdir / f"{mode}-{index:02d}.wav"
        slice_wav(wav, target, start, slice_duration)
        stt_ms, text = transcribe_server(server_url, target)
        results.append({
            "index": index,
            "mode": mode,
            "audio_start_s": round(start, 3),
            "audio_end_s": round(min(start + slice_duration, duration), 3),
            "audio_duration_s": round(slice_duration, 3),
            "stt_ms": round(stt_ms, 2),
            "text": text,
        })
        cursor += step_seconds
        index += 1
    # Always include a final tail/full endpoint exactly at the recording end.
    if mode == "accumulated":
        start = 0.0
        slice_duration = duration
    else:
        start = max(0.0, duration - step_seconds)
        slice_duration = duration - start
    target = workdir / f"{mode}-{index:02d}-final.wav"
    slice_wav(wav, target, start, slice_duration)
    stt_ms, text = transcribe_server(server_url, target)
    results.append({
        "index": index,
        "mode": mode,
        "audio_start_s": round(start, 3),
        "audio_end_s": round(duration, 3),
        "audio_duration_s": round(slice_duration, 3),
        "stt_ms": round(stt_ms, 2),
        "text": text,
        "final": True,
    })
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description="Replay BrainDump fixture audio as STT windows")
    parser.add_argument("audio", type=Path)
    parser.add_argument("--server", default=DEFAULT_SERVER)
    parser.add_argument("--workdir", type=Path, default=DEFAULT_WORKDIR)
    parser.add_argument("--step-seconds", type=float, default=4.0)
    args = parser.parse_args()

    if not args.audio.exists():
        raise SystemExit(f"Input audio not found: {args.audio}")
    args.workdir.mkdir(parents=True, exist_ok=True)
    wav = args.workdir / f"{args.audio.stem}.16k-mono.wav"
    convert_ms = convert_to_wav(args.audio, wav)
    duration = ffprobe_duration(wav)
    output = {
        "input": str(args.audio),
        "wav": str(wav),
        "duration_s": round(duration, 3),
        "convert_ms": round(convert_ms, 2),
        "step_seconds": args.step_seconds,
        "server": args.server,
        "accumulated": replay(wav, args.workdir, args.server, "accumulated", args.step_seconds),
        "windowed": replay(wav, args.workdir, args.server, "windowed", args.step_seconds),
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
