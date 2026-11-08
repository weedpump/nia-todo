# Architecture

## Stack

- FastAPI
- SQLite
- Vanilla JS Frontend
- Offline-PWA

## Areas

- `api/` -> backend and data access
- `web/` -> UI, Service Worker, manifest
- `scripts/` -> tests and helpers
- `systemd/` -> services for live/dev

## Data Model

- Each user has their own inbox (`projects.is_inbox = 1`), regardless of the project name
- Project names are unique per user, not globally
- Shared projects are managed via `project_members` (`pending`, `accepted`, `removed`, `left`, `declined`)
- V4 households are separate from personal workspaces: each household has exactly one human owner plus zero or more accepted members; there is no household admin role
- A user can have at most one pending or accepted household relationship. Joining happens through an invitation that the recipient accepts or declines
- Shareable top-level entities are registered in `entity_access` with exactly one owner type: either `owner_user_id` for personal ownership or `owner_household_id` for household ownership
- Household participants may create household entities. Moving a personal entity into a household is an ownership transfer, not an additional share; household-owned data therefore survives an individual member leaving or being removed
- Effective content access is additive: personal ownership, household participation, generic `entity_access_grants`, and compatible legacy project membership may independently grant access
- Household members and direct recipients may read and edit entity content. Only the personal owner or household owner may manage metadata, access grants, archiving, deletion, and ownership transfers
- Top-level entities own their access boundary. Child records such as todos, shopping items, sections, recipes, ingredients, and steps inherit access from their container rather than receiving independent grants
- Transferring or deleting a nested project runs subtree enumeration and validation under a SQLite writer transaction. Transfer detaches the transferred subtree root from its former personal ancestor before changing ownership; deletion retains the lock through todo rehoming and subtree removal. Project creation and reparenting use the same writer serialization, so concurrent child creation cannot split an ownership boundary or survive a completed subtree deletion, and existing ancestor grants cannot cross into a transferred household subtree. Default-workspace creation remains inside the caller's transaction and never releases that lock
- Household invitation, membership, ownership-transfer, and dissolution transitions acquire the SQLite writer lock before validation and retain it through commit, so concurrent lifecycle changes cannot both succeed against stale membership state
- Workspaces remain personal organization views and are not household-owned entities
- Module activation is stored once per user account in `users.disabled_modules_json`; workspace records and workspace APIs carry no module visibility state. Disabling a module hides its shell navigation and settings contribution without deleting domain data, and at least one registered module must remain enabled
- Registered modules declare only the shell capabilities they actually support. `capabilities.workspaces` controls whether the personal workspace switcher is visible for the active module; tasks enable it, while shopping and recipes initially do not
- Household-owned entities always project into each viewer's personal default workspace. They cannot be moved into another personal workspace, so household ownership does not require a generic per-user entity/workspace assignment layer
- Account module preferences are included in `/api/me`, direct preference update events, and recipient-specific reconnect snapshots so every device converges on the same enabled module set
- Existing task-project shares remain stored in `project_members`, but project authorization now resolves both that legacy source and the common household/entity contract. Shopping lists and cookbooks use the common contract directly
- A household owner may dissolve the household explicitly. Household-owned entities transfer to that human owner's personal ownership in the same transaction; former household access is revoked while independent direct grants and project memberships remain additive
- Attachment uploads and deletions use persistent quarantine records across the database commit boundary. A raised `commit()` is treated as an ambiguous outcome: staged data is preserved for database-driven startup reconciliation rather than being guessed as committed or rolled back
- Attachment deletion acquires the SQLite writer lock before deriving or staging the deletion set; concurrent uploads wait, then revalidate the still-existing todo after obtaining that same lock
- Startup attachment reconciliation acquires the same SQLite writer lock before inspecting manifests, so it cannot restore or finalize a batch whose database transaction is still in flight in another process
- Upload request temp files hold a cross-process advisory lease from before streaming until durable staging. Lease acquisition and cleanup validate that the locked descriptor still matches the visible lock-path inode, retrying or skipping after concurrent unlink/replacement; reconciliation skips leased files and removes only abandoned, unlocked upload temps
- Attachment metadata that references a missing expected file or todo attachment directory is an observable integrity error; lifecycle deletion does not silently erase the metadata
- Recipient-specific full snapshots include pending household and project invitations. Invite creation, response, removal, project/workspace deletion, and household dissolution synchronize every affected pending or accepted participant; pending invitees receive only their private snapshot and never project lifecycle payloads
- Every authenticated WebSocket connection and reconnect requests a recipient-specific full snapshot. A snapshot arriving while either the queue flag or any tracked sync/refresh operation remains unsettled is discarded as potentially stale and replaced only after recovery, refresh, and follow-up work settle; it is never applied late or replaced with a narrower REST refresh
- The shipped WebSocket client applies household and invitation snapshots to its live access state and persists owner-visible project membership rosters with the project snapshot
- Full todo snapshots include recipient-visible reminders and location data plus complete subtask, comment, and attachment metadata with authoritative counts
- Legacy reminders with `user_id = NULL` belong to the effective personal or household owner. Shared editors may update their own default reminders but cannot replace or delete the owner's legacy reminder when changing todo due dates

## Sync

- local changes go into a sync queue
- WebSocket/sync keeps local data and server state in sync
- server refresh writes the authoritative state directly into IndexedDB so reloads after login stay stable
- Shopping replay preserves each list's mutation order after a failure or uncommitted replay; other lists continue independently. Empty idempotent batches update local state without creating an empty queue entry.
- Tasks keeps known local project/section IDs opaque until their parent creates commit. One receipt transaction remaps dependent cache and queue references and removes the acknowledged parent write before sending children; unresolved parent IDs defer dependent writes. Committed ID receipts keep navigation and open editors on their original target.
- Complete account-wide WebSocket snapshots drive durable project-access eviction, including pending local edits. Workspace projections do not imply revocation. The locked eviction reads the latest authorized projects and server-confirmed entity IDs so newer grants, independent child access and authoritative moves remain protected.
- Account transitions suspend and drain shared access-privacy work and realtime/sync before closing IndexedDB. Old invitations, access projections and in-memory records are reset; privacy processing resumes only after the database is open. A different account's cached or authoritative identity must not hydrate module UI before this boundary completes.
- Complete Shopping list/store snapshots reconcile old store-only queue records before replacing caches: authorized store metadata backfills the list identity, while unassignable orphan records are removed atomically. Partial snapshots do not infer revocation from missing store metadata.
- Background refreshes preserve unchanged module menus and Shopping filter/editor controls, including focus and drafts. Shopping reconciles filter/header inputs separately from item/section content; changing targets, permissions or module activation closes obsolete controls. Late inline-store completions stay scoped to their original list and cannot clear a newer draft.

## Cookbooks and Recipes

- Recipes implements cookbook containers, recipe aggregates and ingredient transfer to Shopping. Cookbooks use the shared entity sidebar/editor. Recipes have a title, description, base servings, preparation/cooking times, manual tags, ordered ingredient groups and ordered plain-text steps. Public discovery/copying and archiving are deferred.
- `api/services/entity_registry.py` defines trusted shareable-entity metadata for Projects, Shopping lists and cookbooks. Generic invitations, localized email labels and recipient-specific WebSocket snapshots use that registry and the existing entity access contract. Pending cookbook invitees receive invitation metadata, never cookbook contents.
- Migration 061 widens the existing access-type constraint and adds cookbooks. The SQLite rebuild preserves access/grant IDs, grant statuses, indexes, triggers and the AUTOINCREMENT high-water mark, verifies foreign keys, and commits the version marker atomically.
- Cookbook creation uses actor-scoped client mutation identities under the writer lock. Persistent creation receipts keep a tombstone when a book is deleted, so a delayed retry cannot recreate it. Creation, metadata changes, deletion and transfer validate permissions inside the same transaction. Personal books support direct invitations; household books inherit household access. No cookbook archive lifecycle is defined yet.
- IndexedDB version 9 adds `cookbooks`; version 10 adds `entityImages`, without resetting Tasks, Shopping or their queues. Shared metadata helpers implement atomic cache/queue writes, replay receipts and typed privacy eviction. Unsent metadata edits may collapse; an attempted request keeps its identity and payload across ambiguous responses.
- Complete cookbook snapshots reconcile canonical IDs and pending metadata before publishing. Revocation drops only cookbook cache/queue records; permission loss removes unauthorized management intents while retaining the readable authoritative entity. Active navigation and editors follow ID receipts. Authenticated-runtime epochs fence old drafts and asynchronous leave operations independently of ordinary access-generation changes.

- Migration 062 stores recipe groups, ingredients, tags, steps and a single title image relationally under one cookbook. Child `client_key` identities retain their server IDs when reordered or moved between groups. Cookbook deletion cascades recipe content; actor mutation receipts retain deletion tombstones.
- Recipe content CRUD inherits the cookbook content-edit permission, while cookbook metadata/access management remains separate. A recipe belongs to exactly one cookbook. The shared editor supplies its window, keyboard and save lifecycle; recipe fields and ordered child controls are module content. Newlines inside a step remain part of that step; the reading view displays the first line as its heading and the remaining lines as instructions. Tags are explicitly assigned, never inferred dietary classifications.
- Aggregate mutations validate and write inside one SQLite writer transaction. PATCH and DELETE compare `expected_revision`; actor-scoped mutation receipts make uncertain retries idempotent. Responses distinguish the current `revision` from the exact receipt's `applied_revision`, so later queued edits cannot silently rebase over an intervening foreign update. A conflict retains the local draft and requires an explicit local/server choice.
- Recipe snapshots, children and image versions are read from one SQLite snapshot. Complete client snapshots confirm creates only from actual server evidence, preserve higher acknowledged revisions of still-authorized present recipes, and always apply authoritative access and absence. Pending local cookbooks/recipes are never their own acknowledgement.
- Migration 065 adds ordered, optional step-to-ingredient links. Composite foreign keys enforce one recipe boundary and cascade deleted children; API/offline payloads use ingredient `client_key` references, never name matching. Steps expose `ingredients: [{ingredient_client_key, show_quantity}]`. An omitted legacy field preserves same-key links; explicit `[]` clears them. Deleting an ingredient prunes inherited references, while explicitly invalid references fail validation atomically. Optimistic projection and editor drafts preserve this distinction without rewriting attempted requests.
- Reading and cooking share one step-ingredient renderer and the existing portions formatter/control. A recipe quantity is displayed only when the ingredient is used in one step and `show_quantity` is true; multiple uses or an explicit partial amount show its name with a partial-quantity label. No per-step numerical allocation is inferred. Cooking shows one current step, retains its stable key across reorder, and uses actor-scoped browser history for step/portion restoration. Step navigation replaces history; Back exits cooking before leaving the recipe. Module/access/session changes fence or clear the view; content editing remains within the shared recipe editor.
- Recipe quantities use the shared typed unit registry in `api/resources/quantity_units.json`. It defines canonical IDs, reviewed aliases across all supported locales, physical conversion factors, fixed localized display labels and kitchen display precision. Quick Add, BrainDump extraction/review, Shopping and recipe editors use the same registry. Unknown units remain literal; there is no fuzzy/STT typo correction. The generated offline frontend module is checked for freshness and backend parity; CLDR refresh preserves application definitions and aliases.
- Recipe portions are calculated from original values. Transfers and provenance store unrounded quantities; merged values add original amounts before display. Migration 064 adds server-owned `quantity_display_mode`: recipe transfers set `kitchen`, while explicit manual quantity edits restore `exact`; metadata-only edits retain the mode, including offline projection. Kitchen display rounds metric amounts at least 10 to whole units and amounts from 0.5 to under 10 to half units; smaller positive quantities remain exact. Fractional large metric units may display in g/ml. Counts, spoons and unknown units retain exact values; common small fractions display as ¼, ⅓, ½, ⅔ and ¾. Manual Shopping quantities and free-text amounts are never kitchen-rounded.
- Migration 063 adds generic Shopping free quantities/notes and immutable recipe-origin records. A transfer requires source read access and destination content-edit access, validates list-scoped sections/active stores, and writes the whole selection in one writer transaction. Numeric quantities merge into open items with the same normalized name, note, section and store set, converting metric mass/volume units only. Free/unmeasured amounts remain separate; completed items are untouched. Copied content belongs to the Shopping access boundary; a live recipe ID is exposed only with current source access.
- `TRANSFER_RECIPE_TO_SHOPPING` is one durable queue intent, without optimistic Shopping merges. Actor-scoped mutation receipts prevent duplicates after lost responses. A transfer captures either the acknowledged source revision or its pending recipe mutation receipt; referenced pending writes cannot collapse into later edits. Typed temporary IDs remap before dispatch; attempted payloads are immutable. Access revocation evicts the private intent. Source conflicts/validation errors remain blocked for explicit removal and review; subsequent source writes wait for an earlier unblocked transfer. A cookbook with such a dependent transfer cannot be deleted until it settles or is canceled. Canceling an attempted, uncertain transfer is not an undo.
- Title images are bounded, verified raster inputs normalized to metadata-free WebP using the shared raster decoder. Their bytes commit with the aggregate in SQLite. Authenticated image reads recheck current cookbook access and version and use `private, no-store`; no arbitrary image URL is fetched server-side. The existing authenticated image loader supports entity-scoped cache keys and access predicates. IDB image writes share the privacy commit lock, and typed revocation removes cached blobs alongside recipe/queue records.

## Shared BrainDump capture and routing

- Extraction is shared infrastructure. Common candidate normalization and routing contracts live in `api/services/braindump_candidates.py`; module-specific fields remain separate.
- New extraction clients opt in with `supported_modules` (`tasks` and/or `shopping`). Available candidate types are intersected with the account's enabled modules. Omitting the capability preserves the existing task-only response shape.
- The admin default-prompt reference shows the current module-aware standard from the same template used for extraction. Legacy requests explicitly select the compatibility variant; custom append/replace settings are applied separately to the selected standard.
- Opted-in candidates use `module_id`. Shopping targets use `shopping_list_id`, `shopping_section_id`, and `shopping_store_ids`; they never reuse project, task-section, or workspace identifiers. Shopping-only extraction does not require a Tasks workspace.
- The LLM receives bounded, authorized routing metadata, not Shopping item contents. Unknown or ambiguous Shopping targets remain unresolved; extraction neither creates a default list nor converts an unavailable Shopping suggestion into a Todo.
- Shopping routing compares item meaning with sections across the authorized lists, including generic list names. A uniquely matching child reference can identify a missing parent list; conflicting hints, invalid explicit IDs and ambiguous matches remain unresolved.
- Unit spellings are normalized before candidate review/deduplication and at every new-write boundary. Canonical IDs, not translated labels, are queued and stored. Already-attempted mutation bodies remain immutable. Unit labels are presentation only; container and spoon identities do not imply physical conversions. The reviewed registry combines pinned Unicode CLDR spellings with Nia aliases; refresh via `python3 scripts/update_quantity_units.py`, then `python3 scripts/generate_quantity_unit_data.py`. The checked-in license accompanies the CLDR data.
- A single launcher and review controller serves enabled Tasks and Shopping modules. The shared candidate editor keeps module-specific drafts and allows correcting the destination. Unresolved destinations block saving. The dialog frame is shared with the existing entity and item editors; learning settings live in the application's General settings.
- Confirmation uses each module's existing mutation path and revalidates access. Shopping items enter the durable offline queue with stable mutation IDs, including target remapping for locally created lists, sections and stores. Tasks use actor-scoped idempotent receipts; an uncertain response retains the submitted payload until its retry resolves. Completed groups remain saved if a later group fails.
- Typed routing feedback is recorded atomically with creation and only once per mutation. Learned routes retain domain IDs, are reauthorized before reuse, respect learning opt-out/reset, and do not replace explicit deadlines, recurrence, location, quantities or units with another candidate type. The Todo endpoint rejects Shopping candidates.
- Typed candidates carry validated `explicit_route_fields` provenance for container, section and stores. Spoken destinations (including explicit empty choices) take precedence over learned routes; inferred destinations remain correctable. Transcript destination names independently add protection, missing/invalid provenance uses conservative protection, and deduplication retains the strongest protection.

## Native Apps

Native apps are shipped from the same Tauri codebase and share the web UI version with the server release. They are not pure remote WebViews: the app bundles a local UI shell, stores the configured server URL locally, verifies the target server through `/api/instance`, and uses that URL as API/WebSocket base.

Current state:

- Tauri bundles a clean `src-tauri/frontend-dist` generated from `web/`; `web/downloads/` is deliberately excluded from the native bundle.
- Windows, Android, and Debian desktop releases use the same `X.Y.Z` version as web/server and are built by the tag-triggered `release.yml` GitHub Actions workflow.
- Debian desktop is distributed as a Debian package named `nia-todo-desktop`, with artifacts named `nia-todo-desktop-vX.Y.Z-debian-amd64.deb`, so it does not conflict with the server package `nia-todo`.
- Native local reminders are implemented: Windows uses the local scheduler/tray path, Android uses `AlarmManager` and rehydrates reminders after reboot/app restart.
- Offline cold start is supported through the bundled UI shell plus service-worker cache.
- The Debian desktop app uses Linux WebKitGTK/Tauri custom-scheme origins such as `tauri://localhost`; the backend allows those origins for native runtime requests after instance verification.
- The Debian desktop app clears volatile WebView cache directories when the app version or executable path changes so stale bundled frontend assets do not survive desktop app updates.
- Debian desktop notifications prefer `notify-send` when available, falling back to the Tauri notification API.
- Debian desktop hotkeys use exactly one platform backend: GNOME/Wayland uses the XDG Desktop Portal GlobalShortcuts API exclusively, while X11 uses the legacy Tauri global-shortcut path. The installed desktop filename and registered host application ID are both `de.tobiaskneidl.nia-todo`; version 1 portals can deliver actions, while version 2 activation tokens are applied to the GDK Wayland display on the GTK main thread for compositor-approved foreground activation. Portal action descriptions are serialized from nia-todo's active i18n dictionary during early native boot—even before the optional server-setup screen—and retried after transient persistence failures. Description-only changes update the settings snapshot without tearing down or recreating any active hotkey backend; an actual hotkey change synchronizes the current descriptions immediately before portal registration. If localized descriptions are temporarily unavailable, Wayland falls back to the previously working built-in labels instead of reporting success without creating a portal session. Closing or toggling the app hides the window completely for tray-only behavior; GNOME/Wayland therefore chooses the monitor again when the hidden surface is remapped. Absolute positioning remains unused because Wayland does not provide reliable application-controlled placement. Portal recovery never enables the X11 backend in parallel.
- Native passkeys are supported: Windows uses the native WebAuthn bridge; Android uses AndroidX Credential Manager and the bundled app ID/signing-key binding exposed through `/.well-known/assetlinks.json`. Debian desktop passkeys are intentionally deferred.
- Browser/PWA push remains browser/PWA-only; native reminders must not depend on browser push.

Operational constraints:

- Android is pinned to app ID `de.tobiaskneidl.nia_todo` and the permanent release key. Re-sign/custom package builds need an explicit migration strategy before they can be passkey-compatible.
- Native app compatibility is controlled by `min_native_client_version` from `/api/instance`; normal releases do not raise it unless the release workflow is run with `set_min_app_version: true`.

## Auth

- JWT / Session-Token
- User sessions last 30 days and are rolling-extended via `/api/me` when they are about to expire
- Admin sessions are shorter-lived and versioned separately
- CSRF-Schutz für Browser-Sessions
- API keys for external use only via `Authorization: ApiKey ...`
- Users see their own data plus accepted shared projects
- shared project access is checked in projects, todos, sections, reminders, and WebSocket payloads
- **Email verification**: login, password reset, and project sharing require verified emails
- **OIDC/SSO**: users and admins can sign in through a configured OIDC provider. Admin configuration stores issuer/client/scopes and write-only client secret data; account links live as OIDC identities and native apps complete sign-in through a short-lived native exchange handoff.
- **Neutral API responses** for email-based actions prevent user enumeration
- **Pending invites** are visible only to the invitee for privacy reasons (not to owners/members)
- **2FA/MFA** is integrated into the normal password login: if an account requires 2FA and no valid trusted-device cookie exists, `/api/login` returns a challenge instead of an access token. After a successful login challenge, a JWT with `mfa_login_at` is issued; sensitive actions use separate one-time MFA action grants.
- **2FA methods**: TOTP and passkeys are the primary self-managed factors. Recovery codes are stored hashed/table-backed, single-use, and only backup factors to TOTP/passkey; when the last primary factor is removed, they are automatically revoked and cannot be regenerated without an active primary factor. Email code is a valid fallback factor when no stronger factor is present, a verified email exists, and sending succeeded. Passkeys use WebAuthn challenge/verify endpoints with ES256/P-256 assertions, user-verification required, explicit HTTPS `public_base_url` RP/origin binding (`http` only locally), `none` attestation parsing, signature verification, and sign-counter rollback checks; credentials live revocably in `passkeys`/`passkey_challenges`. Native passkeys run on Windows through the native WebAuthn bridge and on Android through AndroidX Credential Manager; Android is deliberately pinned to the bundled app ID `de.tobiaskneidl.nia_todo` and the release key via Digital Asset Links. Debian desktop passkeys are intentionally deferred until a dedicated Linux credential-manager integration exists.
- **Device sessions and trusted devices**: interactive JWTs can be backed by `user_sessions` so individual signed-in devices can be revoked without invalidating the whole account. Trusted 2FA-remember devices are stored separately as an HttpOnly cookie plus hashed server token, expire after 30 days, and are invalidated via `two_factor_remember_version` on reset/disable. A device revoke ends the corresponding JWT session; if it was also a trusted 2FA device, the trusted-device record is revoked too. Trusted devices allow app login without repeat MFA, but do not count for sensitive actions: password changes or API key management must still trigger a real one-time MFA reauth.
- **Security-sensitive actions** use one-time MFA action grants; for 2FA-required accounts, each sensitive action must consume exactly one fresh grant. Old JWTs without login MFA assurance are rejected for normal API auth after 2FA activation/policy. Reauth is replay-hardened: action grants are consumed atomically, reauth buckets are closed after success, email codes are deleted, and TOTP reauth timesteps are accepted only once. The non-sensitive 2FA status remains readable for valid interactive JWTs so clients can choose the correct reauth factor.
- **Audit events** document 2FA policy changes, enrollment, recovery code generation/use, challenge success/failure, email code sending for login/reauth, passkey changes, trusted-device creation/revocation, and admin reset. Challenge and reauth verification are limited by attempt counters, including email/passkey reauth challenges; challenge consumption happens via `consumed_at IS NULL` updates against replay/races. API keys are deliberately excluded from interactive MFA as machine tokens and remain revocable; the settings UI reauthenticates API key management when needed, and the admin UI shows the active API key count as a hint but does not automatically revoke existing keys.

## User Onboarding

- Email addresses are required for new users, are validated, and are kept unique
- Existing users without an email remain migratable; admin or user can add the address later
- Admins do not set user passwords directly
- New users receive a one-time password setup link (`password_setup_tokens`)
- Password setup/reset links are valid for 24 hours and are stored hashed
- Users can change their own email and display name in the settings modal; the username remains immutable
- Avatar images live as WebP files under `api/data/avatars/`; the database stores only the URL and modification timestamp
- Avatar uploads accept JPEG/PNG/WebP/GIF as well as HEIC/HEIF; HEIC is processed server-side via `pillow-heif` or `heif-convert` when the browser does not support preview/cropping
- Production now runs on a separate LXC; this dev checkout does not contain or manage live data/backups.


## Location Reminders

- Saved places are user-scoped records under `/api/places` with name, address, and icon.
- Todos can carry location reminder metadata for Android-native arrival/departure triggers.
- Address data is stored server-side for the owning user and synchronized to linked location reminders when a saved place address changes.
- Android handles local geofence-style reminder behavior; browser/PWA push remains separate.
