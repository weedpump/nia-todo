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

For BrainDump v2 MVP, infrastructure may be hardcoded in backend/dev settings.

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
