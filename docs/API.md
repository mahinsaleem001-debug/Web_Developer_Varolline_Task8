# Taskflow Live API documentation

Base URL: `http://localhost:3000/api`  ·  All bodies and responses are JSON.

## Conventions


| Topic | Rule |
|---|---|
| **Authentication** | `POST /auth/signup` or `/auth/login` sets an `HttpOnly`, `SameSite=Strict` cookie (`tf_token`, a signed JWT, 7 days). Send it back on every request (browsers do this automatically). |
| **CSRF protection** | Every `POST`, `PATCH` and `DELETE` must include the header `X-Requested-With: taskflow`. Otherwise: `403 CSRF`. |
| **Permissions** | A user can only access boards they are a **member** of. For anyone else, board / list / task / comment ids answer `404 NOT_FOUND`, so the existence of other people's data is not revealed. Roles: `owner` (created the board) and `member`. |
| **Errors** | `{ "error": { "code": "VALIDATION", "message": "...", "fields": { "title": "Title is required." } } }`. `fields` is only present for validation errors. |
| **Versioning for sync** | Every change to a board increases `board.version`. Write responses carry the new value in the headers `X-Board-Id` and `X-Board-Version`. The same number is the id of the live event for that change. |
| **Tab id** | Optional header `X-Client-Id` (6-40 letters, digits, `-`, `_`). It is sent back as `origin` in live events so a tab can recognise its own changes. |
| **Idempotency** | Optional header `Idempotency-Key` (8-64 letters, digits, `-`, `_`) on the create requests (`POST /boards`, `/boards/:id/columns`, `/columns/:id/tasks`, `/tasks/:id/comments`). Repeating a request with the same key returns the first response (header `Idempotent-Replay: true`) and creates nothing new. Keys are remembered for 10 minutes, per user. Failed requests are not remembered. |

### Status codes

`200` OK · `201` created · `400` validation error · `401` not logged in / bad session · `403` not allowed (wrong role, missing CSRF header) · `404` not found or not a member · `409` conflict (duplicate) · `413` body too large · `429` too many login attempts · `500` server error.

---

## Auth

### `POST /auth/signup`
Body: `{ "name": "Ada Lovelace", "email": "ada@example.com", "password": "Passw0rd1" }`
Rules: name 2-50 chars; valid email; password 8-72 chars with at least one letter and one number.
`201` → `{ "user": { "id": 1, "name": "Ada Lovelace", "email": "ada@example.com" } }` (+ cookie)
Errors: `400 VALIDATION`, `409 EMAIL_TAKEN`, `429 RATE_LIMIT`.

### `POST /auth/login`
Body: `{ "email": "...", "password": "..." }` → `200` `{ "user": {...} }` (+ cookie).
Errors: `400 VALIDATION`, `401 BAD_CREDENTIALS` (same message for unknown email and wrong password), `429 RATE_LIMIT`.

### `POST /auth/logout`
→ `200` `{ "ok": true }` and clears the cookie.

### `GET /auth/me`
→ `200` `{ "user": {...} }`, or `401 UNAUTHENTICATED`.

---

## Boards

### `GET /boards`
Boards the current user belongs to, newest activity first.
→ `{ "boards": [ { "id": 1, "name": "Website Launch", "description": "", "role": "owner", "memberCount": 3, "taskCount": 7, "updatedAt": "..." } ] }`

### `POST /boards`
Body: `{ "name": "Website Launch", "description": "optional, max 200" }` (name 1-60).
Creates the board, makes you its owner and adds three lists (To do, In progress, Done).
`201` → full board object (same as `GET /boards/:id`).

### `GET /boards/:id`
Everything needed to draw the board in one request.
```json
{
  "board":   { "id": 1, "name": "...", "description": "...", "ownerId": 1, "version": 12, "updatedAt": "..." },
  "role":    "owner",
  "members": [ { "id": 1, "name": "Sara Khan", "email": "sara@example.com", "role": "owner" } ],
  "columns": [ { "id": 1, "name": "To do", "position": 1 } ],
  "tasks":   [ { "id": 5, "boardId": 1, "columnId": 1, "title": "...", "description": "...", "priority": "high",
                 "due": "2026-11-02", "assigneeId": 2, "position": 1, "commentCount": 2, "createdAt": "...", "updatedAt": "..." } ]
}
```

### `GET /boards/:id/version`
→ `{ "version": 12 }`. A tiny response the browser polls every few seconds to find out whether a teammate changed something.

### `PATCH /boards/:id` (owner only)
Body: `{ "name"?, "description"? }` → `{ "board": { id, name, description, version } }`. Members get `403`.

### `DELETE /boards/:id` (owner only)
Deletes the board with all lists, tasks, comments and memberships. → `{ "ok": true }`.

---

## Members

### `POST /boards/:id/members` (owner only)
Body: `{ "email": "omar@example.com" }`. The person must already have an account.
`201` → `{ "members": [ ... ] }`. Errors: `404 NO_SUCH_USER`, `409 ALREADY_MEMBER`.

### `DELETE /boards/:id/members/:userId`
Owner can remove anyone except themselves; any member can remove **themselves** (leave). Tasks assigned to the removed person become unassigned. The owner cannot leave (`400 OWNER_CANNOT_LEAVE`): delete the board instead. → `{ "ok": true }`.

---

## Lists (columns)

### `POST /boards/:id/columns`
Body: `{ "name": "Review" }` (1-40 chars, max 12 lists per board). `201` → `{ "column": { id, name, position } }`.

### `PATCH /columns/:id`
Body: `{ "name": "QA" }` → `{ "column": {...} }`.

### `DELETE /columns/:id`
Deletes the list **and its tasks and their comments**. → `{ "ok": true }`.

---

## Tasks

### `POST /columns/:id/tasks`
Body: `{ "title": "Write docs", "description"?: "max 2000", "priority"?: "low|medium|high" (default medium), "due"?: "YYYY-MM-DD", "assigneeId"?: 2 }`
`assigneeId` must be a member of the board (`400` otherwise). The task is added at the bottom of the list.
`201` → `{ "task": {...} }`.

### `GET /tasks/:id`
→ `{ "task": {...} (includes `rev`), "comments": [ { "id": 1, "taskId": 5, "body": "...", "createdAt": "...", "author": { "id": 2, "name": "Omar Ali" } } ] }`

### `PATCH /tasks/:id`
Partial update: send only the fields that change (`title`, `description`, `priority`, `due` (null clears it), `assigneeId` (null unassigns)), and optionally `baseRev`, the task `rev` the client was looking at.
→ `{ "task": {...} }` (`"unchanged": true` and no event if nothing actually changed).

**Conflict detection (field level).** A field conflicts only if someone else changed *that field* after `baseRev`. Different fields merge automatically. On a conflict nothing is applied and the answer is `409`:
```json
{ "error": { "code": "CONFLICT", "message": "Someone else changed this task while you were editing.",
    "conflicts": [ { "field": "title", "yours": "Bob title", "theirs": "Ann title", "by": { "id": 1, "name": "Ann Tester" } } ],
    "current": { "id": 5, "title": "Ann title", "rev": 4 } } }
```
`by` is the person who made the other change (`null` for old data). Resend with `baseRev` set to `current.rev` to overwrite on purpose. Without `baseRev` the last writer wins.

### `POST /tasks/:id/move`
Moves a task to a list and position (this is what drag-and-drop calls).
Body: `{ "columnId": 2, "index": 0 }` where `index` is the 0-based place in the destination list (a too-large index means "last").
The list must belong to the same board. Positions in both lists are renumbered `1..n`. → `{ "task": {...} }`.

### `DELETE /tasks/:id`
Deletes the task and its comments. → `{ "ok": true }`.

---

## Comments

### `POST /tasks/:id/comments`
Body: `{ "body": "Looks good" }` (1-1000 chars). `201` → `{ "comment": {...} }`. Any board member can comment.

### `DELETE /comments/:id`
The author or the board owner can delete. Others get `403`. → `{ "ok": true }`.

---

## Real-time (Server-Sent Events)

### `GET /boards/:id/events?since=VERSION`
A long-lived `text/event-stream`. Members only (`401` / `404` otherwise). `since` is the board version the client loaded; when the browser reconnects it sends `Last-Event-ID` instead, which wins.

Versioned events have an SSE `id` (= board version) and are **replayed** after a reconnect, in order, exactly once. Unversioned events are never replayed.

| Event | When | `data` |
|---|---|---|
| `hello` | first message | `{ "connId": "...", "version": 12 }` (use `connId` for presence) |
| `presence` | someone joins, leaves or opens a task | `{ "users": [ { "id", "name", "tabs", "editing": [taskId] } ] }` |
| `resync` | the history is too old or unknown | `{ "reason", "version" }`: reload the board with `GET /boards/:id` |
| `ping` | every 15 s | `{ "t": 1700000000000 }` |
| `removed` | you were removed from the board (stream then closes) | `{ "boardId" }` |
| `board.deleted` | the board was deleted (stream then closes) | `{ "boardId" }` |
| `task.created` | `{ "task" }` | versioned |
| `task.updated` | `{ "task", "changed": ["title"] }` | versioned |
| `task.moved` | `{ "task", "positions": [ {id, columnId, position} ] }` | versioned |
| `task.deleted` | `{ "id", "columnId", "positions" }` | versioned |
| `comment.created` / `comment.deleted` | `{ "comment", "taskId", "commentCount" }` / `{ "id", "taskId", "commentCount" }` | versioned |
| `column.created` / `column.updated` / `column.deleted` | `{ "column" }` / `{ "column" }` / `{ "id", "taskIds" }` | versioned |
| `member.added` / `member.removed` | `{ "members" }` / `{ "userId", "members", "unassigned": [taskId] }` | versioned |
| `board.updated` | `{ "board": { id, name, description } }` | versioned |

Every versioned event is wrapped as `{ "id": 42, "type": "task.updated", "by": userId, "origin": "tab id or null", "data": {...} }`.

### `POST /boards/:id/presence`
Body: `{ "connId": "<from hello>", "taskId": 5 }` (`taskId: null` = no task window open). Others then see an "editing" marker. `404 NO_CONNECTION` if the stream is gone, `400` for an unknown task.

Example (shell, after logging in with a cookie jar):
```bash
curl -N -b jar.txt "http://localhost:3000/api/boards/1/events?since=0"
```

---

## Other

`GET /health` → `{ "ok": true }`.

## Example (curl)

```bash
# sign up and keep the cookie
curl -c jar.txt -H "Content-Type: application/json" -H "X-Requested-With: taskflow" \
  -d '{"name":"Ada Lovelace","email":"ada@example.com","password":"Passw0rd1"}' http://localhost:3000/api/auth/signup

# create a board
curl -b jar.txt -H "Content-Type: application/json" -H "X-Requested-With: taskflow" \
  -d '{"name":"My board"}' http://localhost:3000/api/boards

# list boards
curl -b jar.txt http://localhost:3000/api/boards
```
