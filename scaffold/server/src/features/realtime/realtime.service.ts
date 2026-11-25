import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { getSessionFromCookie, hasWorkspace } from "../auth/auth.routes.js";
import { getRedis } from "../../config/redis.js";
import { workspaceIds } from "../conversations/conversations.store.js";

type EventFrame = Record<string, unknown> & { seq: number };
type ClientState = {
  socket: WebSocket;
  workspace: string;
  replaying: boolean;
  lastSeq: number;
  buffered: EventFrame[];
};

function isEventFrame(value: unknown): value is EventFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    "seq" in value &&
    typeof value.seq === "number" &&
    "type" in value &&
    typeof value.type === "string"
  );
}

const clients = new Set<ClientState>();
const webSocketServer = new WebSocketServer({ noServer: true });

function keys(workspace: string) {
  return {
    sequence: `switchboard:sequence:${workspace}`,
    events: `switchboard:events:${workspace}`,
    channel: `switchboard:live:${workspace}`,
  };
}

function rejectUpgrade(socket: Duplex, status: number): void {
  const reason = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Bad Request";
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function sendFrame(client: ClientState, frame: EventFrame): void {
  if (client.socket.readyState !== WebSocket.OPEN || frame.seq <= client.lastSeq) return;
  client.socket.send(JSON.stringify(frame));
  client.lastSeq = frame.seq;
}

async function replay(client: ClientState): Promise<void> {
  const { events } = keys(client.workspace);
  const stored = await getRedis().lrange(events, 0, -1);
  const frames: EventFrame[] = [];
  for (const raw of stored) {
    try {
      const frame: unknown = JSON.parse(raw);
      if (isEventFrame(frame) && frame.seq > client.lastSeq) frames.push(frame);
    } catch (error) {
      console.error("invalid realtime event in Redis", error);
    }
  }

  frames.sort((a, b) => a.seq - b.seq);
  for (const frame of frames) sendFrame(client, frame);
  client.buffered.sort((a, b) => a.seq - b.seq);
  for (const frame of client.buffered) sendFrame(client, frame);
  client.buffered = [];
  client.replaying = false;
}

async function handleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname !== "/ws") {
    rejectUpgrade(socket, 400);
    return;
  }

  const workspace = url.searchParams.get("workspace");
  if (!workspace || !workspaceIds.includes(workspace)) {
    rejectUpgrade(socket, 400);
    return;
  }
  const afterValue = url.searchParams.get("after");
  let after = afterValue === null ? undefined : Number(afterValue);
  if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) {
    rejectUpgrade(socket, 400);
    return;
  }

  const session = await getSessionFromCookie(request.headers.cookie);
  if (!session) {
    rejectUpgrade(socket, 401);
    return;
  }
  if (!hasWorkspace(session, workspace)) {
    rejectUpgrade(socket, 403);
    return;
  }

  if (after === undefined) {
    const currentSequence = await getRedis().get(keys(workspace).sequence);
    after = currentSequence === null ? 0 : Number(currentSequence);
  }

  webSocketServer.handleUpgrade(request, socket, head, (clientSocket) => {
    const state: ClientState = {
      socket: clientSocket,
      workspace,
      replaying: true,
      lastSeq: after,
      buffered: [],
    };
    clients.add(state);
    clientSocket.on("close", () => clients.delete(state));
    clientSocket.on("error", (error) => {
      console.error("websocket connection failed", error);
      clients.delete(state);
    });
    void replay(state).catch((error: unknown) => {
      console.error("websocket replay failed", error);
      clientSocket.close(1011, "Replay failed");
    });
  });
}

export async function startRealtime(server: Server): Promise<void> {
  const subscriber = getRedis().duplicate();
  subscriber.on("error", (error) => console.error("realtime Redis subscriber failed", error));
  subscriber.on("message", (channel, raw) => {
    let frame: unknown;
    try {
      frame = JSON.parse(raw) as unknown;
    } catch (error) {
      console.error("invalid realtime message", error);
      return;
    }
    if (!isEventFrame(frame)) {
      console.error("invalid realtime frame");
      return;
    }
    for (const client of clients) {
      if (keys(client.workspace).channel !== channel) continue;
      if (client.replaying) client.buffered.push(frame);
      else sendFrame(client, frame);
    }
  });

  await subscriber.subscribe(...workspaceIds.map((workspace) => keys(workspace).channel));

  server.on("upgrade", (request, socket, head) => {
    void handleUpgrade(request, socket, head).catch((error: unknown) => {
      console.error("websocket upgrade failed", error);
      rejectUpgrade(socket, 500);
    });
  });
}

export async function publishWorkspaceEvent(
  workspace: string,
  event: Record<string, unknown>,
): Promise<void> {
  const { sequence, events, channel } = keys(workspace);
  const script = [
    "local seq = redis.call('INCR', KEYS[1])",
    "local frame = cjson.decode(ARGV[1])",
    "frame.seq = seq",
    "local encoded = cjson.encode(frame)",
    "redis.call('RPUSH', KEYS[2], encoded)",
    "redis.call('LTRIM', KEYS[2], -5000, -1)",
    "redis.call('PUBLISH', KEYS[3], encoded)",
    "return encoded",
  ].join("\n");
  await getRedis().eval(script, 3, sequence, events, channel, JSON.stringify(event));
}
