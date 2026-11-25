# Decisions

## Product and architecture

We kept the supplied Express/TypeScript server and React/Vite client. The
backend is organized by feature: authentication, conversations, grader,
messaging, and realtime. The browser uses same-origin API paths and an
HttpOnly, server-managed session cookie; it does not store OIDC tokens.
Workspace membership and roles come from the verified IdP token and are
checked by the server on API and WebSocket connections.

The simulator exposes customer phone numbers but no customer profiles, so the
inbox identifies contacts by number. Each conversation is scoped to one
workspace and contact. Inbound messages are ordered by Pigeon's `occurred_at`;
outbound messages use their locally recorded creation time.
Conversation lists and histories are currently capped at 100 and 500 items;
pagination is not implemented.

## Reliability and realtime

MongoDB stores conversations, messages, webhook deduplication records, and
the durable outbound queue. Unique indexes protect inbound provider message
IDs and outbound `client_ref`s. Replies are queued before returning `202` and
sent by a worker using the same Pigeon idempotency key on every attempt.
MongoDB leases allow another server copy to resume queued work. Redis shares
Pigeon retry-after windows across copies.

Redis also stores short-lived OIDC state and sessions, per-workspace event
sequences, and a bounded replay list. Redis pub/sub forwards events between
server copies. The UI refreshes inbox/message data after live events instead
of treating partial event frames as the source of truth.

## Frontend scope and cuts

The UI supports workspace selection, open/closed filters, conversation search,
message history, claiming, replies, read state, priority, and live updates.
Reply retries reuse the same `client_ref` while the same reply remains pending.
Search is client-side over the conversations already loaded; it is not
Elasticsearch-backed. Full-text search, encrypted private notes, and billing
were deferred to prioritize the inbox and reliability requirements.

## Known gaps and verification

The last full automated run scored 75/75 for levels 1, 2, 3, and 5, before the
final folder/UI integration changes. Level 5 was rerun after the backend
folder refactor and passed; after the latest UI/API fixes, server and web
TypeScript checks passed. The full harness was not rerun after those latest
changes, and Level 4's written contract cases are not run by the local
harness. Browser-level visual/integration testing is also still needed.

The project requires Node 22 or newer (`package.json`). Export the AI session
logs into `ai-logs/` and run the final full check on a supported Node version
before submission.
