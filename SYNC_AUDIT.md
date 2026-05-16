# nia-todo Sync/Broadcast System Audit

**Date:** 2026-05-16
**Scope:** Todos, Projects, Sections — Backend broadcasts, Frontend WS handlers, Sync Queue, refreshFromServer

---

## 1. Backend Broadcast Audit (api/main.py)

All 9 create/update/delete endpoints for Todos, Projects, and Sections call `broadcast_change()`.

| Endpoint | Method | Event Type | Broadcast | Line |
|----------|--------|------------|-----------|------|
| `/api/todos` | POST | `todo_create` | ✅ YES | 1201 |
| `/api/todos/{id}` | PATCH | `todo_update` | ✅ YES | 1248 |
| `/api/todos/{id}` | DELETE | `todo_delete` | ✅ YES | 1261 |
| `/api/projects` | POST | `project_create` | ✅ YES | 1289 |
| `/api/projects/{id}` | PATCH | `project_update` | ✅ YES | 1328 |
| `/api/projects/{id}` | DELETE | `project_delete` | ✅ YES | 1361 |
| `/api/projects/{pid}/sections` | POST | `section_create` | ✅ YES | 1408 |
| `/api/sections/{id}` | PATCH | `section_update` | ✅ YES | 1435 |
| `/api/sections/{id}` | DELETE | `section_delete` | ✅ YES | 1452 |

**Finding:** All 9 endpoints broadcast correctly. ✅

> **Note:** The `mark_reminder_sent` endpoint (`POST /api/reminders/{id}/sent`) modifies data but does **not** broadcast — out of scope for this audit but worth noting.

---

## 2. Frontend WebSocket Handlers (web/static/app.js)

All 9 event types have a handler in `handleWsMessage()`. Below: checks for IndexedDB update, local array update, UI re-render, and `updated_at` comparison.

| Event | IndexedDB | Local Array | UI Re-render | `updated_at` Check | Status |
|-------|-----------|-------------|--------------|-------------------|--------|
| `todo_create` | `dbPut('todos')` | `todos.push()` / replace temp | `renderProjects(), renderStats(), renderTodos()` | N/A (new item) | ✅ OK |
| `todo_update` | `dbPut('todos')` | `todos.map()` | `renderProjects(), renderStats(), renderTodos()` | `serverTime >= localTime` | ✅ OK |
| `todo_delete` | `deleteFromDB('todos')` | `todos.filter()` | `renderProjects(), renderStats(), renderTodos()` | N/A | ✅ OK |
| `project_create` | `dbPut('projects')` | `projects.push()` / replace temp | `renderProjects()` only | N/A (new item) | ⚠️ MINOR GAP |
| `project_update` | `dbPut('projects')` | `projects.map()` | `renderProjects()` only | `serverTime >= localTime` | ⚠️ MINOR GAP |
| `project_delete` | `deleteFromDB('projects')` | `projects.filter()` | `renderProjects(), renderStats(), renderTodos()` | N/A | ✅ OK |
| `section_create` | `dbPut('sections')` | `sections.push()` / replace | `renderTodos()` | N/A (new item) | ✅ OK |
| `section_update` | `dbPut('sections')` | `sections.map()` | `renderTodos()` | `serverTime >= localTime` | ✅ OK |
| `section_delete` | `deleteFromDB('sections')` | `sections.filter()` | `renderTodos()` | N/A | ✅ OK |

### Gaps Found:

1. **`project_create` handler** (line 773): Only calls `renderProjects()`. If the todo list is currently visible and grouped by project names, the new project won't appear in todo groupings until the next full re-render (e.g., navigation or `renderTodos()` triggered by another event).

2. **`project_update` handler** (line 787): Same issue — only `renderProjects()`. If a project's name or color changes while the todo list is open, stale project data is shown in todo groupings.

---

## 3. Sync Queue Audit (web/static/app.js)

All 9 sync queue actions are implemented in `syncWithServer()`.

| Action | HTTP Method | Endpoint | Local DB Update | Queue Remove | Status |
|--------|-------------|----------|-----------------|--------------|--------|
| `CREATE_TODO` | POST | `/api/todos` | `dbPut('todos', res)` + remove temp | `delete item.id` | ✅ OK |
| `UPDATE_TODO` | PATCH | `/api/todos/${id}` | Merge + `dbPut('todos')` | `delete item.id` | ✅ OK |
| `DELETE_TODO` | DELETE | `/api/todos/${id}` | `deleteFromDB('todos')` | `delete item.id` | ✅ OK |
| `CREATE_PROJECT` | POST | `/api/projects` | `dbPut('projects', res)` + remove temp | `delete item.id` | ✅ OK |
| `UPDATE_PROJECT` | PATCH | `/api/projects/${id}` | Merge + `dbPut('projects')` | `delete item.id` | ✅ OK |
| `DELETE_PROJECT` | DELETE | `/api/projects/${id}` | `deleteFromDB('projects')` | `delete item.id` | ✅ OK |
| `CREATE_SECTION` | POST | `/api/projects/${pid}/sections` | `dbPut('sections', res)` + remove temp | `delete item.id` | ✅ OK |
| `UPDATE_SECTION` | PATCH | `/api/sections/${id}` | Merge + `dbPut('sections')` | `delete item.id` | ✅ OK |
| `DELETE_SECTION` | DELETE | `/api/sections/${id}` | `deleteFromDB('sections')` | `delete item.id` | ✅ OK |

**Finding:** All actions use correct HTTP methods, update local DB after server success, and remove from queue. ✅

> **Note:** All actions have 404-guard handling (skip if already deleted on server).

---

## 4. refreshFromServer Audit

`refreshFromServer()` (line 1122) fetches `/api/todos`, `/api/projects`, `/api/sections` and merges with local IndexedDB.

| Entity | Fetched | `updated_at` Compare | Pending-Changes Check | Status |
|--------|---------|----------------------|---------------------|--------|
| Todos | `GET /api/todos` | `serverTime >= localTime` | Checks `UPDATE_TODO` in queue | ✅ OK |
| Projects | `GET /api/projects` | `serverTime >= localTime` | Checks `UPDATE_PROJECT` in queue | ✅ OK |
| Sections | `GET /api/sections` | `serverTime >= localTime` | Checks `UPDATE_SECTION` in queue | ✅ OK |

**Finding:** Sections are merged **identically** to Todos and Projects — same `updated_at` comparison and same pending-changes guard. ✅

---

## Summary Matrix

```
Entity    | Op     | Backend Broadcast | Frontend WS Handler | Sync Queue | refreshFromServer
----------|--------|-------------------|---------------------|------------|------------------
todo      | create | YES               | OK                  | OK         | N/A
todo      | update | YES               | OK                  | OK         | OK
todo      | delete | YES               | OK                  | OK         | N/A
project   | create | YES               | MINOR GAP*          | OK         | N/A
project   | update | YES               | MINOR GAP*          | OK         | OK
project   | delete | YES               | OK                  | OK         | N/A
section   | create | YES               | OK                  | OK         | N/A
section   | update | YES               | OK                  | OK         | OK
section   | delete | YES               | OK                  | OK         | N/A
```

\* **MINOR GAP** = `project_create` and `project_update` WS handlers only call `renderProjects()`, missing `renderStats()` and `renderTodos()`. This means if the todo list is visible when a project is created or updated by another client (or via sync), the todo grouping/project names may be stale until the next full render.

---

## Bonus Finding (Outside Scope)

- **`sync_response` (WS handler, line ~685):** Todos in `sync_response` do **not** check for pending changes in the sync queue, while Projects and Sections do. This is inconsistent with `refreshFromServer()` which guards all three entity types. If a todo has a pending `UPDATE_TODO` in the queue when `sync_response` arrives, the older server version could overwrite the newer local pending changes.
