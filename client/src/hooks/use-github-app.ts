import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export interface GitHubAppInstallation {
  id: number;
  accountLogin: string;
  status: string;
  repositorySelection: string;
  repositories: { id: number; fullName: string }[];
  marketplace?: { status: string; planId: number | null; billingActivated: false };
}

export interface GitHubAppStatus {
  configured: boolean;
  available: boolean;
  message?: string;
  installations: GitHubAppInstallation[];
}

export function githubAppError(error: unknown): string {
  if (!(error instanceof Error)) return "The GitHub App request could not be completed. Try again.";
  const message = error.message.replace(/^\d+:\s*/, "");
  try {
    const body = JSON.parse(message);
    return typeof body.message === "string" ? body.message
      : typeof body.error === "string" ? body.error : message;
  } catch {
    return message;
  }
}

export function useGitHubApp() {
  const client = useQueryClient();
  const queryKey = ["/api/github-app/status"];
  const status = useQuery<GitHubAppStatus>({
    queryKey,
    queryFn: async () => (await apiRequest("GET", "/api/github-app/status")).json(),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const connect = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/github-app/connect");
      const result: { url: string } = await response.json();
      const url = new URL(result.url);
      if (url.protocol !== "https:" || url.hostname !== "github.com") {
        throw new Error("The server returned an invalid GitHub authorization URL.");
      }
      return url.href;
    },
    onSuccess: (url) => window.location.assign(url),
  });
  const refresh = useMutation({
    mutationFn: async (id: number) => {
      const response = await apiRequest("POST", `/api/github-app/installations/${id}/refresh`);
      return response.json() as Promise<GitHubAppInstallation>;
    },
    onSuccess: () => client.invalidateQueries({ queryKey }),
  });
  const unlink = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/github-app/installations/${id}`);
      return id;
    },
    onSuccess: (id) => {
      client.setQueryData<GitHubAppStatus>(queryKey, (old) => old
        ? { ...old, installations: old.installations.filter((installation) => installation.id !== id) }
        : old);
      return client.invalidateQueries({ queryKey });
    },
  });
  return { status, connect, refresh, unlink };
}
