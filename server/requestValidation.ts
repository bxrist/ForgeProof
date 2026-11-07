import { z } from "zod";

export const attestRequestSchema = z.object({
  file_path: z.string(),
  file_hash: z.string(),
  model_name: z.string(),
  model_provider: z.string(),
  country_of_origin: z.string(),
  repository: z.string().optional(),
  file_name: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  attestation_type: z.enum(["origin", "security_audit", "refactor", "review"]).optional().default("origin"),
  parent_attestation_id: z.number().optional(),
  audit_verdict: z.enum(["secure", "flagged", "remediated", "needs_review"]).optional(),
  audit_details: z.string().optional(),
});

export const agentAttestSchema = z.object({
  files: z.array(z.object({
    file_path: z.string(),
    file_hash: z.string(),
    file_name: z.string().optional(),
  })),
  model_name: z.string(),
  model_provider: z.string(),
  country_of_origin: z.string(),
  repository: z.string().optional(),
  session_id: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

// Preserve the public Zod 3 issue format while validating with patched Zod 4.
export function requestValidationIssues(error: z.ZodError, input: unknown) {
  return error.issues.map((issue) => {
    const value = issue.path.reduce<unknown>((current, key) =>
      current != null && typeof current === "object"
        ? (current as Record<PropertyKey, unknown>)[key] : undefined, input);
    const received = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (issue.code === "invalid_type") {
      return {
        code: "invalid_type", expected: issue.expected, received,
        path: issue.path,
        message: value === undefined ? "Required" : `Expected ${issue.expected}, received ${received}`,
      };
    }
    if (issue.code === "invalid_value") {
      const options = issue.values;
      const expected = options.map((option) => `'${String(option)}'`).join(" | ");
      if (typeof value !== "string") {
        return {
          code: "invalid_type", expected, received, path: issue.path,
          message: value === undefined ? "Required" : `Expected ${expected}, received ${received}`,
        };
      }
      return {
        received: value, code: "invalid_enum_value", options, path: issue.path,
        message: `Invalid enum value. Expected ${expected}, received '${value}'`,
      };
    }
    return issue;
  });
}
