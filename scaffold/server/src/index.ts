import express from "express";
import { createServer } from "node:http";
import { config } from "./config.js";
import { initializeStore } from "./store.js";

const app = express();
let ready = false;

app.get("/healthz", (_req, res) => {
  res.status(ready ? 200 : 503).json({ ok: ready });
});

// Everything else is yours.

const server = createServer(app);

async function start(): Promise<void> {
  await initializeStore();
  server.listen(config.port, () => {
    ready = true;
    console.log(`server on http://localhost:${config.port}`);
  });
}

start().catch((error: unknown) => {
  console.error("server startup failed", error);
  process.exitCode = 1;
});
