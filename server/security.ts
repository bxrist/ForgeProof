import { createHmac, timingSafeEqual } from "node:crypto";

export type ApiKeyPermission = "attest:read" | "attest:write";

export function hasApiKeyPermission(permissions: readonly string[] | null | undefined, required: ApiKeyPermission): boolean {
  return Array.isArray(permissions) && permissions.includes(required);
}

export function mcpToolPermission(tool: string): ApiKeyPermission {
  switch (tool) {
    case "forgeproof_lookup":
    case "forgeproof_verify_chain":
      return "attest:read";
    default:
      // Unknown tools never gain read-only authorization through name matching.
      return "attest:write";
  }
}

export function verifyGitHubWebhookSignature(rawBody: unknown, signature: unknown, secret: string | undefined): boolean {
  if (!secret || !Buffer.isBuffer(rawBody) || typeof signature !== "string" || !/^sha256=[0-9a-f]{64}$/.test(signature)) {
    return false;
  }
  const actual = Buffer.from(signature.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
