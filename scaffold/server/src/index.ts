import express from "express";
import { createServer } from "node:http";
import { config } from "./config.js";
import graderRouter from "./grader.js";
import { startOutboxWorker } from "./outbox.js";
import { pigeonWebhook } from "./pigeon-webhook.js";
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
app.use("/__grader", graderRouter);

// Everything else is yours.

const server = createServer(app);

async function start(): Promise<void> {
  await initializeStore();
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
