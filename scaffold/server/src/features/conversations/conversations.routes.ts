import { Router, type Request, type Response } from "express";
import { getSession, hasWorkspace } from "../auth/auth.routes.js";
import { getDb } from "../../config/database.js";
import { enqueueReply } from "../messaging/outbox.worker.js";
import { publishWorkspaceEvent } from "../realtime/realtime.service.js";
import { claimConversation, workspaceIds } from "./conversations.store.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function authorizeWorkspace(
  req: Request,
  res: Response,
  workspace: unknown,
) {
  const session = await getSession(req);
  if (!session) {
    res.sendStatus(401);
    return null;
  }
  if (typeof workspace !== "string" || !workspaceIds.includes(workspace)) {
    res.sendStatus(400);
    return null;
  }
  if (!hasWorkspace(session, workspace)) {
    res.sendStatus(403);
    return null;
  }
  return { session, workspace };
}

export const conversationsRouter = Router();

conversationsRouter.get("/me", async (req, res, next) => {
  try {
    const session = await getSession(req);
    if (!session) {
      res.sendStatus(401);
      return;
    }
    res.json(session);
  } catch (error) {
    next(error);
  }
});

conversationsRouter.get("/conversations", async (req, res, next) => {
  try {
    const access = await authorizeWorkspace(req, res, req.query.workspace);
    if (!access) return;

    const state = req.query.state;
    if (state !== undefined && state !== "open" && state !== "closed") {
      res.sendStatus(400);
      return;
    }
    const filter: JsonRecord = { workspace: access.workspace };
    if (state) filter.state = state;
    const conversations = await (await getDb())
      .collection("conversations")
      .find(filter)
      .sort({ lastActivityAt: -1, createdAt: -1 })
      .limit(100)
      .toArray();
    res.json(conversations.map((conversation) => ({
      contact: conversation.contact,
      assignee: conversation.assignee ?? null,
      state: conversation.state ?? "open",
      unreadCount: conversation.unreadCount ?? 0,
      priority: conversation.priority ?? false,
      lastActivityAt: conversation.lastActivityAt ?? conversation.createdAt,
    })));
  } catch (error) {
    next(error);
  }
});

conversationsRouter.get("/conversations/:contact/messages", async (req, res, next) => {
  try {
    const access = await authorizeWorkspace(req, res, req.query.workspace);
    if (!access) return;

    const messages = await (await getDb())
      .collection("messages")
      .find({ workspace: access.workspace, contact: req.params.contact })
      .sort({ createdAt: 1, _id: 1 })
      .limit(500)
      .toArray();
    res.json(messages.map((message) => ({
      id: message.providerMessageId ?? message.clientRef,
      direction: message.direction,
      text: message.text,
      status: message.status,
      createdAt: message.createdAt,
      clientRef: message.clientRef,
    })));
  } catch (error) {
    next(error);
  }
});

conversationsRouter.post("/replies", async (req, res, next) => {
  const { workspace, contact, text, client_ref: clientRef } = isRecord(req.body) ? req.body : {};
  try {
    const access = await authorizeWorkspace(req, res, workspace);
    if (!access) return;
    if (
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

    await enqueueReply(access.workspace, contact, text, clientRef);
    await publishWorkspaceEvent(access.workspace, {
      type: "message.status",
      contact,
      client_ref: clientRef,
      status: "queued",
    });
    res.sendStatus(202);
  } catch (error) {
    next(error);
  }
});

conversationsRouter.post("/conversations/:contact/claim", async (req, res, next) => {
  const workspace = isRecord(req.body) ? req.body.workspace : undefined;
  try {
    const access = await authorizeWorkspace(req, res, workspace);
    if (!access) return;
    const claimed = await claimConversation(
      await getDb(),
      access.workspace,
      req.params.contact,
      access.session.sub,
    );
    if (claimed) {
      await publishWorkspaceEvent(access.workspace, {
        type: "conversation.assigned",
        contact: req.params.contact,
        assignee: access.session.sub,
      });
    }
    res.sendStatus(claimed ? 200 : 409);
  } catch (error) {
    next(error);
  }
});

conversationsRouter.post("/conversations/:contact/read", async (req, res, next) => {
  const workspace = isRecord(req.body) ? req.body.workspace : undefined;
  try {
    const access = await authorizeWorkspace(req, res, workspace);
    if (!access) return;
    await (await getDb()).collection("conversations").updateOne(
      { workspace: access.workspace, contact: req.params.contact },
      { $set: { unreadCount: 0, updatedAt: new Date() } },
    );
    await publishWorkspaceEvent(access.workspace, {
      type: "conversation.read",
      contact: req.params.contact,
      agent: access.session.sub,
    });
    res.sendStatus(200);
  } catch (error) {
    next(error);
  }
});

conversationsRouter.patch("/conversations/:contact/priority", async (req, res, next) => {
  const workspace = isRecord(req.body) ? req.body.workspace : undefined;
  const priority = isRecord(req.body) ? req.body.priority : undefined;
  try {
    const access = await authorizeWorkspace(req, res, workspace);
    if (!access) return;
    if (typeof priority !== "boolean") {
      res.sendStatus(400);
      return;
    }
    const result = await (await getDb()).collection("conversations").updateOne(
      { workspace: access.workspace, contact: req.params.contact },
      { $set: { priority, updatedAt: new Date() } },
    );
    if (result.matchedCount) {
      await publishWorkspaceEvent(access.workspace, {
        type: "conversation.priority",
        contact: req.params.contact,
        priority,
      });
    }
    res.sendStatus(result.matchedCount ? 200 : 404);
  } catch (error) {
    next(error);
  }
});

conversationsRouter.patch("/conversations/:contact/state", async (req, res, next) => {
  const workspace = isRecord(req.body) ? req.body.workspace : undefined;
  const state = isRecord(req.body) ? req.body.state : undefined;
  try {
    const access = await authorizeWorkspace(req, res, workspace);
    if (!access) return;
    if (state !== "open" && state !== "closed") {
      res.sendStatus(400);
      return;
    }
    const result = await (await getDb()).collection("conversations").updateOne(
      { workspace: access.workspace, contact: req.params.contact },
      { $set: { state, updatedAt: new Date() } },
    );
    if (result.matchedCount) {
      await publishWorkspaceEvent(access.workspace, {
        type: "conversation.updated",
        contact: req.params.contact,
        state,
      });
    }
    res.sendStatus(result.matchedCount ? 200 : 404);
  } catch (error) {
    next(error);
  }
});
