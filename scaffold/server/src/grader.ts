import { timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { config } from "./config.js";
import { getDb } from "./db.js";
import { enqueueReply } from "./outbox.js";
import { claimConversation, resetStore, workspaceIds } from "./store.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const requireGraderToken: RequestHandler = (req, res, next) => {
  const supplied = Buffer.from(req.header("x-grader-token") ?? "");
  const expected = Buffer.from(config.graderToken);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    res.sendStatus(401);
    return;
  }
  next();
};

function validWorkspace(value: unknown): value is string {
  return typeof value === "string" && workspaceIds.includes(value);
}

const router = Router();
router.use(requireGraderToken);

router.post("/reset", async (_req, res, next) => {
  try {
    await resetStore();
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

router.get("/snapshot", async (_req, res, next) => {
  try {
    const db = await getDb();
    const workspaces: Record<string, {
      contacts: Record<string, { inbound: string[]; assignee: string | null }>;
      outbound: Record<string, string>;
    }> = {};

    for (const workspace of workspaceIds) {
      workspaces[workspace] = { contacts: {}, outbound: {} };
    }

    const conversations = await db.collection("conversations").find({}).toArray();
    for (const conversation of conversations) {
      if (!validWorkspace(conversation.workspace) || typeof conversation.contact !== "string") continue;
      workspaces[conversation.workspace].contacts[conversation.contact] = {
        inbound: [],
        assignee: typeof conversation.assignee === "string" ? conversation.assignee : null,
      };
    }

    const inboundMessages = await db.collection("messages")
      .find({ direction: "inbound" })
      .sort({ createdAt: 1, _id: 1 })
      .toArray();
    for (const message of inboundMessages) {
      if (
        !validWorkspace(message.workspace) ||
        typeof message.contact !== "string" ||
        typeof message.providerMessageId !== "string"
      ) continue;

      const contacts = workspaces[message.workspace].contacts;
      contacts[message.contact] ??= { inbound: [], assignee: null };
      contacts[message.contact].inbound.push(message.providerMessageId);
    }

    const outboundMessages = await db.collection("messages")
      .find({ direction: "outbound" })
      .toArray();
    for (const message of outboundMessages) {
      if (
        validWorkspace(message.workspace) &&
        typeof message.clientRef === "string" &&
        typeof message.status === "string"
      ) {
        workspaces[message.workspace].outbound[message.clientRef] = message.status;
      }
    }

    res.json({ workspaces });
  } catch (error) {
    next(error);
  }
});

router.post("/claim", async (req, res, next) => {
  const { workspace, contact, agent } = isRecord(req.body) ? req.body : {};
  if (!validWorkspace(workspace) || typeof contact !== "string" || !contact || typeof agent !== "string" || !agent) {
    res.sendStatus(400);
    return;
  }

  try {
    const db = await getDb();
    const claimed = await claimConversation(db, workspace, contact, agent);
    res.sendStatus(claimed ? 200 : 409);
  } catch (error) {
    next(error);
  }
});

router.post("/reply", async (req, res, next) => {
  const { workspace, contact, text, client_ref: clientRef } = isRecord(req.body) ? req.body : {};
  if (
    !validWorkspace(workspace) ||
    typeof contact !== "string" ||
    !contact ||
    typeof text !== "string" ||
    !text.trim() ||
    typeof clientRef !== "string" ||
    !clientRef
  ) {
    res.sendStatus(400);
    return;
  }

  try {
    await enqueueReply(workspace, contact, text, clientRef);
    res.sendStatus(202);
  } catch (error) {
    next(error);
  }
});

export default router;
