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

## Development phases

### Phase 1: Text-session domain prototype

Goal: prove the incremental session/candidate model without audio complexity.

- Create a BrainDump session API using text segments.
- Feed text chunks as if they came from live STT.
- Generate/update candidates incrementally.
- Keep newest candidates at top in API response/UI model.
- Implement tail-only finalize.
- Add tests for segment processing, candidate stability, duplicate merging, deadline/reminder parsing, and project/section resolution hooks.

Exit criteria:

- Simulated live transcript produces stable preview candidates.
- Finalize does not reprocess the whole transcript.
- Tests prove no committed candidate is lost during finalize.

### Phase 2: Preview UI with simulated transcript

Goal: make the live UX correct before adding microphone/STT.

- Add UI state for listening/processing/finalizing/ready.
- Render candidates newest-first.
- Show draft/stable/final states clearly enough for debugging.
- Confirm selected candidates into todos.

Exit criteria:

- UI can replay a scripted transcript and show live candidate updates.
- User-confirmed creation works from candidate preview.

### Phase 3: Audio/STT integration

Goal: connect real microphone input to the already-proven session model.

- Add microphone recording and chunk/segment upload.
- Add server-side STT segment handling.
- Add silence detection / automatic stop.
- Feed STT results into the same text-session API path.

Exit criteria:

- Real speech creates the same event/candidate flow as simulated text.
- Stop finalization only processes the tail.

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

