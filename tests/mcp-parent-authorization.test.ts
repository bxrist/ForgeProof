import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  getAttestation: vi.fn(),
  getLatestAttestation: vi.fn(),
  createAttestation: vi.fn(),
}));
vi.mock("../server/storage", () => ({ storage }));
vi.mock("../server/crypto", () => ({
  sha256: vi.fn(), signData: () => "signature",
  getKeyPair: () => ({ publicKey: "public" }),
  computeEntryHash: () => "hash", verifySignature: vi.fn(),
}));
import { handleMcpTool } from "../server/mcp";

const args = {
  parentAttestationId: 1, modelName: "Claude", modelProvider: "Anthropic",
  countryOfOrigin: "US", auditVerdict: "secure",
};
beforeEach(() => vi.resetAllMocks());
describe("MCP audit parent ownership", () => {
  for (const userId of ["victim", "forgeproof-system"]) {
    it(`rejects ${userId} before signing or writing`, async () => {
      storage.getAttestation.mockResolvedValue({ id: 1, userId, modelProvider: "OpenAI" });
      expect(await handleMcpTool("forgeproof_audit_attest", args, "attacker"))
        .toEqual({ error: "Parent attestation not found" });
      expect(storage.createAttestation).not.toHaveBeenCalled();
      expect(storage.getLatestAttestation).not.toHaveBeenCalled();
    });
  }
  it("allows an independent-provider audit of the caller's own receipt", async () => {
    storage.getAttestation.mockResolvedValue({
      id: 1, userId: "owner", modelProvider: "OpenAI",
      fileHash: "filehash", filePath: "test.py", fileName: "test.py",
    });
    storage.createAttestation.mockImplementation(async (row) => ({ ...row, id: 2 }));
    const result = await handleMcpTool("forgeproof_audit_attest", args, "owner");
    expect(result).toMatchObject({ receipt_id: 2, parent_attestation_id: 1 });
    expect(storage.createAttestation).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner" }));
  });
});
