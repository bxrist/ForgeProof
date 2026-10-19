import type { Request, Response, NextFunction } from "express";

const SENSITIVE_KEYS = /key|token|secret|password|authorization/i;
const API_KEY_PATTERN = /fp_sk_[A-Za-z0-9_-]+/g;

export function redact(value: any): any {
  if (typeof value === "string") {
    return value.replace(API_KEY_PATTERN, "[REDACTED]");
  }

  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message), stack: redact(value.stack) };
  }

  if (Array.isArray(value)) return value.map(redact);

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SENSITIVE_KEYS.test(key) ? "[REDACTED]" : redact(child),
      ]),
    );
  }

  return value;
}

function write(level: string, message: string, data?: unknown) {
  const output = [
    new Date().toISOString(),
    `[${level.toUpperCase()}]`,
    redact(message),
    ...(data === undefined ? [] : [JSON.stringify(redact(data))]),
  ].join(" ");

  const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
  console[method](output);
}

export const logger = {
  log: (message: string, data?: unknown) => write("info", message, data),
  info: (message: string, data?: unknown) => write("info", message, data),
  warn: (message: string, data?: unknown) => write("warn", message, data),
  error: (message: string, data?: unknown) => write("error", message, data),
};

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  res.on("finish", () => {
    if (!req.path.startsWith("/api")) return;

    logger.info(
      `${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`,
    );
  });

  next();
}