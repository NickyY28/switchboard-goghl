import type { ErrorRequestHandler } from "express";

export const errorMiddleware: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
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
};
