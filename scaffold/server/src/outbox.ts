import { randomUUID } from "node:crypto";
import type { ObjectId } from "mongodb";
import { getDb } from "./db.js";
import { config } from "./config.js";
import { getRedis } from "./redis.js";
import { ensureConversation, workspaceIds } from "./store.js";

type JsonRecord = Record<string, unknown>;

type OutboundMessage = {
  _id: ObjectId;
  workspace: string;
  contact: string;
  text: string;
  clientRef: string;
  attempts?: number;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}

export async function enqueueReply(
  workspace: string,
  contact: string,
  text: string,
  clientRef: string,
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  await ensureConversation(db, workspace, contact);

  try {
    await db.collection("messages").insertOne({
      workspace,
      contact,
      direction: "outbound",
      clientRef,
      text,
      status: "queued",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
    });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }
}

async function attemptSend(
  message: OutboundMessage,
  workerId: string,
): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const claimed = await db.collection("messages").updateOne(
    {
      _id: message._id,
      direction: "outbound",
      status: "queued",
      nextAttemptAt: { $lte: now },
      $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }],
    },
    {
      $set: { leaseOwner: workerId, leaseUntil: new Date(now.getTime() + 20_000) },
      $inc: { attempts: 1 },
    },
  );
  if (claimed.modifiedCount !== 1) return;

  const apiKey = config.pigeon.apiKeys[message.workspace];
  if (!apiKey || !workspaceIds.includes(message.workspace)) {
    await db.collection("messages").updateOne(
      { _id: message._id, leaseOwner: workerId, status: "queued" },
      { $set: { status: "failed", failure: "Unknown workspace" }, $unset: { leaseOwner: "", leaseUntil: "" } },
    );
    return;
  }

  const retryKey = `pigeon:retry-after:${message.workspace}`;
  const retryUntil = Number(await getRedis().get(retryKey));
  if (Number.isFinite(retryUntil) && retryUntil > Date.now()) {
    await db.collection("messages").updateOne(
      { _id: message._id, leaseOwner: workerId, status: "queued" },
      {
        $set: { nextAttemptAt: new Date(retryUntil) },
        $unset: { leaseOwner: "", leaseUntil: "" },
      },
    );
    return;
  }

  let response: Response;
  try {
    response = await fetch(`${config.pigeon.url}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": message.clientRef,
      },
      body: JSON.stringify({
        to: message.contact,
        text: message.text,
        client_ref: message.clientRef,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const attempts = typeof message.attempts === "number" ? message.attempts + 1 : 1;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(attempts, 6));
    await db.collection("messages").updateOne(
      { _id: message._id, leaseOwner: workerId, status: "queued" },
      {
        $set: { nextAttemptAt: new Date(Date.now() + delay), lastError: String(error) },
        $unset: { leaseOwner: "", leaseUntil: "" },
      },
    );
    return;
  }

  if (response.status === 429 || response.status === 503) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const attempts = typeof message.attempts === "number" ? message.attempts + 1 : 1;
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.ceil(retryAfter * 1000)
      : Math.min(30_000, 500 * 2 ** Math.min(attempts, 6));
    if (response.status === 429) {
      await getRedis().set(retryKey, String(Date.now() + delay), "PX", delay);
    }
    await db.collection("messages").updateOne(
      { _id: message._id, leaseOwner: workerId, status: "queued" },
      {
        $set: { nextAttemptAt: new Date(Date.now() + delay), lastError: `Pigeon ${response.status}` },
        $unset: { leaseOwner: "", leaseUntil: "" },
      },
    );
    return;
  }

  if (!response.ok) {
    await db.collection("messages").updateOne(
      { _id: message._id, leaseOwner: workerId, status: "queued" },
      {
        $set: { status: "failed", failure: `Pigeon ${response.status}` },
        $unset: { leaseOwner: "", leaseUntil: "" },
      },
    );
    return;
  }

  const result: unknown = await response.json();
  const providerMessageId = isRecord(result) && typeof result.id === "string" ? result.id : undefined;
  await db.collection("messages").updateOne(
    { _id: message._id, leaseOwner: workerId, status: "queued" },
    {
      $set: {
        status: "sent",
        ...(providerMessageId ? { providerMessageId } : {}),
        sentAt: new Date(),
      },
      $unset: { leaseOwner: "", leaseUntil: "", lastError: "" },
    },
  );
}

export function startOutboxWorker(): void {
  const workerId = randomUUID();
  let running = false;

  const poll = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const db = await getDb();
      const now = new Date();
      const due = await db.collection("messages")
        .find({
          direction: "outbound",
          status: "queued",
          nextAttemptAt: { $lte: now },
          $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }],
        })
        .sort({ createdAt: 1 })
        .limit(10)
        .toArray();

      for (const message of due) {
        if (
          typeof message.workspace !== "string" ||
          typeof message.contact !== "string" ||
          typeof message.text !== "string" ||
          typeof message.clientRef !== "string"
        ) continue;
        try {
          await attemptSend({
            _id: message._id,
            workspace: message.workspace,
            contact: message.contact,
            text: message.text,
            clientRef: message.clientRef,
            attempts: typeof message.attempts === "number" ? message.attempts : undefined,
          }, workerId);
        } catch (error) {
          console.error("outbox send failed", error);
        }
      }
    } catch (error) {
      console.error("outbox poll failed", error);
    } finally {
      running = false;
    }
  };

  void poll();
  setInterval(() => void poll(), 250);
}
