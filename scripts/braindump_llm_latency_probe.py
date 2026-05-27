#!/usr/bin/env python3
"""Measure BrainDump LLM extraction latency through OpenClaw's OpenAI-compatible endpoint.

Development harness only. It reads the local Gateway bearer token from
~/.openclaw/openclaw.json when --token is omitted, but never prints it.
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path

DEFAULT_URL = "http://127.0.0.1:18789/v1/chat/completions"
DEFAULT_MODEL = "openclaw/default"
DEFAULT_BACKEND_MODEL = "gpt-5.4-mini"

PROMPT_TEMPLATE = """Du bist ein BrainDump-Extractor für nia-todo.
Extrahiere aus dem Transkript konkrete Todo-Kandidaten.
Antworte ausschließlich als kompaktes JSON-Array von Objekten mit diesen Feldern:
- title: string
- project_name: string|null
- section_name: string|null
- deadline: string|null
- reminder: string|null

Regeln:
- Nur echte Todo-Kandidaten aufnehmen.
- Wenn ein Reminder genannt wird, setze reminder.
- Wenn eine Deadline genannt wird, setze deadline.
- Keine Erklärungen, kein Markdown, nur JSON.

Transkript:
{transcript}
"""


def load_gateway_token() -> str | None:
    path = Path.home() / ".openclaw" / "openclaw.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
        return data.get("gateway", {}).get("auth", {}).get("token")
    except Exception:
        return None


def extract_content(result: dict | str) -> str:
    if not isinstance(result, dict):
        return str(result)
    try:
        return result["choices"][0]["message"]["content"]
    except Exception:
        return json.dumps(result, ensure_ascii=False)


def extract_usage(result: dict | str) -> dict | None:
    if isinstance(result, dict):
        usage = result.get("usage")
        return usage if isinstance(usage, dict) else None
    return None


def post_json(url: str, payload: dict, headers: dict[str, str]) -> tuple[float, dict | str]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", **headers}, method="POST")
    started = time.perf_counter()
    with urllib.request.urlopen(req, timeout=120) as response:
        text = response.read().decode("utf-8", errors="replace")
    elapsed_ms = (time.perf_counter() - started) * 1000
    try:
        return elapsed_ms, json.loads(text)
    except json.JSONDecodeError:
        return elapsed_ms, text


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure BrainDump LLM extraction latency via OpenClaw OpenAI-compatible API")
    parser.add_argument("transcript_file", type=Path)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--backend-model", default=DEFAULT_BACKEND_MODEL)
    parser.add_argument("--token", default=None)
    parser.add_argument("--runs", type=int, default=1)
    args = parser.parse_args()

    transcript = args.transcript_file.read_text().strip()
    prompt = PROMPT_TEMPLATE.format(transcript=transcript)
    token = args.token or load_gateway_token()
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if args.backend_model:
        headers["x-openclaw-model"] = args.backend_model

    payload = {
        "model": args.model,
        "messages": [
            {"role": "system", "content": "Du bist ein schneller, zustandsloser JSON-Extractor. Keine Tools. Keine Historie."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.0,
        "stream": False,
    }

    runs = []
    for index in range(args.runs):
        run_payload = {**payload, "user": f"braindump-latency-{int(time.time() * 1000)}-{index}"}
        elapsed_ms, result = post_json(args.url, run_payload, headers)
        content = extract_content(result)
        usage = extract_usage(result)
        parsed_json_ok = False
        try:
            json.loads(content)
            parsed_json_ok = True
        except Exception:
            pass
        runs.append({
            "elapsed_ms": round(elapsed_ms, 2),
            "parsed_json_ok": parsed_json_ok,
            "usage": usage,
            "content": content,
        })

    output = {
        "url": args.url,
        "model": args.model,
        "backend_model": args.backend_model,
        "prompt_chars": len(prompt),
        "transcript_chars": len(transcript),
        "runs": runs,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
