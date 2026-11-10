type ReceiptLike = {
  filePath?: string | null; modelName?: string | null; modelProvider?: string | null;
  countryOfOrigin?: string | null; metadata?: unknown; userId?: string | null;
  repositoryId?: number | null;
};
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : "UNKNOWN";
const known = (value: unknown) => !/^(UNKNOWN|UNSPECIFIED|N\/A)$/i.test(text(value));
export function manifestIdentity(path: string | null | undefined) {
  const m = /^github:\/\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)\/commit\/[a-f0-9]{40}\/(lifeos-source-manifest\.json)$/.exec(path ?? "");
  return m ? `github://${m[1].toLowerCase()}/${m[2].toLowerCase()}/${m[3]}` : null;
}
/** Presentation only. Never rewrite signed fields or infer authorship from a producer. */
export function receiptPresentation(receipt: ReceiptLike) {
  const metadata = receipt.metadata && typeof receipt.metadata === "object" ? receipt.metadata as Record<string, any> : {};
  const attribution = metadata.attribution && typeof metadata.attribution === "object" ? metadata.attribution : {};
  const inventory = !!manifestIdentity(receipt.filePath);
  const ci = !inventory && /^(github-push|github actions|github-actions|ci)$/i.test(receipt.modelName ?? "");
  const observation = attribution.version === 1 ? attribution.observation : undefined;
  const reported = observation && known(observation.model) && known(observation.provider) &&
    typeof observation.evidenceUri === "string" && /^(https:\/\/|github:\/\/)/.test(observation.evidenceUri) &&
    Number.isFinite(Date.parse(observation.observedAt));
  return {
    kind: inventory ? "source_inventory" as const : ci ? "ci_event" as const : "model_declaration" as const,
    declaredModel: text(receipt.modelName), declaredProvider: text(receipt.modelProvider),
    observedModel: reported ? text(observation.model) : "UNKNOWN",
    observedProvider: reported ? text(observation.provider) : "UNKNOWN",
    observationStatus: reported ? "reported" as const : "unknown" as const,
    producer: text(attribution.producer ?? metadata.producer ?? metadata.agent ?? metadata.source),
    ciTool: text(attribution.ciTool ?? metadata.ciTool ?? (ci ? "GitHub push webhook" : undefined)),
    claimedCountry: text(receipt.countryOfOrigin),
    // v1 receipts and caller-supplied metadata cannot prove provider processing location.
    processingRegion: "UNKNOWN",
  };
}
export function logicalReceiptHistory<T extends ReceiptLike>(receipt: T, accessible: T[]) {
  const logical = manifestIdentity(receipt.filePath);
  return accessible.filter(row =>
    row.userId === receipt.userId && (row.repositoryId ?? null) === (receipt.repositoryId ?? null) &&
    (logical ? manifestIdentity(row.filePath) === logical : row.filePath === receipt.filePath));
}
export function declarationSummary(receipts: ReceiptLike[]) {
  const declarations = receipts.map(receiptPresentation).filter(p =>
    p.kind === "model_declaration" && known(p.declaredModel));
  const distinctModels = Array.from(new Set(declarations.map(p => `${p.declaredProvider} / ${p.declaredModel}`)));
  // Reported observations remain claims, not independently verified author counts.
  return { distinctModels, declaredModelCount: distinctModels.length, observedModelCount: 0 };
}
