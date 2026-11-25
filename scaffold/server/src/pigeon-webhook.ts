import { createHmac, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { config } from "./config.js";
import { getDb } from "./db.js";

type JsonRecord = Record<string, unknown>;

class InvalidWebhookPayload extends Error {}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function verifySignature(rawBody: Buffer, header: string | undefined): boolean {
  const match = header?.match(/^t=(\d+),v1=([a-f\d]{64})$/i);
  if (!match) return false;

  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) {
    return false;
  }

  const expected = createHmac("sha256", config.pigeon.webhookSecret)
    .update(`${match[1]}.${rawBody.toString("utf8")}`)
    .digest();
  const supplied = Buffer.from(match[2], "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isDuplicateKey(error: unknown): boolean {
  return isRecord(error) && error.code === 11000;
}

async function saveInbound(
  workspace: string,
  eventId: string,
  occurredAt: Date,
  data: JsonRecord,
): Promise<void> {
  const messageId = data.message_id;
  const contact = data.from;
  const text = data.text;
  if (
    typeof messageId !== "string" ||
    typeof contact !== "string" ||
    typeof text !== "string"
  ) {
    throw new InvalidWebhookPayload("Invalid inbound message payload");
  }

  const db = await getDb();
  let inserted = true;
  try {
    await db.collection("messages").insertOne({
      workspace,
      contact,
      direction: "inbound",
      providerMessageId: messageId,
      text,
      status: "received",
      createdAt: occurredAt,
    });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    inserted = false;
  }

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
        createdAt: occurredAt,
      },
      $max: { lastActivityAt: occurredAt },
      ...(inserted ? { $inc: { unreadCount: 1 } } : {}),
    },
    { upsert: true },
  );

  await db.collection("webhook_events").insertOne({
    eventId,
    workspace,
    type: "message.inbound",
    receivedAt: new Date(),
  }).catch((error: unknown) => {
    if (!isDuplicateKey(error)) throw error;
  });
}

async function saveStatus(
  workspace: string,
  eventId: string,
  data: JsonRecord,
): Promise<void> {
  const clientRef = data.client_ref;
  const status = data.status;
  if (typeof clientRef !== "string" || !["sent", "delivered", "failed"].includes(String(status))) {
    throw new InvalidWebhookPayload("Invalid message status payload");
  }

  const db = await getDb();
  const message = await db.collection("messages").findOne({
    workspace,
    clientRef,
    direction: "outbound",
  });

  if (message) {
    const allowedPrevious = status === "sent" ? ["queued"] : ["queued", "sent"];
    await db.collection("messages").updateOne(
      { _id: message._id, status: { $in: allowedPrevious } },
      { $set: { status, statusUpdatedAt: new Date() } },
    );
  }

  await db.collection("webhook_events").insertOne({
    eventId,
    workspace,
    type: "message.status",
    receivedAt: new Date(),
  }).catch((error: unknown) => {
    if (!isDuplicateKey(error)) throw error;
  });
}

export const pigeonWebhook: RequestHandler = async (req, res, next) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : undefined;
  if (!rawBody || !verifySignature(rawBody, req.header("x-pigeon-signature"))) {
    res.sendStatus(401);
    return;
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody.toString("utf8")) as unknown;
  } catch {
    res.sendStatus(400);
    return;
  }

  if (!isRecord(event) || typeof event.id !== "string" || typeof event.workspace !== "string") {
    res.sendStatus(400);
    return;
  }

  const eventId = event.id;
  const workspace = event.workspace;
  if (!Object.hasOwn(config.pigeon.apiKeys, workspace)) {
    res.sendStatus(200);
    return;
  }

  try {
    const db = await getDb();
    const existing = await db.collection("webhook_events").findOne({ eventId });
    if (existing) {
      res.sendStatus(200);
      return;
    }

    if (event.type === "message.inbound" || event.type === "message.status") {
      if (!isRecord(event.data)) {
        res.sendStatus(400);
        return;
      }

      const occurredAt =
        typeof event.occurred_at === "string" ? new Date(event.occurred_at) : new Date();
      if (Number.isNaN(occurredAt.getTime())) {
        res.sendStatus(400);
        return;
      }

      if (event.type === "message.inbound") {
        await saveInbound(workspace, eventId, occurredAt, event.data);
      } else {
        await saveStatus(workspace, eventId, event.data);
      }
    } else {
      await db.collection("webhook_events").insertOne({
        eventId,
        workspace,
        type: event.type,
        receivedAt: new Date(),
      }).catch((error: unknown) => {
        if (!isDuplicateKey(error)) throw error;
      });
    }

    res.sendStatus(200);
  } catch (error) {
    if (error instanceof InvalidWebhookPayload) {
      res.sendStatus(400);
      return;
    }
    next(error);
  }
};
