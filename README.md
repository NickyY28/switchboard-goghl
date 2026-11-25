# Switchboard

Switchboard is a shared support inbox. Customer messages arrive through the
Pigeon simulator; agents sign in, work conversations, and send replies.

## Run locally

From the repository root:

```sh
npm run up
npm run scaffold:install
npm run scaffold:server
```

In another terminal, run the React client:

```sh
npm run scaffold:web
```

The server reads its settings from the environment; defaults are listed in
[.env.example](./.env.example). `npm run doctor` checks the local services.

## Backend API

- `GET /auth/login` starts OIDC authorization with PKCE.
- `GET /api/me` returns the signed-in user and workspace memberships.
- `GET /api/conversations?workspace=<id>` lists a member's conversations.
  Add `state=open` or `state=closed` to filter.
- `GET /api/conversations/:contact/messages?workspace=<id>` returns messages
  oldest first.
- `POST /api/replies` accepts `{ "workspace", "contact", "text", "client_ref" }`.
  It stores the reply and returns `202`; a background worker sends it to Pigeon.
- `POST /api/conversations/:contact/claim` accepts `{ "workspace" }`.
- `POST /api/conversations/:contact/read` accepts `{ "workspace" }`.
- `PATCH /api/conversations/:contact/priority` accepts
  `{ "workspace", "priority": true }`.
- `PATCH /api/conversations/:contact/state` accepts
  `{ "workspace", "state": "open" | "closed" }`.
- `GET /ws?workspace=<id>&after=<seq>` streams authenticated workspace events.

The web scaffold proxies `/api`, `/auth`, `/healthz`, and `/ws` to the server.
The grader-only endpoints are documented in [BRIEF.md](./BRIEF.md).

## Checks

`npm run check:full` runs the available reliability and login checks and writes
`CHECK_REPORT.json`. It resets application data and starts the server itself;
stop the dev server first. Level 4 is a written contract and is not included in
the local check.
