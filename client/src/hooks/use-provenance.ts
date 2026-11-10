import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import { apiRequest } from "@/lib/queryClient";

export interface SourceManifest {
  pending?: boolean;
  status: "verified" | "unverified" | "unavailable";
  reason?: string;
  source?: { owner: string; repo: string; commit: string; path: string; url: string; commitUrl: string };
  files?: { path: string; sha256: string }[];
  fileCount?: number;
  manifestHash?: string;
  receiptHash?: string;
  signatureValid?: boolean;
}

export function useSourceManifest(id: string) {
  return useQuery<SourceManifest>({
    queryKey: ["/api/attestations", id, "source-manifest"],
    queryFn: async () => (await apiRequest("GET", `/api/attestations/${encodeURIComponent(id)}/source-manifest`)).json(),
    enabled: !!id,
    retry: false,
    refetchInterval: query => query.state.data?.pending ? 3000 : false,
    staleTime: 0,
  });
}

export function useAppPrincipal() {
  const { user } = useUser();
  return useQuery<{ id: string }>({
    queryKey: ["/api/me", user?.id ?? "signed-out"],
    queryFn: async () => (await apiRequest("GET", "/api/me")).json(),
    enabled: !!user,
    retry: false,
  });
}

interface EntryVerification {
  id: number;
  signatureValid?: boolean;
  hashMatch?: boolean;
  status: "checked" | "checking" | "unavailable";
  checkedAt: string;
}

export function useRuntimeVerification(ids: number[]) {
  const client = useQueryClient();
  const { user } = useUser();
  const { data: principal } = useAppPrincipal();
  const scope = principal?.id;
  const uniqueIds = Array.from(new Set(ids));
  const keyFor = (id: number) => ["runtime-verification", user?.id, scope, id] as const;
  const queries = useQueries({
    queries: uniqueIds.map(id => ({
      queryKey: keyFor(id),
      queryFn: async (): Promise<EntryVerification> => { throw new Error("Run receipt checks to verify."); },
      enabled: false,
      gcTime: Infinity,
    })),
  });
  const mutation = useMutation({
    mutationKey: ["runtime-verification-run", user?.id, scope],
    mutationFn: async () => {
      if (!scope || !uniqueIds.length) throw new Error("No authenticated account receipts available to verify.");
      // Keep requests sequential to respect the verification endpoint's rate limit.
      for (const id of uniqueIds) {
        client.setQueryData<EntryVerification>(keyFor(id), { id, status: "checking", checkedAt: new Date().toISOString() });
        try {
          const result = await (await apiRequest("GET", `/api/verify/entry/${id}`)).json();
          if (result.id !== id || typeof result.signatureValid !== "boolean" || typeof result.hashMatch !== "boolean") {
            throw new Error("Verification response could not be assessed.");
          }
          client.setQueryData<EntryVerification>(keyFor(id), {
            id, signatureValid: result.signatureValid, hashMatch: result.hashMatch,
            status: "checked", checkedAt: new Date().toISOString(),
          });
        } catch {
          client.setQueryData<EntryVerification>(keyFor(id), { id, status: "unavailable", checkedAt: new Date().toISOString() });
        }
      }
    },
  });
  return {
    ...mutation,
    results: queries.map(query => query.data),
    canCheck: !!scope && !!uniqueIds.length,
    checking: mutation.isPending || queries.some(query => query.data?.status === "checking"),
  };
}
