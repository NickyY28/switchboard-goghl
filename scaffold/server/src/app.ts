import express from "express";
import { authRouter } from "./features/auth/auth.routes.js";
import { conversationsRouter } from "./features/conversations/conversations.routes.js";
import graderRouter from "./features/grader/grader.routes.js";
import { pigeonWebhook } from "./features/messaging/pigeon-webhook.routes.js";
import { errorMiddleware } from "./middlewares/error.middleware.js";

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
app.use("/api", conversationsRouter);
app.use("/__grader", graderRouter);
app.use(errorMiddleware);

export function markReady(): void {
  ready = true;
}

export default app;
