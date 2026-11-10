import { createHash, createPublicKey } from "crypto";
import { getGitHubClient } from "./github";
import { getKeyPair, hasPinnedDurableSigner, sha256, signData, verifySignature } from "./crypto";
import { toPublicReceipt } from "./publicReceipt";
import { forbiddenStagingSigner } from "./stagingSignerPolicy";

const LEDGER_OWNER = "bxrist";
const LEDGER_REPOSITORY = "ForgeProof-Evidence";
const LEDGER_REPOSITORY_ID = 1449691718;
const CHECKPOINT_PATH = "ledger/checkpoint.json";

export type GitLedgerConfig = {
  branch: string;
  repositoryLabel: string;
  baseCommit: string;
  baseEventHash: string;
  baseSequence: number;
  baseReceiptId: number;
  baseReceiptEntryHash: string;
  signerKeyId: string;
  reconciliationDigest?: string;
  receiptSignerPin?: string;
  // Independent historical verification key; never a private signing key.
  reconciliationSignerPublicKey?: string;
};

export type LedgerState = {
  baseReceiptId: number;
  sequence: number;
  eventHash: string;
  receiptEntryHash: string;
  commitSha: string;
  signerKeyId: string;
};

export type LedgerReceipt = {
  id: number;
  fileName: string;
  filePath: string;
  fileHash: string;
  entryHash: string;
  prevEntryHash: string | null;
  signatureValid: boolean;
  hashMatch: boolean;
  complianceStatus: string | null;
  detectedCountry: string | null;
  countryOfOrigin: string;
  modelName: string;
  modelProvider: string;
  signature: string;
  publicKey: string;
  receiptVersion: string;
  createdAt: string | null;
  signedAt: string | null;
};

export type LedgerOutboxItem = {
  id: number;
  receiptId: number;
  eventId: string;
  payload: LedgerReceipt;
  payloadHash: string;
};

export class GitLedgerError extends Error {
  readonly status = 503;
  constructor(
    message: string,
    readonly permanent = true,
    readonly code = "ledger_unavailable",
  ) {
    super(message);
    this.name = "GitLedgerError";
  }
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function gitLedgerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FORGEPROOF_GIT_LEDGER_ENABLED === "true";
}

export function getGitLedgerConfig(env: NodeJS.ProcessEnv = process.env): GitLedgerConfig | null {
  if (!gitLedgerEnabled(env)) return null;
  const branch = env.FORGEPROOF_GIT_LEDGER_BRANCH || "";
  const repositoryLabel = env.FORGEPROOF_GIT_LEDGER_REPOSITORY_LABEL || "";
  const baseCommit = env.FORGEPROOF_GIT_LEDGER_BASE_COMMIT || "";
  const baseEventHash = env.FORGEPROOF_GIT_LEDGER_BASE_EVENT_HASH || "";
  const baseSequenceRaw = env.FORGEPROOF_GIT_LEDGER_BASE_SEQUENCE || "";
  const baseReceiptIdRaw = env.FORGEPROOF_GIT_LEDGER_BASE_RECEIPT_ID || "";
  const baseReceiptEntryHash = env.FORGEPROOF_GIT_LEDGER_BASE_RECEIPT_ENTRY_HASH || "";
  const signerKeyId = env.FORGEPROOF_GIT_LEDGER_SIGNER_KEY_ID || "";
  const reconciliationDigest = env.FORGEPROOF_GIT_LEDGER_RECONCILIATION_DIGEST;
  const receiptSignerPin = env.FORGEPROOF_GIT_LEDGER_RECEIPT_SIGNER_PIN;

  if (!/^forgeproof\/[A-Za-z0-9._/-]{1,180}$/.test(branch) || branch.includes("..")) {
    throw new GitLedgerError("Git ledger branch configuration is invalid", true, "invalid_config");
  }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repositoryLabel)) {
    throw new GitLedgerError("Git ledger repository label is invalid", true, "invalid_config");
  }
  if (!/^[0-9a-f]{40}$/.test(baseCommit) ||
      !/^[0-9a-f]{64}$/.test(baseEventHash) ||
      !/^[0-9a-f]{64}$/.test(baseReceiptEntryHash) ||
      !/^[0-9a-f]{64}$/.test(signerKeyId)) {
    throw new GitLedgerError("Git ledger checkpoint configuration is incomplete", true, "invalid_config");
  }
  const baseSequence = Number(baseSequenceRaw);
  const baseReceiptId = Number(baseReceiptIdRaw);
  if (!Number.isSafeInteger(baseSequence) || baseSequence < 1 ||
      !Number.isSafeInteger(baseReceiptId) || baseReceiptId < 1) {
    throw new GitLedgerError("Git ledger checkpoint configuration is invalid", true, "invalid_config");
  }
  if (baseReceiptId > 45 && (!/^[0-9a-f]{64}$/.test(reconciliationDigest || "") ||
      !/^[0-9a-f]{64}$/.test(receiptSignerPin || ""))) {
    throw new GitLedgerError("Advancing beyond the historical archive requires independently pinned tail evidence", true, "tail_pin_required");
  }
  return {
    branch,
    repositoryLabel,
    baseCommit,
    baseEventHash,
    baseSequence,
    baseReceiptId,
    baseReceiptEntryHash,
    signerKeyId,
    reconciliationDigest,
    receiptSignerPin,
    reconciliationSignerPublicKey: env.FORGEPROOF_GIT_LEDGER_RECONCILIATION_SIGNER_PUBLIC_KEY,
  };
}

export function assertLedgerSigner(config: GitLedgerConfig): void {
  try {
    if (!hasPinnedDurableSigner()) {
      throw new GitLedgerError("Durable pinned signer is required for ledger delivery", true, "signer_unavailable");
    }
    const { publicKey } = getKeyPair();
    const derFingerprint = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
    if (derFingerprint !== config.signerKeyId) {
      throw new GitLedgerError("Configured signer does not match the pinned ledger key", true, "signer_mismatch");
    }
    if (process.env.FORGEPROOF_ISOLATED_STAGING === "true" &&
        forbiddenStagingSigner(derFingerprint, config.receiptSignerPin)) {
      throw new GitLedgerError("Isolated staging must not reuse the historical production receipt signer", true, "staging_signer_not_isolated");
    }
  } catch (error) {
    if (error instanceof GitLedgerError) throw error;
    throw new GitLedgerError("Durable pinned signer is unavailable", true, "signer_unavailable");
  }
}

export function receiptToLedgerRecord(row: Record<string, any>): LedgerReceipt {
  // Explicit allowlist: owner, organization, repository IDs, metadata, audit
  // details, and billing data must never enter the private Git event.
  const receipt = {
    id: Number(row.id),
    fileName: row.file_name ?? row.fileName ?? "",
    filePath: row.file_path ?? row.filePath ?? "",
    fileHash: row.file_hash ?? row.fileHash ?? "",
    entryHash: row.entry_hash ?? row.entryHash ?? "",
    prevEntryHash: row.prev_entry_hash ?? row.prevEntryHash ?? null,
    signatureValid: true,
    hashMatch: true,
    complianceStatus: row.compliance_status ?? row.complianceStatus ?? null,
    detectedCountry: row.detected_country ?? row.detectedCountry ?? null,
    countryOfOrigin: row.country_of_origin ?? row.countryOfOrigin ?? "",
    modelName: row.model_name ?? row.modelName ?? "",
    modelProvider: row.model_provider ?? row.modelProvider ?? "",
    signature: row.signature ?? "",
    publicKey: row.public_key ?? row.publicKey ?? "",
    receiptVersion: row.receipt_version ?? row.receiptVersion ?? "v1",
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : row.createdAt ? new Date(row.createdAt).toISOString() : null,
    signedAt: row.signed_at ? new Date(row.signed_at).toISOString() : row.signedAt ? new Date(row.signedAt).toISOString() : null,
  };
  return toPublicReceipt(receipt as any) as LedgerReceipt;
}

export function createLedgerOutboxItem(row: Record<string, any>): LedgerOutboxItem {
  const payload = receiptToLedgerRecord(row);
  if (!payload.id || !payload.entryHash || !payload.signature || !payload.publicKey ||
      !payload.signatureValid || !payload.hashMatch) {
    throw new GitLedgerError("Receipt does not pass signature and hash verification", true, "invalid_receipt");
  }
  const payloadHash = sha256(stableJson(payload));
  const eventId = sha256(`${payload.id}:${payload.entryHash}`);
  return { id: 0, receiptId: payload.id, eventId, payload, payloadHash };
}

function keyIdForCurrentSigner(): string {
  const { publicKey } = getKeyPair();
  return createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
}

function signedEvent(item: LedgerOutboxItem, config: GitLedgerConfig, state: LedgerState) {
  if (item.payload.prevEntryHash !== state.receiptEntryHash) {
    throw new GitLedgerError("Receipt predecessor does not match the ledger checkpoint", true, "receipt_gap");
  }
  const body = {
    actor: "forgeproof-app",
    idempotencyKey: item.eventId,
    keyId: config.signerKeyId,
    operations: [{ action: "put", kind: "attestation_receipts", record: item.payload }],
    previous: state.eventHash,
    repository: config.repositoryLabel,
    requestHash: item.payloadHash,
    sequence: state.sequence + 1,
    tenant: "forgeproof",
    version: 1,
  };
  const event = { body, signature: signData(stableJson(body)) };
  return { event, eventHash: sha256(stableJson(event)) };
}

function signedCheckpoint(
  item: LedgerOutboxItem,
  config: GitLedgerConfig,
  state: LedgerState,
  eventHash: string,
) {
  const body = {
    baseCommit: config.baseCommit,
    repositoryLabel: config.repositoryLabel,
    lastEventId: item.eventId,
    previousEventHash: state.eventHash,
    receiptEntryHash: item.payload.entryHash,
    sequence: state.sequence + 1,
    signerKeyId: config.signerKeyId,
    version: 1,
  };
  return { body, signature: signData(stableJson({ ...body, eventHash })) , eventHash };
}

function verifySignedDocument(document: any, expectedSigner: string): boolean {
  if (!document?.body || typeof document.signature !== "string") return false;
  if (document.body.signerKeyId !== expectedSigner && document.body.keyId !== expectedSigner) return false;
  const signedBody = document.eventHash
    ? { ...document.body, eventHash: document.eventHash }
    : document.body;
  return verifySignature(stableJson(signedBody), document.signature, getKeyPair().publicKey);
}

async function fileAt(octokit: any, path: string, ref: string): Promise<{ text: string; sha: string } | null> {
  try {
    const response = await octokit.repos.getContent({ owner: LEDGER_OWNER, repo: LEDGER_REPOSITORY, path, ref });
    const data = response.data;
    if (Array.isArray(data) || data.type !== "file" || !data.content) {
      throw new GitLedgerError("Expected a single Git ledger file", true, "invalid_repository_state");
    }
    return { text: Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8"), sha: data.sha };
  } catch (error: any) {
    if (error?.status === 404) return null;
    throw error;
  }
}

async function assertRepositoryAndBranch(octokit: any, config: GitLedgerConfig): Promise<string> {
  const { data: repository } = await octokit.repos.get({ owner: LEDGER_OWNER, repo: LEDGER_REPOSITORY });
  if (repository.id !== LEDGER_REPOSITORY_ID || repository.private !== true || repository.permissions?.push !== true) {
    throw new GitLedgerError("Private evidence repository identity or write access did not match", true, "repository_not_ready");
  }
  const { data: branch } = await octokit.repos.getBranch({
    owner: LEDGER_OWNER,
    repo: LEDGER_REPOSITORY,
    branch: config.branch,
  });
  if (branch.protected !== true) {
    throw new GitLedgerError("Git ledger branch must be protected against force-push and deletion", true, "branch_not_protected");
  }
  const { data: rules } = await octokit.request("GET /repos/{owner}/{repo}/rules/branches/{branch}", {
    owner: LEDGER_OWNER, repo: LEDGER_REPOSITORY, branch: config.branch,
  });
  if (!Array.isArray(rules) ||
      !rules.some((rule: any) => rule.type === "deletion") ||
      !rules.some((rule: any) => rule.type === "non_fast_forward")) {
    throw new GitLedgerError("Append-only branch rules could not be verified", true, "branch_not_protected");
  }
  return branch.commit.sha;
}

function parseRemoteCheckpoint(text: string, config: GitLedgerConfig): any {
  try {
    const checkpoint = JSON.parse(text);
    if (!verifySignedDocument(checkpoint, config.signerKeyId)) {
      throw new GitLedgerError("Git checkpoint signature or signer pin is invalid", true, "checkpoint_signature_invalid");
    }
    if (checkpoint.body.baseCommit !== config.baseCommit ||
        checkpoint.body.repositoryLabel !== config.repositoryLabel ||
        !Number.isSafeInteger(checkpoint.body.sequence) ||
        checkpoint.body.sequence <= config.baseSequence ||
        !/^[0-9a-f]{64}$/.test(checkpoint.eventHash)) {
      throw new GitLedgerError("Git checkpoint anchor is invalid", true, "checkpoint_invalid");
    }
    return checkpoint;
  } catch (error) {
    if (error instanceof GitLedgerError) throw error;
    throw new GitLedgerError("Git checkpoint is malformed", true, "checkpoint_invalid");
  }
}

async function assertBaseCommit(octokit: any, config: GitLedgerConfig, headSha: string): Promise<LedgerState> {
  if (headSha !== config.baseCommit) {
    throw new GitLedgerError("Git branch has moved without a matching signed checkpoint", true, "checkpoint_diverged");
  }
  const baseline = await fileAt(octokit, "event.json", config.baseCommit);
  if (!baseline || createHash("sha256").update(baseline.text).digest("hex") !== config.baseEventHash) {
    throw new GitLedgerError("Pinned historical Git event does not match the configured checkpoint", true, "base_checkpoint_mismatch");
  }
  try {
    const historicalEvent = JSON.parse(baseline.text);
    if (historicalEvent?.body?.sequence !== config.baseSequence ||
        historicalEvent?.body?.repository !== config.repositoryLabel) {
      throw new Error("unexpected baseline");
    }
  } catch {
    throw new GitLedgerError("Pinned historical Git event does not match the configured sequence", true, "base_checkpoint_mismatch");
  }
  if (config.baseReceiptId > 45) {
    const tailFile = await fileAt(octokit, `ledger/reconciliation/45-${config.baseReceiptId}.json`, config.baseCommit);
    if (!tailFile) throw new GitLedgerError("Reconciled production tail is missing", true, "tail_evidence_missing");
    await validateReconciledTail(tailFile.text, config);
  }
  return {
    baseReceiptId: config.baseReceiptId,
    sequence: config.baseSequence,
    eventHash: config.baseEventHash,
    receiptEntryHash: config.baseReceiptEntryHash,
    commitSha: config.baseCommit,
    signerKeyId: config.signerKeyId,
  };
}

export async function validateReconciledTail(text: string, config: GitLedgerConfig): Promise<void> {
  try {
    // Lazy import avoids initializing the command's verifier on disabled paths.
    const { verifyProductionTail, archivedTail } = await import("./productionTail");
    const bundle = JSON.parse(text);
    const verified = verifyProductionTail(bundle.body?.receipts, archivedTail, {
      id: config.baseReceiptId, entryHash: config.baseReceiptEntryHash,
    });
    const configuredKey = config.reconciliationSignerPublicKey;
    const checkpointPublicKey = configuredKey
      ? createPublicKey(configuredKey.includes("-----BEGIN PUBLIC KEY-----")
        ? configuredKey
        : { key: Buffer.from(configuredKey, "base64"), type: "spki", format: "der" })
        .export({ type: "spki", format: "der" }).toString("base64")
      : getKeyPair().publicKey;
    const checkpointSignerPin = createHash("sha256")
      .update(Buffer.from(checkpointPublicKey, "base64")).digest("hex");
    if (verified.digest !== config.reconciliationDigest || verified.digest !== bundle.digest ||
        stableJson(verified.body) !== stableJson(bundle.body) ||
        verified.receiptSignerPins.some(pin => pin !== config.receiptSignerPin) ||
        bundle.checkpointSignerPin !== checkpointSignerPin ||
        !verifySignature(stableJson(bundle.body), bundle.signature, checkpointPublicKey)) {
      throw new Error("untrusted tail");
    }
  } catch {
    throw new GitLedgerError("Reconciled tail signatures, coverage or independent pins are invalid", true, "tail_evidence_invalid");
  }
}

export async function inspectPinnedLedgerBase(config: GitLedgerConfig): Promise<LedgerState> {
  assertLedgerSigner(config);
  const github = await getGitHubClient();
  const head = await assertRepositoryAndBranch(github, config);
  return assertBaseCommit(github, config, head);
}

async function verifyExistingEvent(
  octokit: any,
  config: GitLedgerConfig,
  checkpoint: any,
  item: LedgerOutboxItem,
  previous: LedgerState,
  headSha: string,
): Promise<void> {
  const body = checkpoint.body;
  const path = `ledger/events/${String(body.sequence).padStart(12, "0")}-${body.lastEventId}.json`;
  const file = await fileAt(octokit, path, headSha);
  if (!file) throw new GitLedgerError("Checkpoint event file is missing", true, "checkpoint_event_missing");
  let event: any;
  try {
    event = JSON.parse(file.text);
  } catch {
    throw new GitLedgerError("Checkpoint event file is malformed", true, "checkpoint_event_invalid");
  }
  const eventKeyId = event?.body?.keyId;
  if (eventKeyId !== config.signerKeyId ||
      sha256(stableJson(event)) !== checkpoint.eventHash ||
      event.body.previous !== previous.eventHash ||
      event.body.sequence !== previous.sequence + 1 ||
      event.body.idempotencyKey !== item.eventId ||
      event.body.requestHash !== item.payloadHash ||
      event.body.repository !== config.repositoryLabel ||
      stableJson(event.body.operations) !== stableJson([{ action: "put", kind: "attestation_receipts", record: item.payload }]) ||
      !verifySignature(stableJson(event.body), event.signature, getKeyPair().publicKey)) {
    throw new GitLedgerError("Checkpoint event signature or hash is invalid", true, "checkpoint_event_invalid");
  }
}

export async function appendReceiptToGit(
  item: LedgerOutboxItem,
  config: GitLedgerConfig,
  localState: LedgerState | null,
): Promise<LedgerState> {
  assertLedgerSigner(config);
  const checked = createLedgerOutboxItem(item.payload);
  if (checked.receiptId !== item.receiptId || checked.eventId !== item.eventId ||
      checked.payloadHash !== item.payloadHash) {
    throw new GitLedgerError("Stored outbox intent has changed", true, "outbox_conflict");
  }
  if (keyIdForCurrentSigner() !== config.signerKeyId) {
    throw new GitLedgerError("Signer does not match the independently pinned key ID", true, "signer_mismatch");
  }
  const octokit = await getGitHubClient();
  const headSha = await assertRepositoryAndBranch(octokit, config);
  const remoteFile = await fileAt(octokit, CHECKPOINT_PATH, headSha);

  let state: LedgerState;
  let remoteCheckpoint: any = null;
  if (!remoteFile) {
    if (localState && localState.sequence !== config.baseSequence) {
      throw new GitLedgerError("Local checkpoint exists but Git checkpoint is missing", true, "checkpoint_diverged");
    }
    state = await assertBaseCommit(octokit, config, headSha);
    if (localState &&
        (localState.eventHash !== state.eventHash ||
         localState.receiptEntryHash !== state.receiptEntryHash ||
         localState.commitSha !== state.commitSha)) {
      throw new GitLedgerError("Local and Git base checkpoints do not match", true, "checkpoint_diverged");
    }
  } else {
    remoteCheckpoint = parseRemoteCheckpoint(remoteFile.text, config);
    const checkpointBody = remoteCheckpoint.body;
    if (!localState) {
      // The first Git append can commit before the first SQL high-water row.
      // Recover only that exact one-step append from the independently pinned base.
      localState = await assertBaseCommit(octokit, config, config.baseCommit);
    }
    if (checkpointBody.sequence === localState.sequence + 1 &&
        checkpointBody.lastEventId === item.eventId &&
        checkpointBody.receiptEntryHash === item.payload.entryHash &&
        checkpointBody.previousEventHash === localState.eventHash &&
        item.payload.prevEntryHash === localState.receiptEntryHash) {
      const { data: replayCommit } = await octokit.git.getCommit({
        owner: LEDGER_OWNER, repo: LEDGER_REPOSITORY, commit_sha: headSha,
      });
      if (replayCommit.parents?.length !== 1 || replayCommit.parents[0].sha !== localState.commitSha) {
        throw new GitLedgerError("Replay commit does not extend the trusted checkpoint", true, "checkpoint_diverged");
      }
      await verifyExistingEvent(octokit, config, remoteCheckpoint, item, localState, headSha);
      return {
        baseReceiptId: localState.baseReceiptId,
        sequence: checkpointBody.sequence,
        eventHash: remoteCheckpoint.eventHash,
        receiptEntryHash: checkpointBody.receiptEntryHash,
        commitSha: headSha,
        signerKeyId: config.signerKeyId,
      };
    }
    if (checkpointBody.sequence !== localState.sequence ||
        remoteCheckpoint.eventHash !== localState.eventHash ||
        checkpointBody.receiptEntryHash !== localState.receiptEntryHash ||
        localState.commitSha !== headSha) {
      throw new GitLedgerError("Local and Git high-water checkpoints diverged", true, "checkpoint_diverged");
    }
    state = localState;
  }

  if (item.payload.prevEntryHash !== state.receiptEntryHash) {
    throw new GitLedgerError("Receipt predecessor does not match the pinned ledger tip", true, "receipt_gap");
  }

  const { event, eventHash } = signedEvent(item, config, state);
  const checkpoint = signedCheckpoint(item, config, state, eventHash);
  const eventPath = `ledger/events/${String(state.sequence + 1).padStart(12, "0")}-${item.eventId}.json`;
  const { data: headCommit } = await octokit.git.getCommit({
    owner: LEDGER_OWNER,
    repo: LEDGER_REPOSITORY,
    commit_sha: headSha,
  });
  const eventBlob = await octokit.git.createBlob({
    owner: LEDGER_OWNER,
    repo: LEDGER_REPOSITORY,
    content: stableJson(event),
    encoding: "utf-8",
  });
  const checkpointBlob = await octokit.git.createBlob({
    owner: LEDGER_OWNER,
    repo: LEDGER_REPOSITORY,
    content: stableJson(checkpoint),
    encoding: "utf-8",
  });
  const tree = await octokit.git.createTree({
    owner: LEDGER_OWNER,
    repo: LEDGER_REPOSITORY,
    base_tree: headCommit.tree.sha,
    tree: [
      { path: eventPath, mode: "100644", type: "blob", sha: eventBlob.data.sha },
      { path: CHECKPOINT_PATH, mode: "100644", type: "blob", sha: checkpointBlob.data.sha },
    ],
  });
  const commit = await octokit.git.createCommit({
    owner: LEDGER_OWNER,
    repo: LEDGER_REPOSITORY,
    message: `ForgeProof signed receipt ${item.receiptId}`,
    tree: tree.data.sha,
    parents: [headSha],
  });
  await octokit.git.updateRef({
    owner: LEDGER_OWNER,
    repo: LEDGER_REPOSITORY,
    ref: `heads/${config.branch}`,
    sha: commit.data.sha,
    force: false,
  });
  return {
    baseReceiptId: config.baseReceiptId,
    sequence: state.sequence + 1,
    eventHash,
    receiptEntryHash: item.payload.entryHash,
    commitSha: commit.data.sha,
    signerKeyId: config.signerKeyId,
  };
}
