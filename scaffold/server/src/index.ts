import { createServer } from "node:http";
import app, { markReady } from "./app.js";
import { config } from "./config/env.js";
import { initializeDatabase } from "./config/database.js";
import { startOutboxWorker } from "./features/messaging/outbox.worker.js";
import { startRealtime } from "./features/realtime/realtime.service.js";

const server = createServer(app);

async function start(): Promise<void> {
  await initializeDatabase();
  await startRealtime(server);
  startOutboxWorker();
  server.listen(config.port, () => {
    markReady();
    console.log(`Switchboard server on http://localhost:${config.port}`);
  });
}

start().catch((error: unknown) => {
  console.error("server startup failed", error);
  process.exitCode = 1;
});
