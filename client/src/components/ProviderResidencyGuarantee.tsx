import { useQuery } from "@tanstack/react-query";

type ProviderGuarantee = {
  servingPlatform: "openai-api" | "aws-bedrock" | "google-vertex-ai";
  geographyType: "country" | "regional-area";
  geography: string;
  routingProfile: string;
  providerPolicyUrl: string;
  configurationSha256: string;
  invocationSha256: string;
  invokedAt: string;
};

type VerifiedLifecycle = {
  verified?: boolean;
  parentsVerified?: boolean;
  payload?: { providerResidencyGuarantee?: ProviderGuarantee };
};

const policyHosts: Record<ProviderGuarantee["servingPlatform"], string> = {
  "openai-api": "developers.openai.com",
  "aws-bedrock": "docs.aws.amazon.com",
  "google-vertex-ai": "docs.cloud.google.com",
};

function officialPolicyLink(proof: ProviderGuarantee): string | undefined {
  try {
    const url = new URL(proof.providerPolicyUrl);
    if (url.protocol === "https:" && !url.username && !url.password &&
        url.hostname === policyHosts[proof.servingPlatform]) return url.href;
  } catch {
    // Only an official HTTPS policy reference is navigable.
  }
}

export function ProviderResidencyGuarantee({ receiptId }: { receiptId: number }) {
  const { data: lifecycle } = useQuery<VerifiedLifecycle | null>({
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
  // Never display a region from a raw, unsigned receipt metadata object.
  const proof = lifecycle?.verified === true && lifecycle.parentsVerified === true
    ? lifecycle.payload?.providerResidencyGuarantee : undefined;
  if (!proof) return null;

  const policyUrl = officialPolicyLink(proof);
  return (
    <div className="mt-4 pt-4 border-t border-border space-y-2" data-testid="provider-residency-guarantee">
      <h3 className="text-sm font-semibold">Provider-documented processing geography</h3>
      <p className="text-sm"><strong>{proof.geography}</strong> ({proof.geographyType === "country" ? "country" : "regional area"})
        {" · "}{proof.servingPlatform} residency guarantee — <strong>reported configuration</strong></p>
      <p className="text-xs text-muted-foreground break-all">
        Regional routing: {proof.routingProfile}. Invocation reference SHA-256: {proof.invocationSha256}.
        Configuration evidence SHA-256: {proof.configurationSha256}.
      </p>
      {policyUrl && <a href={policyUrl} target="_blank" rel="noopener noreferrer" className="text-xs underline">
        Provider's published residency policy
      </a>}
      <p className="text-xs text-muted-foreground">
        The ForgeProof signature authenticates this service's assertion and request linkage, not the provider's
        actual runtime location. Provider eligibility and the configuration still require independent audit.
        This is not a verified physical data-center location.
      </p>
    </div>
  );
}
