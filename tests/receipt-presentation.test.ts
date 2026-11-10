import { describe, it, expect } from "vitest";
import { receiptPresentation, logicalReceiptHistory, declarationSummary } from "../shared/receiptPresentation";
import { redactEvidence } from "../server/evidenceVisibility";
const manifest = (commit = "a", owner = "service", repositoryId: number | null = null) => ({
  userId: owner, repositoryId, filePath: `github://bxrist/LifeOS/commit/${commit.repeat(40)}/lifeos-source-manifest.json`,
  modelName: "LifeOS deterministic source manifest v1 - authorship unspecified", modelProvider: "LifeOS source inventory - no model attribution",
  countryOfOrigin: "UNSPECIFIED",
});
describe("receipt claim boundaries", () => {
  it("preserves actual declarations and never infers observations from them", () => {
    for (const provider of ["OpenAI", "Anthropic", "Replit"]) {
      const r = receiptPresentation({ modelName: "example-model", modelProvider: provider, metadata: { agent: provider }, countryOfOrigin: "US" });
      expect(r.declaredProvider).toBe(provider); expect(r.observedModel).toBe("UNKNOWN");
      expect(r.claimedCountry).toBe("US"); expect(r.processingRegion).toBe("UNKNOWN");
    }
    expect(receiptPresentation(manifest()).kind).toBe("source_inventory");
    expect(declarationSummary([manifest("a"), manifest("b")]).declaredModelCount).toBe(0);
  });
  it("groups manifest history across commits but not owners or source/application repositories", () => {
    const first = manifest();
    const rows = [first, manifest("b"), manifest("c", "other"), manifest("d", "service", 99),
      { ...manifest("e"), filePath: manifest("e").filePath.replace("/LifeOS/", "/Other/") }];
    expect(logicalReceiptHistory(first, rows)).toEqual(rows.slice(0,2));
  });
  it("keeps future reported observations distinct from independently proven authorship", () => {
    const r = receiptPresentation({ ...manifest(), metadata: { attribution: { version: 1, producer: "LifeOS",
      ciTool: "GitHub Actions", observation: { model: "actual-model", provider: "OpenAI",
        evidenceUri: "https://example.test/evidence", observedAt: "2026-11-10T00:00:00Z" } } } });
    expect(r.observedModel).toBe("actual-model"); expect(r.observationStatus).toBe("reported");
    expect(r.producer).toBe("LifeOS"); expect(r.ciTool).toBe("GitHub Actions"); expect(r.processingRegion).toBe("UNKNOWN");
  });
  it("redacts secrets recursively without modifying authorized originals", () => {
    const input = { label: "audit evidence", nested: { api_key: "secret" } };
    expect(redactEvidence(input)).toEqual({ label: "audit evidence", nested: { api_key: "[redacted]" } });
    expect(input.nested.api_key).toBe("secret");
  });
});
