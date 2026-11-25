# Switchboard

Switchboard is a multi-workspace shared inbox for support teams. Customers
write through the Pigeon messaging simulator; agents sign in, manage
conversations, and send replies. The browser never talks to Pigeon directly.

```text
Pigeon webhook -> Express API -> MongoDB
                           -> React/Vite inbox
React reply -> durable MongoDB outbox -> Pigeon
                                  Redis -> live WebSocket events
```

## Features

- OIDC login using authorization code flow with PKCE and server-managed
  HttpOnly session cookies.
- Workspace-scoped conversations, message history, assignment, open/close,
  unread counts, priority, and conversation search.
- Signed Pigeon webhook validation, duplicate-event protection, and
  out-of-order status handling.
- Durable, idempotent reply delivery with retry handling and status updates.
- Authenticated WebSocket updates with per-workspace sequence numbers and
  replay after reconnect.
- React/Vite client with workspace switching and live inbox refresh.

The UI search filters conversations already loaded by the API; it is not
Elasticsearch-backed. Encrypted private notes and billing are not implemented.

## Requirements

- Node.js 22 or newer.
- Docker Desktop with Docker Compose.
- npm.

MongoDB, Redis, Pigeon, the mock IdP, and Paybox run through Docker Compose.
Elasticsearch is optional and only needed for a future search implementation.

## Run locally

From the repository root:

```sh
npm run up
npm run scaffold:install
```

Start the backend and web client in separate terminals:

```sh
npm run scaffold:server
npm run scaffold:web
```

Open [http://localhost:5173](http://localhost:5173). The Vite dev server
proxies `/api`, `/auth`, `/healthz`, and `/ws` to the backend on port 4000, so
the browser uses same-origin paths and the session cookie.

To check service readiness:

```sh
npm run doctor
```

Configuration is read from environment variables. Defaults are provided in
[.env.example](./.env.example); copy it to `.env` only if you need to override
them. Do not commit `.env`.

Without Docker, `npm run mocks` starts the provider simulators, but MongoDB and
Redis must be started separately and `MONGO_URL`/`REDIS_URL` must point to
them.

## Sign in

There are no passwords. The mock IdP displays the available users:

| User | Workspace membership |
|---|---|
| Asha Rao (`u_asha`) | `ws_acme` admin |
| Ben Ortiz (`u_ben`) | `ws_acme` agent |
| Chloe Martin (`u_chloe`) | `ws_globex` admin |
| Dev Patel (`u_dev`) | `ws_globex` agent |
| Eli Novak (`u_eli`) | agent in both workspaces |

Roles and workspace memberships come from the verified IdP token. The server
checks membership on API and WebSocket requests.

## Frontend API

Use the relative URLs below from the web client. JSON request bodies require
`Content-Type: application/json`.

| Method and path | Request | Result |
|---|---|---|
| `GET /auth/login` | Navigate the browser to this path | Redirects to the mock IdP; the callback sets a session cookie and returns to the web origin. |
| `GET /api/me` | — | `{ "sub": "u_ben", "workspaces": [{ "id": "ws_acme", "role": "agent" }] }`; `401` without a session. |
| `GET /api/conversations?workspace=ws_acme` | Optional `&state=open` or `&state=closed` | Array of conversations with `contact`, `assignee`, `state`, `unreadCount`, `priority`, `lastActivityAt`, and `lastMessage`. Maximum 100. |
| `GET /api/conversations/:contact/messages?workspace=ws_acme` | URL-encode `:contact` | Messages oldest first, with `id`, `direction`, `text`, `status`, `createdAt`, and `clientRef`. Maximum 500. |
| `POST /api/replies` | `{ "workspace": "ws_acme", "contact": "+14155550101", "text": "Hello", "client_ref": "unique-id" }` | `202` once safely stored. Reuse the same `client_ref` when retrying the same reply. |
| `POST /api/conversations/:contact/claim` | `{ "workspace": "ws_acme" }` | `200` if claimed by the session user; `409` if another agent holds it. |
| `POST /api/conversations/:contact/read` | `{ "workspace": "ws_acme" }` | `200`; clears the unread count. |
| `PATCH /api/conversations/:contact/priority` | `{ "workspace": "ws_acme", "priority": true }` | `200` on update; `404` if the conversation does not exist. |
| `PATCH /api/conversations/:contact/state` | `{ "workspace": "ws_acme", "state": "closed" }` | `state` must be `open` or `closed`; `200` on update. |
| `GET /ws?workspace=ws_acme&after=41` | Session cookie is required | Authenticated WebSocket. `after` is optional; send the last received `seq` on reconnect to replay missed events. |

Workspace-scoped endpoints return `401` without a session and `403` if the
signed-in user is not a member of the requested workspace. The server derives
the agent ID from the session; clients must not send an agent identity.

WebSocket frames are JSON. Every event includes a workspace-local increasing
`seq`; common event types include `message.inbound`, `message.status`,
`conversation.assigned`, `conversation.priority`, and `conversation.updated`.
The UI refreshes server data after receiving an event.

`GET /healthz` returns `200` when the backend is ready. The grader-only
`/__grader/*` routes are for the harness, not the UI; their exact contract is
in [BRIEF.md](./BRIEF.md).

## Development and checks

Pigeon sends test customer messages automatically. Useful commands:

```sh
npm run inbound   # trigger an inbound test message
npm run quiet     # stop the automatic message trickle
npm run drizzle   # restart the trickle
npm run report    # show what Pigeon received
```

Type-check and build the client:

```sh
npm --prefix scaffold/server run typecheck
npm --prefix scaffold/web run typecheck
npm --prefix scaffold/web run build
```

The harness starts the backend using [switchboard.json](./switchboard.json).
Stop any dev server before running it: checks start their own server and reset
application data. `npm run check` runs Level 1; `npm run check:full` runs the
available full suite and writes `CHECK_REPORT.json`. Level 4 is a written
contract and needs manual review; see [PIGEON.md](./PIGEON.md).

Before submission, follow [SUBMISSION.md](./SUBMISSION.md), including exporting
the AI session logs to `ai-logs/`.
