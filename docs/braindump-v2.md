# BrainDump v2

## Purpose

BrainDump lets a user open nia-todo, press a microphone button, speak naturally, and see todo candidates appear live while speaking. When the user stops speaking, the preview should already be mostly complete; only the final spoken tail should need a short finish step.

This document is the project memory for the implementation. Keep it concise and update it when a decision, experiment, or failure changes the direction.

## Target user experience

- User opens the app and presses a microphone button.
- Recording starts immediately and clearly signals `listening`.
- While the user speaks, todo candidates appear in a preview.
- Newest candidates appear at the top; older candidates move down.
- After a few seconds of silence, listening stops automatically and the UI signals completion/finalization.
- After stop, the remaining processing should take about 1-3 seconds, not 10-15 seconds.
- User can review candidates and add all or selected candidates.
- BrainDump must be explicitly enabled per user by an admin before the user can access it.
- Candidates should be assigned to a sensible project.
- If project sections exist, candidates should be assigned to sensible sections where possible.
- Deadlines and reminders should be detected from natural language:
  - `I need to finish X by Friday` -> deadline
  - `remind me tomorrow to do X` -> reminder

## Non-goals for the first stable iteration

- No production/live data mutation during development.
- No large final LLM pass over the complete transcript after stop.
- No hidden auto-create of todos without user confirmation.
- No fragile live draft system that can lose already spoken content.
- No performance optimization without measuring the current bottleneck.
- No admin UI for BrainDump provider configuration yet.
- No user-facing OpenClaw/Whisper/STT model configuration yet.
- No token/provider management until the core BrainDump flow is proven.
- No full admin UI for per-user BrainDump enablement in Phase 1; keep the permission requirement in the domain/API design.

## MVP configuration rule

For BrainDump v2 MVP, provider configuration lives in backend environment variables, not in a polished admin UI yet.

Current split:

- LLM: OpenClaw via `NIA_TODO_OPENCLAW_URL` later; current dev default still points at the local OpenClaw Gateway chat endpoint.
- STT: remote `whisper.cpp` server by default.

STT environment variables:

```env
NIA_TODO_STT_PROVIDER=whisper_cpp_remote
NIA_TODO_STT_URL=http://127.0.0.1:8766/inference
NIA_TODO_STT_LANGUAGE=de
NIA_TODO_STT_TOKEN=
NIA_TODO_STT_TIMEOUT_SECONDS=60
```

Recommended whisper.cpp server command for development:

```bash
/opt/whisper.cpp/bin/whisper-server \
  --host 127.0.0.1 \
  --port 8766 \
  --model /opt/whisper.cpp/models/ggml-small.bin \
  --language de \
  --convert \
  --inference-path /inference
```

Reason: if the core session pipeline does not work reliably, a polished configuration UI has no value and only adds complexity. Provider/admin configuration can be added after the flow is correct, fast enough, and testable.

## Core architecture rule

BrainDump v2 is a session pipeline, not a single request.

```text
microphone audio
  -> streaming/segmented STT
  -> incremental transcript segments
  -> incremental todo extraction
  -> live preview candidates
  -> stop/silence detection
  -> tail-only finalize/reconcile
  -> user-confirmed todo creation
```

### Critical latency rule

After stop, the system must not reprocess the full transcript with an expensive LLM call.

Instead:

- Process transcript incrementally while the user is speaking.
- Keep track of the last stable processed offset/segment.
- Treat already stable candidates as committed preview state.
- On stop, process only the open tail: usually the last unfinished 1-2 sentences plus minimal context.
- Run only a small reconcile step to finalize drafts, merge duplicates, and mark the session complete.

## Session state model

The implementation should explicitly model session state instead of deriving everything from raw audio each time.

Suggested concepts:

- `session_id`
- `status`: `idle | listening | processing | finalizing | ready | failed`
- `transcript_segments`
- `last_processed_segment_id` or `last_processed_offset`
- `committed_candidates`: stable items shown in preview
- `draft_candidates`: items that may still be updated by the next segment/tail
- `open_tail`: latest incomplete phrase/sentence context
- `events`: append-only updates for UI preview/debugging

## Candidate model

Todo candidates should be structured before UI rendering.

Suggested fields:

- `client_id` / `candidate_id`
- `title`
- `notes`
- `project_id` / `project_name`
- `section_id` / `section_name`
- `deadline`
- `reminder`
- `confidence`
- `status`: `draft | stable | final`
- `source_segment_ids`
- `warnings` / `needs_review`


## Test protocol

Tobi should not be the live trial-and-error tester during core development.

For audio/STT work, use controlled fixture recordings:

1. Nia writes a short test script that Tobi should speak exactly enough for realistic speech.
2. Tobi sends the spoken recording as Telegram audio.
3. Nia uses that same audio as a repeatable fixture whenever possible.
4. Expected transcript, expected todo candidates, expected deadlines/reminders, and expected project/section targets are known before the test.
5. Each run measures:
   - audio duration
   - audio ingest/transport latency
   - first transcript segment latency
   - incremental segment timing
   - stop/final-tail latency
   - final candidate correctness
   - whether late spoken words were lost
6. Tobi only tests manually at the end when the UI/UX needs human review.

If Telegram/OpenClaw does not expose the raw audio file to the agent runtime, use an explicit uploaded audio fixture/file path instead of relying on the transcript. Transcript-only input is not a valid BrainDump audio/STT test.



## Live response rule

The LLM must behave like a live co-author, not a post-hoc summarizer.

That means:

- As soon as a stable transcript chunk exists, the LLM should already start producing candidate output from that chunk.
- By the time the user stops, almost all candidate reasoning should already be done.
- Stop should only need a tiny tail correction / merge pass.
- If the LLM waits for the end, the design is wrong.

## Latency target

The 4-second budget is **not** 4 seconds total from recording start.

It means:

- The pipeline may stay up to about 4 seconds behind the live recording during speaking.
- At stop, only the remaining ~4 seconds of unfinished work may remain.
- Therefore the user experiences: start speaking -> work begins immediately -> preview stays at most ~4 seconds behind -> stop -> final result appears within up to 4 seconds.

Practical interpretation:

- If the recording has reached second 18, at least roughly seconds 1-14 should already be processed.
- If the recording has reached second 30 and the user stops, only roughly the last 4 seconds may remain to finalize.
- The pipeline must continuously drain while recording is ongoing.

This means the design goal is a **sliding processing window**, not a single post-stop batch job.

## Development phases

### Phase 1: Audio/STT feasibility spike

Goal: prove the actually risky part first: microphone audio -> reliable incremental STT -> stable segment stream.

Text-only input is not enough evidence. Clean typed text will always look good and does not validate the hard problem.

- Build the smallest possible microphone/STT path.
- Capture real browser audio in the same format the final app will use.
- Stream or upload audio in a way that produces usable partial/final transcript segments.
- Measure latency for audio capture, transport, STT segment availability, and final tail flush.
- Prove that late words are not lost on stop/silence.
- Keep the existing text-session domain only as a state/candidate scaffold, not as proof that BrainDump works.

Exit criteria:

- Real speech produces transcript segments while speaking.
- Stop/silence flush includes the final spoken words.
- Segment latency is low enough that todo extraction can plausibly keep up live.
- We understand exactly which audio/STT approach works and which one fails.

### Phase 2: Session/candidate pipeline on real STT segments

Goal: feed proven STT segments into the BrainDump session model.

- Convert STT partial/final events into session transcript segments.
- Generate/update live candidate preview from real transcribed speech.
- Keep newest candidates at top in API response/UI model.
- Implement tail-only finalize.
- Add tests for no lost committed candidates and no full transcript reprocessing.

Exit criteria:

- Real speech creates stable preview candidates while speaking.
- Finalize processes only the tail.
- Last spoken todos are not lost.

### Phase 3: Preview UI on real audio flow

Goal: make the live UX correct with the proven audio/STT path.

- Add UI state for listening/processing/finalizing/ready.
- Render candidates newest-first.
- Show draft/stable/final states clearly enough for debugging.
- Confirm selected candidates into todos.

Exit criteria:

- UI shows live candidate updates from real speech.
- User-confirmed creation works from candidate preview.

### Phase 4: Project, section, deadline, reminder resolution

Goal: make assignment useful and testable.

- Provide project/section context to the resolver.
- Resolve natural-language project/section references.
- Resolve deadlines vs reminders separately.
- Mark uncertain assignments as `needs_review` instead of hallucinating certainty.

Exit criteria:

- Realistic fixtures resolve correctly.
- Ambiguous inputs remain reviewable, not silently wrong.

### Phase 5: Performance hardening

Goal: meet the UX latency target without sacrificing correctness.

- Measure STT latency, extraction latency, finalization latency separately.
- Optimize the actual bottleneck only.
- Keep correctness tests green while optimizing.

Exit criteria:

- Most candidates appear while speaking.
- Stop-to-ready target is about 1-3 seconds for normal BrainDump length.

## Experiment / decision log

Keep entries short. Add only meaningful changes, failures, and lessons.

### 2026-05-27: Fresh restart after v1 was discarded

Decision:

- Start fresh on a new feature branch.
- Use a documented phase plan before coding.
- Build text/session domain first, audio later.
- Do not implement a full final transcript LLM pass because observed latency was around 15 seconds and violates the UX target.

Reason:

- Previous attempts became chaotic because live drafts, final reprocessing, and audio/STT complexity were mixed too early.
- The new plan separates domain state, UI behavior, STT integration, and performance.

What was good from the previous attempt:

- Overall user value and flow are clear.
- Admin/user gating and provider configuration were conceptually useful.
- Audio -> STT -> analysis -> candidate preview was proven possible.

What did not work:

- Reprocessing the full transcript after stop was too slow.
- Naive chunk/live draft handling could lose or corrupt content.
- Optimizing before the session model was stable made the system worse instead of better.

Current rule:

- Correct incremental state first. Tail-only finalize. Measure before optimizing.

### 2026-05-27: MVP config is intentionally hardcoded

Decision:

- Do not build admin/provider configuration UI in the first v2 implementation.
- Hardcode OpenClaw/STT/Whisper settings in backend/dev configuration for now.

Reason:

- The hard problem is the live BrainDump session pipeline.
- Configuration UI is only useful after the core flow is proven reliable and fast enough.
- Avoid spending time on surface area that may be thrown away if the architecture changes.

### 2026-05-27: BrainDump requires per-user admin enablement

Decision:

- BrainDump must not become available to every user automatically.
- The domain/API should include a per-user allow gate from the beginning.
- The polished admin UI for managing this can wait until the core flow works.

Reason:

- BrainDump may consume host-side STT/LLM resources and should be explicitly enabled by an admin.
- Keeping the permission boundary in the domain avoids adding it awkwardly later.

### 2026-05-27: Pivot Phase 1 to real audio/STT first

Decision:

- Do not treat text-only BrainDump as proof of the feature.
- Move real microphone/audio/STT feasibility to Phase 1.
- Keep the current text-session service only as a useful session-state scaffold.

Reason:

- The old failure was not typed text -> structured candidates.
- The actual hard problem was browser audio, chunks/streaming, transcription latency, tail flushing, and not losing late spoken words.
- Starting with clean typed text risks validating the easy path while missing the broken path.

What changes now:

- Next implementation work should focus on a minimal real audio/STT spike with measurements before polishing candidate extraction or UI behavior.

### 2026-05-27: Controlled audio fixtures instead of live user testing

Decision:

- Tobi should not repeatedly test broken live builds.
- Nia will provide fixed scripts for Tobi to record as audio fixtures.
- Development tests should replay those recordings and compare measured output against known expected todos/timing.
- Manual Tobi testing is reserved for late UI/UX validation.

Reason:

- Repeated manual live testing caused frustration and produced noisy evidence.
- Controlled audio fixtures make failures reproducible and measurable.
- Transcript-only testing remains invalid for the core audio/STT problem.


### 2026-05-27: Controlled audio fixture 001 baseline

Fixture:

- Source: Telegram OGG from Tobi's scripted recording.
- Duration: about 16.12s.
- Expected todos: milk/coffee shopping, Snoopy food reminder 18:00, tax documents by Friday, clean cellar, dispose old boxes.

Results:

- OGG -> 16 kHz mono WAV conversion: about 89ms.
- Full-file whisper.cpp small STT: about 6.49s; transcript was correct.
- whisper-server full-file STT: about 7.07s in one run; correct transcript.
- Accumulated replay every 4s produced correct text but each STT call took about 4.0-4.9s.
- Windowed 4s replay produced useful segments with about 4.1-4.6s STT latency per window.
- Final 4s tail was recognized correctly, but took about 4.6s, which misses the desired 1-3s stop-to-ready target.

Conclusion:

- Raw Telegram OGG fixtures are usable.
- Conversion is not the bottleneck.
- Local whisper.cpp small is accurate enough for this fixture, but too slow for the target UX if every 4s window takes about 4s STT.
- Next work should test a faster STT path/model or true streaming/VAD before building UI polish.
### 2026-05-27: 4-second target is a sliding lag, not total runtime

Decision:

- The user clarified the 4-second limit applies to the remaining lag after stop, not to the full recording runtime.
- The pipeline must run continuously while the user speaks, always staying roughly within a small lag budget behind the live audio.
- Stop is only the final drain of the already-in-flight pipeline.

Reason:

- A 30-second recording can reasonably finish at about 34 seconds total if the system has already processed most of the audio during capture.
- The hard requirement is that the system must not wait until stop to start work.
### 2026-05-27: LLM must work live, not at the end

Decision:

- The LLM is not allowed to wait until stop to start reasoning.
- Candidate generation must happen incrementally while audio is still coming in.
- Stop only finishes the remaining tail and merges already-produced candidates.

Reason:

- Tobi wants a live co-author behavior: speak, and the assistant is already working/answering as the sentence unfolds.
- A post-stop-only LLM would violate the intended UX even if it stayed under 4s.


### 2026-05-27: Current OpenClaw default-agent LLM latency baseline

Fixture:

- Same controlled fixture 001 transcript, 248 transcript chars.
- Probe path: OpenClaw OpenAI-compatible `POST /v1/chat/completions` on gateway port 18789.
- Agent target: `openclaw/default`.
- Backend override: `gpt-5.4-mini`.

Results:

- Prompt text in probe: 761 chars.
- Actual reported prompt tokens: about 16,757 tokens per run because the default `main` agent injects its normal context/bootstrap.
- LLM extraction runs: about 4.93s, 5.12s, 7.58s in the cleaned stateless probe; an earlier repeated-session run also produced a 14.2s outlier.
- JSON output was valid and mostly correct, but this path is too heavy for BrainDump's live budget.

Conclusion:

- Measuring through `openclaw/default` is useful as a negative baseline only.
- The real BrainDump architecture needs a dedicated OpenClaw agent/profile with:
  - `model`: `openai-codex/gpt-5.4-mini` / alias `gpt-mini` equivalent,
  - no tools,
  - no history,
  - no workspace bootstrap/context injection,
  - fixed tiny system prompt for JSON extraction only.
- Without that dedicated lightweight agent, the LLM budget is dominated by unrelated main-agent context and is not representative.

### 2026-05-27: Dedicated `openclaw/braindump` agent measurement

Configured a dedicated OpenClaw-compatible agent target:

- `openclaw/braindump`
- backend model: `openai-codex/gpt-5.4-mini`
- no skills
- minimal tool profile
- separate tiny workspace under `.local/braindump-agent-workspace`
- fixed JSON extraction system prompt

Prompt-token impact:

- `openclaw/default`: about 16,757 prompt tokens for fixture 001 because the normal main-agent context is injected.
- Initial `openclaw/braindump` using the normal Nia workspace: about 5,985 prompt tokens.
- `openclaw/braindump` with separate minimal workspace/tool profile: about 962 prompt tokens for the full fixture transcript, about 837-846 prompt tokens per 4s window.

Full transcript extraction, fixture 001:

- 5 repeated runs with the minimal BrainDump agent: 4.72s, 4.84s, 5.06s, 9.33s, 10.60s.
- Prompt tokens: 962.
- Completion tokens: about 200.
- Output JSON was valid and semantically correct.

4s window extraction, fixture 001:

- Window 1: STT 4.10s + LLM 3.62s.
- Window 2: STT 4.24s + LLM 5.46s.
- Window 3: STT 4.10s + LLM 3.47s.
- Window 4: STT 4.24s + LLM 3.78s.
- Final tail window: STT 4.61s + LLM 3.55s.

Budget conclusion:

- The dedicated OpenClaw agent fixes the context/token problem enough for representative measurement.
- The current STT+LLM serial window budget is still too slow for the target: final stop-to-ready is roughly 8s on fixture 001 even with the lightweight agent.
- The biggest bottleneck remains the current whisper.cpp small 4s-window path, because STT alone is already around or above the entire 4s tail budget.
- Next experiment should test faster STT settings/model or true incremental/VAD strategy before investing further in UI polish.

### 2026-05-27: Faster STT model experiment

Downloaded real whisper.cpp `tiny` and `base` GGML models for controlled local benchmarking. The existing `for-tests-*` files under `/opt/whisper.cpp/models` are tiny placeholder/test files and not usable for BrainDump quality tests.

CLI benchmark on fixture 001, 4s windows, `-t 4 -mc 0`:

- `tiny` default: avg ~0.72s, max ~0.74s, but too inaccurate (`Snoopy` badly mangled, phrase errors).
- `tiny` greedy/no-fallback: avg ~0.59s, max ~0.60s, still too inaccurate.
- `base` default: avg ~1.48s, max ~1.63s, mostly usable but minor name errors (`Slubi`).
- `base` greedy/no-fallback: avg ~1.34s, max ~1.38s, best speed/quality compromise in this run (`Snoopie`, otherwise usable).
- `small` default: avg ~5.25s, max ~5.42s.
- `small` greedy/no-fallback: avg ~4.81s, max ~4.97s.

2s window notes:

- `base` greedy/no-fallback: avg ~1.22s, max ~1.29s, but short windows fragment context and produce partial/error-prone text (`Ich muss mal`, `Herr Rinnere...`).
- `tiny` is fast enough but too inaccurate for trusted todo extraction.

Server benchmark notes:

- Current `whisper-server` with `small` remains around ~4.3-4.7s for 2s-4s windowed calls once measured sequentially.
- Parallel probe calls against the same server caused contention and invalid inflated timings; future harnesses should serialize STT benchmarks or run isolated server instances.

LLM compact-output experiment:

- Shortened `openclaw/braindump` prompt reduced a smoke call to ~751 prompt tokens / 28 completion tokens and ~3.5s latency.
- A subsequent multi-window LLM run hit an OpenClaw/gpt-mini timeout on the second window, so compact LLM latency remains variable and cannot yet be treated as consistently under budget.

Budget conclusion:

- Best current candidate: `base` + greedy/no-fallback + 4s-ish stable windows, with live LLM running in parallel on stable chunks.
- Final tail with `base` STT (~1.3-1.6s) plus a good compact LLM call (~3.5s typical) is close to the 4s target but not reliably below it yet.
- For MVP, prefer `base` over `small`; keep `small` only as accuracy fallback or final correction if needed.

### 2026-05-27: `small` retest after 8 CPUs visible

The LXC now exposes 8 logical CPUs (`nproc=8`, cpuset `0-7`) on an i5-1135G7 host (4 physical cores / 8 threads). Retested `ggml-small.bin` on fixture 001, 4s windows via `whisper-cli`.

Results:

- `small`, `-t 4` default: avg ~4.15s, max ~4.26s.
- `small`, `-t 4 -bo 1 -bs 1 -nf`: avg ~3.86s, max ~4.21s.
- `small`, `-t 6` default: avg ~4.46s, max ~4.52s.
- `small`, `-t 6 -bo 1 -bs 1 -nf`: avg ~4.15s, max ~4.20s.
- `small`, `-t 8` default: avg ~4.81s, max ~5.17s.
- `small`, `-t 8 -bo 1 -bs 1 -nf`: avg ~4.22s, max ~4.34s.

Conclusion:

- Giving the LXC 8 logical CPUs helps compared with the earlier worse constrained/contended runs, but `small` still does not scale well past 4 threads on this host.
- Best `small` setting observed is still 4 threads + greedy/no-fallback, around ~3.9s average, with a >4s final-window worst case.
- `small` remains marginal for the full live pipeline because LLM still needs time. Keep `base` for live STT and use `small` only as optional final/accuracy correction.

### 2026-05-27: Real-time stop-to-JSON replay measurement

Ran a stricter fixture replay test matching the UX question:

1. Start replaying controlled audio fixture 001 in real time.
2. At each stable 4s boundary, start STT while the audio continues.
3. Start LLM extraction as soon as that window's STT text is available.
4. When the recording ends, measure how long until the aggregate JSON is available.

Harness details:

- Audio duration: 16.113s.
- Windows: 0-4s, 4-8s, 8-12s, 12-16s.
- Sub-second leftover tail (0.113s) intentionally ignored; processing it caused Whisper hallucination (`* Musik *`) and is not a valid BrainDump tail strategy.
- STT worker: serial, one window at a time.
- LLM workers tested with 2 and 4 parallel calls against `openclaw/braindump`.

Results:

- `base`, 4 threads, greedy/no-fallback, 2 LLM workers:
  - JSON ready at 21.823s from play start.
  - Stop-to-JSON from actual audio end: about 5.71s.
  - STT per window: about 1.0-1.1s.
  - LLM per window: 3.5-7.8s.
  - JSON available, but quality still imperfect (`Snoopie`; one incomplete-candidate artifact in a middle fragment).
- `base`, 4 threads, greedy/no-fallback, 4 LLM workers:
  - JSON ready at 23.855s from play start.
  - Stop-to-JSON from actual audio end: about 7.74s.
  - Worse because one LLM call took 14.65s; more parallelism is not automatically better.
- `small`, 4 threads, greedy/no-fallback, 2 LLM workers:
  - JSON ready at 23.993s from play start.
  - Stop-to-JSON from actual audio end: about 7.88s.
  - STT per window: about 3.7-4.1s.
  - JSON quality better than `base` for this fixture (`Snoopy` correct), but latency worse.

Conclusion:

- Yes, the pipeline can run STT/LLM while recording is ongoing, but current OpenClaw LLM latency dominates enough that the measured wait after stop is still above the 4s target.
- Best measured end-to-JSON path so far: `base` + 4s windows + 2 LLM workers, about 5.7s after stop.
- `small` is more accurate but about 7.9s after stop in the same real-time test.
- More LLM parallelism (4 workers) caused worse tail latency due to an outlier; keep LLM concurrency low unless a provider/path with predictable latency is used.

### 2026-05-27: Semantic BrainDump v2 current state before pausing

Status at pause:

- Branch: `feature/braindump-v2`.
- Dev project path: `~/projects/nia-todo-dev`.
- Latest pushed feature commits:
  - `a6096a7 Make BrainDump extractor language neutral`
  - `c6b753c Clarify BrainDump semantic extractor prompt`
  - `333f851 Add context-aware BrainDump semantic extraction`
  - `e8b8b50 Filter BrainDump filler-only candidates`
  - `75ccdc2 Normalize BrainDump reminders and dedupe items`

What works now:

- BrainDump v2 is behind the per-user `users.braindump_enabled` gate.
- Browser live-debug flow records microphone audio and sends accumulated audio snapshots to the backend.
- Backend live path uses `ffmpeg -> whisper-cli -> OpenClaw JSON extraction`.
- Whisper language is now `auto`, not hardcoded German.
- BrainDump uses `openclaw/braindump` and currently tests with full `gpt-5.4` instead of mini per Tobi's request.
- The product BrainDump prompt is now sent directly with every extraction; it no longer relies only on the stale/tiny OpenClaw agent prompt.
- The extractor receives workspace context: existing projects, workspaces and sections.
- Project/section mapping is context-aware: the LLM may choose only exact existing `project_name` / `section_name` values when clearly appropriate.
- There is no hardcoded `Einkaufsliste` routing. `kind="shopping"` is only an internal semantic signal.
- Shopping/grocery lists, homework, stamp-collection examples and Spanish examples passed live semantic checks.
- Filler-only candidates like `nee`, `nein`, `doch`, `okay`, `ähm` are filtered.
- Duplicate candidates from LLM output plus deterministic safety-net are deduped.
- Natural-language reminder/deadline text like `übermorgenabend` is normalized to an ISO datetime such as `2026-05-29T19:00+02:00`; unparseable reminder text is dropped instead of being written into date fields.

Tests/checks that passed before pausing:

- `python3 scripts/test_braindump_v2_services.py`
- `python3 scripts/test_braindump_v2_extractor_normalization.py`
- `python3 scripts/test_braindump_semantic_extractor.py` -> 4/4 live OpenClaw checks
- `node --check web/static/js/features/braindump-live-debug.js`
- `node scripts/test_sw_precache.mjs`
- `nia-todo-dev` was restarted and active on the feature branch before switching back to `develop`.

Important product decisions:

- Normal users/self-hosters should not have to write prompts.
- The default product BrainDump prompt/context path is the normal UX.
- Optional OpenClaw/STT/system-prompt configuration can exist later as an advanced fallback/pro mode, not as the default requirement.
- BrainDump must behave like a semantic assistant, not dictation.
- The app should provide real context (projects/sections/workspaces); the LLM should infer the sensible mapping from that context.
- Users should not need to dictate shopping-list sections. For example, saying "Milch, Hafermilch und Bananen" should be enough for BrainDump to place dairy items into a dairy section and fruit into a fruit/produce section when those sections exist.
- Explicit section hints from the user may override/confirm routing, but they are not required for the intended UX.

Known limitations / next work:

- The current live debug path still uses accumulated audio snapshots; this is robust for browser/WebM decoding but inefficient.
- Need replace/debug toward a true efficient live pipeline once semantics are stable.
- Need wire final candidates into real todo creation with `project_id` / `section_id` mapping instead of only debug JSON display.
- Need ensure ISO reminder/deadline parsing is robust across more languages and ambiguous phrases; current parser covers common German/English/Spanish/French relative terms but is still MVP-level.
- Need decide whether `kind="shopping"` should remain as an internal value exposed to frontend or be transformed into a more general `intent`/`category` field before release.
- Need rerun real mobile live test after resuming and inspect logs for STT/LLM timing, duplicates, tail handling and candidate correctness.
- Need consider switching BrainDump agent back from full `gpt-5.4` to `gpt-5.4-mini` after prompt/context fixes, because GPT Mini should likely handle this now.

Resume plan:

1. Start from `feature/braindump-v2`.
2. Re-run the deterministic and live semantic tests above.
3. Do one controlled real UI test with grocery + negation + reminder + section mapping.
4. Inspect backend logs/timing rather than guessing from screenshots.
5. If semantics stay good, implement candidate confirmation into real todos and project/section id resolution.
6. Only then optimize the live audio pipeline and final stop-to-ready latency.
