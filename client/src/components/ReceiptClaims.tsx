import { useQuery } from "@tanstack/react-query";
import { receiptPresentation, type VerifiedLifecycleEvidence } from "@shared/receiptPresentation";
import type { AttestationReceipt } from "@shared/schema";

type ClaimsReceipt = Pick<AttestationReceipt, "id" | "filePath" | "modelName" | "modelProvider" | "countryOfOrigin"> & { metadata?: unknown };

export function ReceiptClaims({ receipt, enabled = true }: { receipt: ClaimsReceipt; enabled?: boolean }) {
  // The server verifies the original lifecycle signature and parent graph.
  // Dashboard rows fetch only when expanded; detail pages fetch on entry.
  const { data: lifecycle, isError, isFetching } = useQuery<VerifiedLifecycleEvidence | null>({
    queryKey: ["/api/verify/entry", receipt.id, "lifecycle"],
    enabled,
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const response = await fetch("/api/verify/entry/" + receipt.id + "/lifecycle", { credentials: "same-origin" });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Lifecycle verification failed: HTTP " + response.status);
      return response.json() as Promise<VerifiedLifecycleEvidence>;
    },
  });
  const claims = receiptPresentation(receipt, lifecycle);
  return <div className="space-y-3 text-xs" data-testid={`receipt-claims-${receipt.id}`}>
    <p className="text-muted-foreground">
      {claims.kind === "source_inventory" ? "Source inventory declaration" : claims.kind === "ci_event" ? "CI event declaration" : "Model declaration"}.
      Signed declarations are preserved as issued; they are not proof of who authored a file.
    </p>
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
      <div><dt className="text-muted-foreground">Declared model (signed)</dt><dd className="break-all">{claims.declaredModel}</dd></div>
      <div><dt className="text-muted-foreground">Declared provider (signed)</dt><dd className="break-all">{claims.declaredProvider}</dd></div>
      <div><dt className="text-muted-foreground">Observed model</dt><dd>{claims.observedModel}</dd></div>
      <div><dt className="text-muted-foreground">Observed provider</dt><dd>{claims.observedProvider}</dd></div>
      <div><dt className="text-muted-foreground">Producer / actor</dt><dd>{claims.producer}</dd></div>
      <div><dt className="text-muted-foreground">Tool / CI system (not a model)</dt><dd>{claims.ciTool}</dd></div>
      <div><dt className="text-muted-foreground">Claimed country</dt><dd>{claims.claimedCountry}</dd></div>
      <div><dt className="text-muted-foreground">Verified provider processing region</dt><dd>{claims.processingRegion}</dd></div>
    </dl>
    {enabled && isFetching && <p className="text-muted-foreground">Checking signed lifecycle evidence…</p>}
    {enabled && isError && <p role="alert" className="text-muted-foreground">Signed lifecycle verification unavailable; no model attribution inferred.</p>}
    <p className="text-muted-foreground">{claims.observationStatus === "signed-service-claim"
      ? "Signed lifecycle fields verified by ForgeProof; they authenticate the service's observation, not independently proven AI authorship."
      : claims.observationStatus === "reported"
        ? "Observations are reported, not independently verified."
        : "Observed author/model UNKNOWN; no historical model is inferred."} IP-detected country is not a verified provider processing region.</p>
  </div>;
}
