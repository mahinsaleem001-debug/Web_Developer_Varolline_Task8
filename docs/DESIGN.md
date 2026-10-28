# Design write-up: real-time collaboration in Taskflow Live

## 1. Goal

Two or more people have the same board open. When one person adds, edits, moves or comments on a task, the others see it **immediately**, without refreshing. The app must also cope with real-world problems: dropped connections, the same event arriving twice, two people editing the same task, and it must show **who is online**.

## 2. Why Server-Sent Events (SSE) and not WebSockets

| | SSE | WebSocket |
|---|---|---|
| Direction | server to browser only | both ways |
| Transport | plain HTTP, works with cookies, proxies and the existing auth | separate protocol, needs its own auth and framing |
| Reconnect | **built in** (the browser retries and sends `Last-Event-ID`) | must be written by hand |

Taskflow already sends changes to the server with normal `fetch()` calls (which have validation, permissions and error handling). The only missing piece is *the server telling browsers what happened*, which is exactly one-way. SSE does that with less code and less risk. If we later needed very high-frequency or two-way traffic (for example live cursors), WebSockets would be the better choice.

## 3. How it works

```
 browser A --PATCH /api/tasks/5--> server --commit(version 42)--> hub --event 42--> browser B (and A's other tabs)
 browser B <== GET /api/boards/1/events (one long-lived HTTP stream per open board) ==
```

1. A write request is validated and permission-checked as before, then **committed**: the board's `version` goes up by one and the change is stored.
2. The same step publishes an event whose **id is that version**. The event carries the *new state* of what changed (for example the whole task), not an instruction like "set title".
3. The hub sends it to every open stream of that board (only members can open one) and keeps the last 200 events in memory for replay.
4. Each browser applies the event to its local copy of the board (`sync.js`) and redraws only what changed.

Files: `server/hub.js` (streams, replay, presence), `server/app.js` (commit and routes), `public/js/live.js` (connection), `public/js/sync.js` (applying events), `public/js/app.js` (UI).

## 4. Disconnects

- **Reconnect:** the browser reconnects on its own and sends `Last-Event-ID: <last version seen>`. The server replays every event after it, in order. A random `retry` delay (2-4 s) stops all clients reconnecting in the same instant after a server restart.
- **Resync:** if the history is too old (more than 200 events behind, or the server restarted and lost its memory) the server sends `resync` and the browser reloads the whole board once, then continues with live events.
- **Silent dead connections:** the server sends a `ping` every 15 s. If the browser hears nothing for 40 s it closes and reopens the stream (a watchdog).
- **Network changes:** when the browser goes offline the status shows "Offline"; when it comes back a fresh stream is opened right away. If the stream is closed for good (for example by an error response) the client retries with exponential backoff and jitter (1 s, 2 s, 4 s ... max 30 s), and stops if the answer is 401 (logged out) or 404 (removed from the board).
- **What the user sees:** a status pill: **Live**, **Reconnecting...**, **Offline**, and a "Reconnected. You are up to date." message.

## 5. Duplicate events and duplicate requests

- **Duplicate events:** the version is the event id and must arrive as exactly `current + 1`. `id <= current` is a duplicate and is ignored; `id > current + 1` means something was missed and triggers a resync. Applying an event is also **idempotent**: a task is only overwritten by a higher `rev`, so even a repeated event cannot change anything.
- **Own echo:** every request carries `X-Client-Id` (a per-tab id) and events carry it back as `origin`. While a request from this tab is still in flight, its echo is not applied (it only advances the version), so a quick sequence of drags never flickers.
- **Duplicate requests:** when a request times out, the user (or Retry) sends it again, but the first one may have succeeded. Create requests accept an `Idempotency-Key`. The server remembers the response for 10 minutes and replays it instead of creating a second task, comment or list. A replay publishes no new event.

## 6. Conflicting edits

Different kinds of change get different rules:

| Situation | Rule |
|---|---|
| Two people change **different fields** of a task (Ann edits the title, Bob the priority) | **Merged automatically**. Nobody loses anything. |
| Two people change the **same field** | The save is **rejected with 409** and nothing is applied. The window shows both versions and the user chooses *Use theirs* or *Keep mine* per field. |
| Someone moves a task while another person edits its text | No conflict: moving does not touch the text fields. |
| Both drag the same card | The server applies them in the order they arrive (last one wins) and everyone sees the final position. |
| A task is edited after it was deleted | `404`, and the window says it was deleted. |

How it is detected: every task has a revision number `rev` that goes up on each change, and every content field remembers the revision at which it last changed (`fieldRevs`). The browser sends only the fields it changed plus `baseRev`, the revision it was looking at. A field conflicts only if `fieldRevs[field] > baseRev`.

Conflicts are also shown **live**: if a teammate changes a field you are editing, the note appears at once, before you press Save, and Save stays disabled until you choose. Fields you have not touched simply update in front of you.

Without `baseRev` the API behaves as plain "last writer wins", which keeps simple clients working.

## 7. Who is online

The hub knows which streams are open on each board, so presence costs nothing extra:

- One person with several tabs counts **once** (the list shows one avatar).
- When a person's last tab closes they stay listed for a **3 second grace period**, so a page refresh does not flicker.
- A task window being open is reported with `POST /api/boards/:id/presence`; other people see an "editing" badge on that card and a note inside the task window. This gives people a chance to avoid conflicts before they happen.

## 8. Security

Only board members can open a stream; non-members get `404`. A person who is removed gets a `removed` event and their stream is closed, and they cannot reconnect. Deleting a board closes every stream. Events are only ever sent to streams of the same board.

## 9. Trade-offs and limits

- The replay buffer and presence live in the memory of **one server process**. Running several servers would need a shared broker (for example Redis pub/sub). The version numbers and the resync fallback would stay the same.
- SSE is one-way, so presence "I am editing" uses a normal POST. That is fine for these rare events.
- Browsers allow only a limited number of open HTTP/1.1 connections per site (about 6). Each open board tab uses one. HTTP/2 removes this limit in production.
- Conflict resolution is per field. Merging two different edits *inside* one long description would need a text-merge algorithm (such as CRDTs); here the user chooses a version.

## 10. How it was tested

42 automated tests: events reach other members with consecutive ids; replay after reconnect sends only the missed events once; resync after a gap or an unknown future version; heartbeat; presence (join, two tabs, grace period, editing marker); removed members and deleted boards; field-level merge and 409; idempotent retries; and the event-applying logic (duplicates, gaps, stale revisions). In two real browsers I also checked live add/move/comment, the editing badge, a live conflict, an offline period with replay, a server restart with resync, and a double-submitted form.
