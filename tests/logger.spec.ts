import { test, expect } from "@playwright/test";
import { EventEmitter } from "node:events";
import { redact, requestLogger } from "../server/logger";

test("request log does not include the response body", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);

  try {
    const req = { method: "POST", path: "/api/api-keys" } as any;
    const res = Object.assign(new EventEmitter(), { statusCode: 200 }) as any;

    requestLogger(req, res, () => {});
    res.emit("finish");
  } finally {
    console.log = original;
  }

  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("POST /api/api-keys 200");
  expect(lines[0]).not.toContain("fp_sk_");
});

test("redact hides sensitive fields", () => {
  const out = JSON.stringify(redact({ name: "ci", fullKey: "fp_sk_abc123", user: { githubToken: "gho_x" } }));

  expect(out).not.toContain("fp_sk_abc123");
  expect(out).not.toContain("gho_x");
  expect(out).toContain('"name":"ci"');
});

test("redact masks API keys inside strings", () => {
  expect(redact("bad key fp_sk_abc123")).toBe("bad key [REDACTED]");
});

test("redact keeps error message and stack", () => {
  const out = redact(new Error("boom"));

  expect(out.message).toBe("boom");
  expect(out.stack).toContain("boom");
});
