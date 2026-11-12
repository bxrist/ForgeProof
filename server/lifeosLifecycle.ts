import { createHash } from "node:crypto";
import { z } from "zod";
import { verifySignature } from "./crypto";

export const projectIdSchema = z.string().max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/);
const label = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const lifecycleSchema = z.object({
  project: projectIdSchema,
  stage: z.enum(["source-write", "commit", "build", "deployment", "rollback"]),
  parents: z.array(z.number().int().positive()).max(256).default([]),
  observedAt: z.string().datetime(),
  commitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
  actor: z.object({ id: label, kind: z.enum(["human", "service", "agent"]) }).strict().optional(),
  tool: z.object({ name: label, version: label.optional() }).strict().optional(),
  model: z.object({ name: label, provider: label }).strict().optional(),
  evidenceUri: z.string().url().max(2048).optional(),
}).strict();
export type LifecycleInput = z.infer<typeof lifecycleSchema>;
const parentSchema = z.object({
  receiptId: z.number().int().positive(), entryHash: hash, evidenceHash: hash,
  stage: lifecycleSchema.shape.stage,
}).strict();
const payloadSchema = z.object({
  version: z.literal("forgeproof-lifeos-lifecycle-v1"),
  receiptId: z.number().int().positive(), entryHash: hash, artifactSha256: hash,
  project: projectIdSchema, stage: lifecycleSchema.shape.stage,
  parents: z.array(parentSchema).max(256),
  observedAt: z.string().datetime(),
  commitSha: lifecycleSchema.shape.commitSha,
  actor: lifecycleSchema.shape.actor,
  tool: lifecycleSchema.shape.tool,
  model: lifecycleSchema.shape.model,
  evidenceUri: lifecycleSchema.shape.evidenceUri,
}).strict();
const envelopeSchema = z.object({
  payload: payloadSchema, evidenceHash: hash, signature: z.string().min(1).max(256),
}).strict();
export type LifecycleEvidence = z.infer<typeof envelopeSchema>;
export type LifecycleReceipt = {
  id: number; userId: string; fileHash: string; entryHash: string;
  publicKey: string; metadata?: unknown;
};
export function canonicalLifecycle(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalLifecycle).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([,v]) => v !== undefined)
    .sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k,v]) => `${JSON.stringify(k)}:${canonicalLifecycle(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash("sha256").update(canonicalLifecycle(value)).digest("hex");
const signatureMessage = (evidenceHash: string) => `ForgeProof:LifeOS:lifecycle:v1\n${evidenceHash}`;
function invalid(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }

/** Metadata is not trusted merely because a caller named it lifecycleEvidence. */
export function verifyLifecycleEnvelope(receipt: LifecycleReceipt): LifecycleEvidence | null {
  const candidate = (receipt.metadata as Record<string, unknown> | null)?.lifecycleEvidence;
  if (candidate === undefined) return null;
  const parsed = envelopeSchema.safeParse(candidate);
  if (!parsed.success) invalid("Invalid lifecycle evidence");
  const evidence = parsed.data, p = evidence.payload;
  if (p.receiptId !== receipt.id || p.entryHash !== receipt.entryHash ||
      p.artifactSha256 !== receipt.fileHash || digest(p) !== evidence.evidenceHash ||
      !verifySignature(signatureMessage(evidence.evidenceHash), evidence.signature, receipt.publicKey))
    invalid("Lifecycle signature or receipt binding failed");
  return evidence;
}

export function checkLifecycleLinks(
  input: LifecycleInput, artifactHash: string, owner: string,
  parents: { receipt: LifecycleReceipt; evidence: LifecycleEvidence }[],
): void {
  if (!hash.safeParse(artifactHash).success) invalid("Lifecycle file_hash must be a bare lowercase SHA-256 digest");
  if (new Set(input.parents).size !== input.parents.length || parents.length !== input.parents.length)
    invalid("Duplicate or missing lifecycle parent");
  for (const p of parents) {
    if (p.receipt.userId !== owner || p.evidence.payload.project !== input.project)
      invalid("Lifecycle parent is not in the same account and project");
  }
  const stages = parents.map(p => p.evidence.payload.stage);
  const valid = input.stage === "source-write" ? stages.length === 0
    : input.stage === "commit" ? stages.length > 0 && stages.every(s => s === "source-write") && !!input.commitSha
    : input.stage === "build" ? stages.length === 1 && stages[0] === "commit"
    : input.stage === "deployment" ? stages.length === 1 && stages[0] === "build"
    : stages.length === 2 && stages.includes("deployment") && stages.includes("build");
  if (!valid) invalid("Invalid lifecycle stage linkage");
  if (input.stage === "deployment" || input.stage === "rollback") {
    const build = parents.find(p => p.evidence.payload.stage === "build")!;
    if (artifactHash !== build.evidence.payload.artifactSha256)
      invalid("Deployment or rollback artifact must match its linked build");
  }
  // A build's source commit cannot contradict its signed commit parent.
  if (input.stage === "build" && input.commitSha &&
      input.commitSha !== parents[0].evidence.payload.commitSha)
    invalid("Build commit does not match its parent");
}

/** Called inside the existing atomic receipt transaction, after ID/hash allocation. */
export async function signLifecycleEvidence(
  input: LifecycleInput, receipt: LifecycleReceipt,
  parents: { receipt: LifecycleReceipt; evidence: LifecycleEvidence }[],
  sign: (bytes: Buffer) => Promise<string>,
): Promise<LifecycleEvidence> {
  checkLifecycleLinks(input, receipt.fileHash, receipt.userId, parents);
  const payload = payloadSchema.parse({
    ...input, version: "forgeproof-lifeos-lifecycle-v1",
    receiptId: receipt.id, entryHash: receipt.entryHash, artifactSha256: receipt.fileHash,
    parents: parents.map(p => ({
      receiptId: p.receipt.id, entryHash: p.receipt.entryHash,
      evidenceHash: p.evidence.evidenceHash, stage: p.evidence.payload.stage,
    })),
  });
  const evidenceHash = digest(payload);
  return { payload, evidenceHash, signature: await sign(Buffer.from(signatureMessage(evidenceHash))) };
}

/** Verify the full bounded stage DAG from one already verified Git replay. */
export function verifyLifecycleGraph(id: number, read: (id: number) => LifecycleReceipt | undefined) {
  const cache = new Map<number, { receipt: LifecycleReceipt; evidence: LifecycleEvidence }>();
  const visit = (receiptId: number, depth: number): { receipt: LifecycleReceipt; evidence: LifecycleEvidence } => {
    if (depth > 4) invalid("Invalid lifecycle depth");
    const cached = cache.get(receiptId);
    if (cached) return cached;
    const receipt = read(receiptId);
    if (!receipt) invalid("Lifecycle parent not found");
    const evidence = verifyLifecycleEnvelope(receipt);
    if (!evidence) invalid("Receipt has no signed lifecycle evidence");
    const parents = evidence.payload.parents.map(link => {
      const parent = visit(link.receiptId, depth + 1);
      if (link.entryHash !== parent.receipt.entryHash || link.evidenceHash !== parent.evidence.evidenceHash ||
          link.stage !== parent.evidence.payload.stage) invalid("Lifecycle parent commitment mismatch");
      return parent;
    });
    checkLifecycleLinks({ ...evidence.payload, parents: evidence.payload.parents.map(p => p.receiptId) },
      receipt.fileHash, receipt.userId, parents);
    const result = { receipt, evidence };
    cache.set(receiptId, result);
    return result;
  };
  return visit(id, 0);
}
