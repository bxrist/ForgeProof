import { useQuery } from "@tanstack/react-query";

type LocationEvidence = {
  schema: "forgeproof.location-evidence.v1";
  executionHost?: { source: "OCI_IMDS_V2"; region: string; availabilityDomain?: string };
  inference?: { source: "PROVIDER_RESPONSE"; provider: "anthropic"; geography: "us" | "global"; responseSha256: string };
};

type VerifiedLifecycle = {
  verified?: boolean;
  parentsVerified?: boolean;
  payload?: { locationEvidence?: LocationEvidence };
};

export function ModelLocationEvidence({ receiptId }: { receiptId: number }) {
  const { data } = useQuery<VerifiedLifecycle | null>({
    queryKey: ["/api/verify/entry", receiptId, "lifecycle"],
    queryFn: async () => {
      const response = await fetch(`/api/verify/entry/${receiptId}/lifecycle`, { credentials: "same-origin" });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Unable to verify lifecycle evidence");
      return response.json() as Promise<VerifiedLifecycle>;
    },
    retry: false,
    staleTime: 60_000,
  });
  const evidence = data?.verified === true && data.parentsVerified === true ? data.payload?.locationEvidence : undefined;
  if (!evidence || (!evidence.executionHost && !evidence.inference)) return null;

  return (
    <div className="mt-4 pt-4 border-t border-border space-y-2" data-testid="model-location-evidence">
      <h3 className="text-sm font-semibold">Signed location observations</h3>
      {evidence.executionHost && <p className="text-sm">
        Execution host (OCI IMDS v2): <strong>{evidence.executionHost.region}</strong>
        {evidence.executionHost.availabilityDomain && <> · {evidence.executionHost.availabilityDomain}</>}
      </p>}
      {evidence.inference && <>
        <p className="text-sm">Inference geography reported in an Anthropic response: <strong>{evidence.inference.geography}</strong>
          {evidence.inference.geography === "global" && " (global routing, not a geographic guarantee)"}</p>
        <p className="text-xs text-muted-foreground break-all">Observed response SHA-256: {evidence.inference.responseSha256}</p>
      </>}
      <p className="text-xs text-muted-foreground">
        These are signed service assertions, not independent verification by the provider or proof of a GPU's physical location.
        The execution host region does not establish the inference location.
      </p>
    </div>
  );
}
