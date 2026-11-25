import express from "express";
import { createServer } from "node:http";
import { apiRouter } from "./api.js";
import { authRouter } from "./auth.js";
import { config } from "./config.js";
import graderRouter from "./grader.js";
import { startOutboxWorker } from "./outbox.js";
import { pigeonWebhook } from "./pigeon-webhook.js";
import { startRealtime } from "./realtime.js";
import { initializeStore } from "./store.js";

const app = express();
let ready = false;

app.post(
  "/webhooks/pigeon",
  express.raw({ type: "application/json", limit: "1mb" }),
  pigeonWebhook,
);
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.status(ready ? 200 : 503).json({ ok: ready });
});
app.use("/auth", authRouter);
app.use("/api", apiRouter);
app.use("/__grader", graderRouter);
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("request failed", error);
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number" &&
    error.status >= 400 &&
    error.status < 500
      ? error.status
      : 500;
  res.status(status).json({ error: status < 500 ? "invalid_request" : "internal_server_error" });
});

// Everything else is yours.

const server = createServer(app);

async function start(): Promise<void> {
  await initializeStore();
  await startRealtime(server);
  startOutboxWorker();
  server.listen(config.port, () => {
    ready = true;
    console.log(`server on http://localhost:${config.port}`);
  });
}

start().catch((error: unknown) => {
  console.error("server startup failed", error);
  process.exitCode = 1;
});
