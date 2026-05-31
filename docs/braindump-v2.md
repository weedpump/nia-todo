# BrainDump

BrainDump turns spoken notes into reviewed todo candidates. The user starts recording, speaks naturally, reviews the extracted candidates, optionally quick-fixes title/project/section, then creates the selected todos.

This document describes the current implemented feature. Historical experiments and superseded prototype notes live in git history.

## Current product behavior

- BrainDump is configured globally by admins and enabled per user.
- The launcher starts a voice-first capture flow immediately.
- Audio is transcribed through the configured STT provider.
- The transcript is extracted into todo candidates by the configured LLM provider.
- Candidates are shown in a preview grouped by project; candidates without a project are grouped under Inbox and shown last.
- The user can edit the candidate title, project, and section before creation.
- Only selected candidates are created; BrainDump never auto-creates todos without confirmation.
- Creation currently creates todos only. There is no user-facing candidate type selector.

## Configuration

Provider configuration lives in the admin panel and DB-backed app config. Fresh installs do not ship with a ready-made localhost/OpenClaw endpoint.

Access has two gates:

1. **Global BrainDump switch** — enables the feature for the instance.
2. **Per-user access** — controls which users may use BrainDump.

Admin-configured fields:

```text
Enabled: false by default
LLM provider: openai_compatible | ollama
LLM base URL: empty by default
LLM API key: optional, stored server-side, never echoed back
LLM model: empty by default
LLM extra headers JSON: optional
LLM timeout seconds: configurable
System prompt mode: default | append | replace
Custom system prompt/instructions: optional
STT provider: whisper_cpp_remote | local_whisper_cpp
STT URL: required for remote whisper.cpp
STT token: optional, stored server-side, never echoed back
STT language: optional/empty by default
STT timeout seconds: configurable
```

### Provider rules

- BrainDump must stay provider-neutral. OpenClaw can be used as an OpenAI-compatible endpoint, but BrainDump must not depend on OpenClaw-specific behavior.
- OpenAI-compatible and Ollama chat/instruct models should work when they can follow structured extraction instructions.
- The prompt must stay language-agnostic. UI language, prompt language, and spoken transcript language may differ.
- Do not hardcode German/English/French/etc. command words or shopping-list-specific correction rules.
- Admin secrets are write-only: empty secret fields preserve existing secrets unless the API explicitly clears them.

### Remote whisper.cpp example

```bash
/opt/whisper.cpp/bin/whisper-server \
  --host 127.0.0.1 \
  --port 8766 \
  --model /opt/whisper.cpp/models/ggml-small.bin \
  --convert \
  --inference-path /inference
```

The admin STT test sends a small multipart WAV probe to the exact configured STT URL. It intentionally does not rely on a sibling `/health` endpoint because `/health` can succeed while the configured transcription path is wrong.

## Extraction contract

BrainDump extraction uses a provider-neutral ledger/working-set contract:

- Read the transcript chronologically.
- Treat later corrections, removals, and replacements as edits to the working set, not as new candidates.
- Return only the final intended todo candidates.
- Preserve explicit dates, times, deadlines, and reminders when present.
- Use the provided workspace/project/section context as user taxonomy.
- Route candidates semantically to existing projects/sections when confident.
- If uncertain, leave project/section empty rather than hallucinating taxonomy.

The deterministic fallback is intentionally conservative. It may only fill completely empty extractions and must not re-add items that a capable LLM already removed semantically.

## Preview and quick-fix UI

- Preview candidates are grouped by project.
- Project groups are sorted by project name, with Inbox/no-project last.
- Candidates inside a group keep stable extraction order, with section-aware grouping where available.
- Candidate cards show the title prominently.
- The edit action is an icon-only action in the title row.
- Quick-fix controls cover title, project, and section.
- Project and section controls use the shared custom dropdown system from `web/static/js/ui/dropdowns.js`.
- Native browser-select styling must not be visible in the redesigned BrainDump preview.
- Subprojects in the project dropdown are rendered hierarchically with depth metadata/indentation.
- Dropdown menus must render above the BrainDump modal and avoid modal clipping.

## Todo creation

When the user confirms candidates:

- Empty titles are rejected.
- Unknown projects/sections are rejected.
- Section assignment requires a matching project.
- Created todos use the selected candidate data.
- Deselected candidates are ignored.
- User confirmation is mandatory; there is no hidden background creation.

## Security and access control

- Every BrainDump user endpoint requires normal user authentication.
- The global feature gate and per-user gate are both enforced server-side.
- Admin configuration endpoints require admin access.
- LLM/STT tokens are stored server-side and are not returned to the frontend.
- Rendered candidate/group data must use context-appropriate escaping:
  - text nodes: HTML escaping
  - attributes: attribute escaping (`escapeHtmlAttr`)
- BrainDump must use the native bridge adapter for native app integration, not direct Android/Tauri globals.

## Testing expectations

Relevant targeted checks:

```bash
python3 scripts/test_braindump_admin_stt_probe.py
python3 scripts/test_braindump_v2_extractor_normalization.py
python3 scripts/test_braindump_v2_services.py
python3 scripts/test_braindump_v2_todo_creation.py
node scripts/test_frontend_braindump_capture.mjs
node scripts/test_frontend_security.mjs
node scripts/test_frontend_ui_dropdowns.mjs
node --check web/static/js/features/braindump-live.js
node --check web/static/js/app.js
```

For release work, also run the normal frontend/backend regression gates that touch admin config, native audio, service worker precache, and changelog rendering.

## Deferred: learned routing defaults

Learned project/section defaults are intentionally not part of the current feature.

If added later, they must be:

- strictly user-specific;
- learned only after confirmed candidate creation;
- isolated across users;
- preferably stored by project/section IDs, not only names;
- resettable/disableable by the user or admin;
- conservative enough to avoid silently misrouting tasks.
