import { getDb } from "../../config/database.js";
import type { Db } from "mongodb";
import { config } from "../../config/env.js";
import { getRedis } from "../../config/redis.js";

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

export async function claimConversation(
  db: Db,
  workspace: string,
  contact: string,
  agent: string,
): Promise<boolean> {
  await ensureConversation(db, workspace, contact);
  const result = await db.collection("conversations").updateOne(
    { workspace, contact, $or: [{ assignee: null }, { assignee: agent }] },
    { $set: { assignee: agent, updatedAt: new Date() } },
  );
  if (result.matchedCount > 0) return true;
  const current = await db.collection("conversations").findOne({ workspace, contact });
  return current?.assignee === agent;
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
