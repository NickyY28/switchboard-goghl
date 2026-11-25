import { getDb } from "./db.js";
import type { Db } from "mongodb";
import { config } from "./config.js";
import { getRedis } from "./redis.js";

export const workspaceIds = Object.keys(config.pigeon.apiKeys);

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}

export async function ensureConversation(
  db: Db,
  workspace: string,
  contact: string,
): Promise<void> {
  try {
    await db.collection("conversations").updateOne(
      { workspace, contact },
      {
        $setOnInsert: {
          workspace,
          contact,
          assignee: null,
          state: "open",
          unreadCount: 0,
          priority: false,
          createdAt: new Date(),
          lastActivityAt: new Date(0),
        },
      },
      { upsert: true },
    );
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
}

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

export async function resetStore(): Promise<void> {
  const db = await getDb();
  await Promise.all([
    db.collection("conversations").deleteMany({}),
    db.collection("messages").deleteMany({}),
    db.collection("webhook_events").deleteMany({}),
    getRedis().flushdb(),
  ]);
}
