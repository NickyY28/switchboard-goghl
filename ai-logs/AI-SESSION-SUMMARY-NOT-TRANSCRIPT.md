# AI-assisted work summary — not a transcript

This is a post-hoc summary based on the project decisions and repository work.
It is not an exported Copilot session transcript and must not be presented as
one or used as a replacement for the required, unedited session exports.

## Work covered

- Reviewed the Switchboard brief, provider contract, scaffold, and local setup.
- Implemented the backend inbox flow: signed Pigeon webhooks, MongoDB
  persistence and deduplication, atomic conversation claims, and a durable
  outbound reply queue using Pigeon's idempotency key.
- Added OIDC authorization-code login with PKCE, server-managed sessions,
  workspace-scoped APIs, and authenticated WebSocket events with replay.
- Organized the backend into config, middleware, and feature-based modules.
- Integrated the React/Vite client with login, workspace selection, inbox,
  message history, replies, claims, read state, priority, conversation state,
  and realtime refreshes.
- Fixed frontend integration gaps: latest-message previews, inbound message
  status typing, retry reuse of a pending reply's `client_ref`, activity
  ordering, and WebSocket reconnect behavior.

## Decisions and scope

- Keep identity tokens on the server; the browser uses the session cookie.
- Enforce tenant membership on the server for API and WebSocket access.
- Use MongoDB for conversations, messages, webhook deduplication, and queued
  replies; use Redis for sessions and cross-instance realtime coordination.
- Identify customers by phone number because the simulator provides no profile
  names.
- Defer encrypted private notes, Elasticsearch-backed search, and billing.

## Verification state

- A full automated run scored 75/75 for levels 1, 2, 3, and 5 before the final
  folder and frontend integration changes.
- Level 5 was rerun after the backend folder refactor and passed.
- Server and frontend TypeScript checks passed after the later integration
  fixes. The full harness was not rerun after those fixes; Level 4 requires
  manual review.

## Still required

Export the actual Copilot session transcript(s) in their original format into
this folder before submission.
