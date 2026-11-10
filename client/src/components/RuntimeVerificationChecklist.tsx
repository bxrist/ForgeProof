import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useRuntimeVerification } from "@/hooks/use-provenance";

export function RuntimeVerificationChecklist({ ids }: { ids: number[] }) {
  const check = useRuntimeVerification(ids);
  const complete = check.results.length > 0 && check.results.every(result => result?.status === "checked");
  const unavailable = check.isError || check.results.some(result => result?.status === "unavailable");
  const labelFor = (field: "signatureValid" | "hashMatch") => {
    if (check.checking) return "Checking";
    if (unavailable) return "Unavailable";
    if (!complete) return "Not verified";
    return check.results.every(result => result?.[field] === true) ? "Verified at check time" : "Failed";
  };
  return (
    <Card className="p-5 mb-6 space-y-3" data-testid="runtime-verification-checklist">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-semibold">Runtime verification checklist</h3>
        <Button variant="outline" size="sm" disabled={check.checking || !check.canCheck} onClick={() => check.mutate()}>
          {check.checking ? "Checking receipts…" : "Run receipt checks"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Checks these {check.results.length} account-accessible receipt(s), not necessarily receipts personally issued by you. Results are shared per receipt across this account's dashboard and detail views. Stored labels and historical inventory are not runtime checks.</p>
      {check.checking && <Skeleton className="h-8 w-full" />}
      {unavailable && <p role="alert" className="text-sm text-muted-foreground">Verification unavailable or access denied for one or more receipts. No successful result is inferred. Retry using Run receipt checks.</p>}
      <div className="space-y-2 text-sm" aria-live="polite">
        {(["signatureValid", "hashMatch"] as const).map(field => {
          const label = labelFor(field);
          return <div key={field} className="flex justify-between gap-2">
            <span>{field === "signatureValid" ? "Receipt signatures" : "Signed entry hashes"}</span>
            <Badge variant="outline" className={label === "Verified at check time" ? "text-green-700 dark:text-green-400" : label === "Failed" ? "text-destructive" : "text-muted-foreground"}>{label}</Badge>
          </div>;
        })}
        <p className="text-xs text-muted-foreground">Ledger continuity: not checked by individual-entry verification. Parent/child lineage: not a ledger hash-chain check.</p>
        <p className="text-xs text-muted-foreground">Authentication boundaries and tenant isolation: not assessed. Billing/payment flow: not assessed. AI authorship, execution location and per-file audits: not established by a signature. UNKNOWN remains unknown.</p>
      </div>
      <div className="space-y-1 text-xs text-muted-foreground">
        {check.results.map((result, index) => result && result.status !== "checking" ? <p key={ids[index]}>
          Receipt #{result.id}: {result.status === "unavailable" ? "unavailable" : `signature ${result.signatureValid ? "valid" : "failed"}; hash ${result.hashMatch ? "matches" : "failed"}`} · checked at {new Date(result.checkedAt).toLocaleString()}
        </p> : null)}
        {check.results.some(Boolean) && <p>Point-in-time results, not continuous monitoring.</p>}
      </div>
    </Card>
  );
}
