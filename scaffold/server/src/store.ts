import { getDb } from "./db.js";

export async function initializeStore(): Promise<void> {
  const db = await getDb();

  await Promise.all([
    db.collection("conversations").createIndex(
      { workspace: 1, contact: 1 },
      { unique: true },
    ),
    db.collection("messages").createIndex(
      { workspace: 1, providerMessageId: 1 },
      {
        unique: true,
        partialFilterExpression: { direction: "inbound", providerMessageId: { $type: "string" } },
      },
    ),
    db.collection("messages").createIndex(
      { workspace: 1, clientRef: 1 },
      {
        unique: true,
        partialFilterExpression: { direction: "outbound", clientRef: { $type: "string" } },
      },
    ),
    db.collection("webhook_events").createIndex({ eventId: 1 }, { unique: true }),
    db.collection("messages").createIndex({ workspace: 1, status: 1, nextAttemptAt: 1 }),
  ]);
}
