import { receiptPresentation } from "@shared/receiptPresentation";
import type { AttestationReceipt } from "@shared/schema";

type ClaimsReceipt = Pick<AttestationReceipt, "id" | "filePath" | "modelName" | "modelProvider" | "countryOfOrigin"> & { metadata?: unknown };

export function ReceiptClaims({ receipt }: { receipt: ClaimsReceipt }) {
  const claims = receiptPresentation(receipt);
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
      <div><dt className="text-muted-foreground">Producer</dt><dd>{claims.producer}</dd></div>
      <div><dt className="text-muted-foreground">CI tool (not a model)</dt><dd>{claims.ciTool}</dd></div>
      <div><dt className="text-muted-foreground">Claimed country</dt><dd>{claims.claimedCountry}</dd></div>
      <div><dt className="text-muted-foreground">Verified provider processing region</dt><dd>{claims.processingRegion}</dd></div>
    </dl>
    <p className="text-muted-foreground">{claims.observationStatus === "reported" ? "Observations are reported, not independently verified." : "Observed author/model UNKNOWN; no historical model is inferred."} IP-detected country is not a verified provider processing region.</p>
  </div>;
}
