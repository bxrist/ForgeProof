import { storage } from "./storage";
import { sha256, signData, getKeyPair, computeEntryHash, verifySignature } from "./crypto";

export const mcpToolDefinitions = [
  {
    name: "forgeproof_attest",
    description: "Create a cryptographic attestation receipt for AI-generated code. Signs the file with Ed25519 and adds it to the hash chain.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to the file being attested" },
        file_hash: { type: "string", description: "SHA-256 hash of the file contents" },
        model_name: { type: "string", description: "Name of the AI model that generated the code" },
        model_provider: { type: "string", description: "Provider of the AI model (e.g. OpenAI, Anthropic)" },
        country_of_origin: { type: "string", description: "Country where the code was generated" },
        repository: { type: "string", description: "Optional repository identifier" },
        metadata: { type: "object", description: "Optional additional metadata" },
        attestation_type: { type: "string", description: "Type of attestation (defaults to 'origin')" },
      },
      required: ["file_path", "file_hash", "model_name", "model_provider", "country_of_origin"],
    },
  },
  {
    name: "forgeproof_lookup",
    description: "Look up and verify an attestation receipt by its ID or entry hash. Returns verification status including signature validity and chain integrity.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Receipt ID (numeric) or entry hash to look up" },
      },
      required: ["query"],
    },
  },
  {
    name: "forgeproof_verify_chain",
    description: "Verify the integrity of the entire ForgeProof attestation hash chain. Returns whether all entries are valid and properly linked.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "forgeproof_audit_attest",
    description: "Create a security audit attestation for code that was previously attested by a different AI model. The auditing model must be different from the model that originally wrote the code. This enforces separation of concerns: the model that writes code cannot audit its own output.",
    inputSchema: {
      type: "object",
      properties: {
        parentAttestationId: {
          type: "number",
          description: "The ID of the original attestation receipt to audit",
        },
        modelName: {
          type: "string",
          description: "Name of the auditing AI model (e.g., claude-3.5-sonnet)",
        },
        modelProvider: {
          type: "string",
          description: "Provider of the auditing AI model (e.g., Anthropic). Must be different from the original attestation's provider.",
        },
        auditVerdict: {
          type: "string",
          enum: ["secure", "flagged", "remediated", "needs_review"],
          description: "The security verdict of the audit",
        },
        auditDetails: {
          type: "string",
          description: "Detailed findings from the security audit",
        },
        countryOfOrigin: {
          type: "string",
          description: "ISO country code where the audit was performed",
        },
        fileHash: {
          type: "string",
          description: "SHA-256 hash of the file after audit (same as original if no changes, new hash if remediated)",
        },
      },
      required: ["parentAttestationId", "modelName", "modelProvider", "auditVerdict", "countryOfOrigin"],
    },
  },
  {
    name: "forgeproof_batch_attest",
    description: "Attest multiple files in a single call. Each file gets its own signed receipt linked to the hash chain.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file_path: { type: "string", description: "Path to the file" },
              file_hash: { type: "string", description: "SHA-256 hash of the file contents" },
              file_name: { type: "string", description: "Optional display name for the file" },
            },
            required: ["file_path", "file_hash"],
          },
          description: "Array of files to attest",
        },
        model_name: { type: "string", description: "Name of the AI model that generated the code" },
        model_provider: { type: "string", description: "Provider of the AI model" },
        country_of_origin: { type: "string", description: "Country where the code was generated" },
        session_id: { type: "string", description: "Optional session identifier for grouping attestations" },
      },
      required: ["files", "model_name", "model_provider", "country_of_origin"],
    },
  },
];

async function createMcpAttestation(
  userId: string,
  data: {
    file_path: string;
    file_hash: string;
    file_name?: string;
    model_name: string;
    model_provider: string;
    country_of_origin: string;
    metadata?: any;
    attestation_type?: string;
  }
) {
  const fileName = data.file_name || data.file_path.split("/").pop() || "unknown";
  const timestamp = new Date().toISOString();
  const latest = await storage.getLatestAttestation();
  const prevEntryHash = latest?.entryHash || null;

  const entryHash = computeEntryHash({
    fileHash: data.file_hash,
    modelName: data.model_name,
    modelProvider: data.model_provider,
    countryOfOrigin: data.country_of_origin,
    prevEntryHash,
    timestamp,
  });

  const signaturePayload = `${entryHash}|${data.file_hash}|${timestamp}`;
  const signature = signData(signaturePayload);
  const { publicKey } = getKeyPair();

  return storage.createAttestation({
    userId,
    repositoryId: null,
    fileHash: data.file_hash,
    fileName,
    filePath: data.file_path,
    modelName: data.model_name,
    modelProvider: data.model_provider,
    countryOfOrigin: data.country_of_origin,
    detectedCountry: null,
    complianceStatus: "unverified",
    signature,
    publicKey,
    prevEntryHash,
    entryHash,
    receiptVersion: "v1",
    metadata: data.metadata || null,
    attestationType: data.attestation_type || "origin",
  });
}

async function handleAttest(args: any, userId: string) {
  const attestationType = args.attestation_type || "origin";
  const receipt = await createMcpAttestation(userId, {
    file_path: args.file_path,
    file_hash: args.file_hash,
    model_name: args.model_name,
    model_provider: args.model_provider,
    country_of_origin: args.country_of_origin,
    file_name: args.file_path.split("/").pop() || "unknown",
    metadata: { ...args.metadata, source: "mcp", repository: args.repository },
    attestation_type: attestationType,
  });

  return {
    receipt_id: receipt.id,
    entry_hash: receipt.entryHash,
    file_path: receipt.filePath,
    file_hash: receipt.fileHash,
    signature: receipt.signature,
    public_key: receipt.publicKey,
    prev_entry_hash: receipt.prevEntryHash,
    attestation_type: attestationType,
    created_at: receipt.createdAt,
  };
}

async function handleAuditAttest(args: any, userId: string) {
  const parent = await storage.getAttestation(args.parentAttestationId);
  if (!parent) {
    return { error: "Parent attestation not found" };
  }

  if (args.modelProvider === parent.modelProvider) {
    return { error: "Security audit must use a different model provider than the origin" };
  }

  const fileHash = args.fileHash || parent.fileHash;
  const fileName = parent.fileName;
  const filePath = parent.filePath;
  const timestamp = new Date().toISOString();
  const latest = await storage.getLatestAttestation();
  const prevEntryHash = latest?.entryHash || null;

  const entryHash = computeEntryHash({
    fileHash,
    modelName: args.modelName,
    modelProvider: args.modelProvider,
    countryOfOrigin: args.countryOfOrigin,
    prevEntryHash,
    timestamp,
  });

  const signaturePayload = `${entryHash}|${fileHash}|${timestamp}`;
  const signature = signData(signaturePayload);
  const { publicKey } = getKeyPair();

  const receipt = await storage.createAttestation({
    userId,
    repositoryId: null,
    fileHash,
    fileName,
    filePath,
    modelName: args.modelName,
    modelProvider: args.modelProvider,
    countryOfOrigin: args.countryOfOrigin,
    detectedCountry: null,
    complianceStatus: "unverified",
    signature,
    publicKey,
    prevEntryHash,
    entryHash,
    receiptVersion: "v1",
    metadata: { source: "mcp_audit" },
    attestationType: "security_audit",
    parentAttestationId: args.parentAttestationId,
    auditVerdict: args.auditVerdict,
    auditDetails: args.auditDetails || null,
  });

  return {
    receipt_id: receipt.id,
    entry_hash: receipt.entryHash,
    file_path: receipt.filePath,
    file_hash: receipt.fileHash,
    file_name: receipt.fileName,
    signature: receipt.signature,
    public_key: receipt.publicKey,
    prev_entry_hash: receipt.prevEntryHash,
    attestation_type: "security_audit",
    parent_attestation_id: args.parentAttestationId,
    audit_verdict: args.auditVerdict,
    audit_details: args.auditDetails || null,
    created_at: receipt.createdAt,
  };
}

async function handleLookup(args: any) {
  const query = args.query;
  let entry: any = null;

  const idNum = parseInt(query);
  if (!isNaN(idNum)) {
    entry = await storage.getAttestation(idNum);
  }

  if (!entry) {
    entry = await storage.getAttestationByEntryHash(query);
  }

  if (!entry) {
    return { found: false, message: "No attestation found for the given ID or hash" };
  }

  const timestamp = entry.createdAt ? new Date(entry.createdAt).toISOString() : new Date().toISOString();
  const recomputedHash = computeEntryHash({
    fileHash: entry.fileHash,
    modelName: entry.modelName,
    modelProvider: entry.modelProvider,
    countryOfOrigin: entry.countryOfOrigin,
    prevEntryHash: entry.prevEntryHash,
    timestamp,
  });

  const signaturePayload = `${entry.entryHash}|${entry.fileHash}|${timestamp}`;
  const signatureValid = verifySignature(signaturePayload, entry.signature, entry.publicKey);

  return {
    found: true,
    receipt_id: entry.id,
    file_name: entry.fileName,
    file_path: entry.filePath,
    file_hash: entry.fileHash,
    entry_hash: entry.entryHash,
    prev_entry_hash: entry.prevEntryHash,
    model_name: entry.modelName,
    model_provider: entry.modelProvider,
    country_of_origin: entry.countryOfOrigin,
    compliance_status: entry.complianceStatus,
    signature_valid: signatureValid,
    hash_match: recomputedHash === entry.entryHash,
    created_at: entry.createdAt,
  };
}

async function handleVerifyChain() {
  const allAttestations = await storage.getAllAttestationsOrdered();
  const results = [];
  let prevHash: string | null = null;
  let allValid = true;

  for (const entry of allAttestations) {
    const chainValid = entry.prevEntryHash === prevHash;

    const timestamp = entry.createdAt ? new Date(entry.createdAt).toISOString() : new Date().toISOString();
    const signaturePayload = `${entry.entryHash}|${entry.fileHash}|${timestamp}`;
    const signatureValid = verifySignature(signaturePayload, entry.signature, entry.publicKey);

    const entryValid = chainValid && signatureValid;
    if (!entryValid) allValid = false;

    results.push({
      id: entry.id,
      file_name: entry.fileName,
      entry_hash: entry.entryHash,
      chain_valid: chainValid,
      signature_valid: signatureValid,
      valid: entryValid,
    });

    prevHash = entry.entryHash;
  }

  return {
    chain_integrity: allValid,
    total_entries: results.length,
    entries: results,
  };
}

async function handleBatchAttest(args: any, userId: string) {
  const receipts = [];

  for (const file of args.files) {
    const receipt = await createMcpAttestation(userId, {
      file_path: file.file_path,
      file_hash: file.file_hash,
      file_name: file.file_name,
      model_name: args.model_name,
      model_provider: args.model_provider,
      country_of_origin: args.country_of_origin,
      metadata: { source: "mcp_batch", session_id: args.session_id },
    });

    receipts.push({
      receipt_id: receipt.id,
      entry_hash: receipt.entryHash,
      file_path: receipt.filePath,
      file_hash: receipt.fileHash,
      signature: receipt.signature,
      created_at: receipt.createdAt,
    });
  }

  return {
    count: receipts.length,
    receipts,
  };
}

export async function handleMcpTool(toolName: string, args: any, userId: string) {
  switch (toolName) {
    case "forgeproof_attest":
      return handleAttest(args, userId);
    case "forgeproof_lookup":
      return handleLookup(args);
    case "forgeproof_verify_chain":
      return handleVerifyChain();
    case "forgeproof_audit_attest":
      return handleAuditAttest(args, userId);
    case "forgeproof_batch_attest":
      return handleBatchAttest(args, userId);
    default:
      throw new Error(`Unknown MCP tool: ${toolName}`);
  }
}

export function getMcpManifest() {
  return {
    schema_version: "v1",
    name: "forgeproof",
    description: "ForgeProof - Code provenance attestation for AI-generated code. Cryptographic signing with Ed25519 and SHA-256 hash chains.",
    tools: mcpToolDefinitions,
  };
}
