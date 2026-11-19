import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  providerResidencyGuaranteeSchema, lifecycleSchema,
  signLifecycleEvidence, verifyLifecycleEnvelope, checkLifecycleLinks,
} from "../server/lifeosLifecycle";

const evidence = {
  servingPlatform: "openai-api" as const,
  geographyType: "country" as const,
  geography: "US",
  routingProfile: "us.api.openai.com",
  providerPolicyUrl: "https://developers.openai.com/api/docs/guides/data-residency",
  configurationSha256: "a".repeat(64),
  invocationSha256: "d".repeat(64),
  invokedAt: "2026-11-18T20:00:00Z",
};

describe("provider-documented regional processing guarantee", () => {
  it("accepts only official platform policy evidence and a regional invocation", () => {
    expect(providerResidencyGuaranteeSchema.parse(evidence).geography).toBe("US");
    expect(providerResidencyGuaranteeSchema.safeParse({
      ...evidence, servingPlatform: "aws-bedrock",
      geography: "EU", geographyType: "regional-area",
      routingProfile: "eu.anthropic.claude-sonnet",
      providerPolicyUrl: "https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html",
    }).success).toBe(true);
    for (const changed of [
      { providerPolicyUrl: "https://developers.openai.com.evil.test/policy" },
      { providerPolicyUrl: "http://developers.openai.com/api/docs/guides/data-residency" },
      { providerPolicyUrl: "https://docs.aws.amazon.com/bedrock/" },
      { routingProfile: "global" },
      { configurationSha256: "not-a-hash" },
      { invocationSha256: "not-a-hash" },
    ]) {
      expect(providerResidencyGuaranteeSchema.safeParse({ ...evidence, ...changed }).success).toBe(false);
    }
  });

  it("cryptographically binds country/region, provider policy and request identity to a source receipt", async () => {
    const keys = generateKeyPairSync("ed25519");
    const receipt = {
      id: 123, userId: "scoped-project-service",
      fileHash: "b".repeat(64), entryHash: "c".repeat(64),
      publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    };
    const lifecycle = lifecycleSchema.parse({
      project: "bxrist/ForgeProof", stage: "source-write", parents: [],
      observedAt: "2026-11-18T20:00:00Z", model: { name: "eligible-model-name", provider: "OpenAI" },
      providerResidencyGuarantee: evidence,
    });
    const signed = await signLifecycleEvidence(lifecycle, receipt, [],
      async bytes => sign(null, bytes, keys.privateKey).toString("base64"));
    const complete = { ...receipt, metadata: { lifecycleEvidence: signed } };
    expect(verifyLifecycleEnvelope(complete)?.payload.providerResidencyGuarantee).toEqual(evidence);

    for (const field of ["geography", "providerPolicyUrl", "invocationSha256", "configurationSha256"]) {
      const altered = structuredClone(complete);
      (altered.metadata.lifecycleEvidence.payload.providerResidencyGuarantee as Record<string, string>)[field] = "tampered";
      expect(() => verifyLifecycleEnvelope(altered)).toThrow();
    }
  });

  it("rejects unsupported stages and missing model rather than fabricating geographic provenance", () => {
    const base = lifecycleSchema.parse({
      project: "bxrist/ForgeProof", stage: "source-write", parents: [],
      observedAt: "2026-11-18T20:00:00Z", providerResidencyGuarantee: evidence,
    });
    expect(() => checkLifecycleLinks(base, "b".repeat(64), "service", [])).toThrow(/requires a source-write model/);
    const notSource = lifecycleSchema.parse({
      ...base, stage: "commit", parents: [],
      model: { name: "eligible-model-name", provider: "OpenAI" },
      commitSha: "c".repeat(40),
    });
    expect(() => checkLifecycleLinks(notSource, "b".repeat(64), "service", [])).toThrow(/requires a source-write model/);
    const withoutGuarantee = lifecycleSchema.parse({
      project: "bxrist/ForgeProof", stage: "source-write", parents: [],
      observedAt: "2026-11-18T20:00:00Z",
    });
    expect(() => checkLifecycleLinks(withoutGuarantee, "b".repeat(64), "service", [])).not.toThrow();
  });
});
