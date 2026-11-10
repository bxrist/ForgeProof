import { useEffect, useState } from "react";
import { ExternalLink, Github, Info, RefreshCw, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { githubAppError, useGitHubApp } from "@/hooks/use-github-app";
import type { GitHubAppInstallation } from "@/hooks/use-github-app";

export function GitHubAppPanel() {
  const { status, connect, refresh, unlink } = useGitHubApp();
  const [unlinkTarget, setUnlinkTarget] = useState<GitHubAppInstallation | null>(null);
  const [notice, setNotice] = useState("");
  const [callback] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("github_app");
    if (!result) return "";
    return result === "connected"
      ? "GitHub authorization returned. Installation access is shown below from the server; authorization alone does not verify repository provenance."
      : params.get("github_app_error") || params.get("message") || params.get("error") || "GitHub App authorization did not complete. Try connecting again.";
  });
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("github_app")) return;
    for (const key of ["github_app", "github_app_error", "message", "error"]) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const enabled = status.data?.configured === true && status.data?.available === true && !status.isError;
  const busy = connect.isPending || refresh.isPending || unlink.isPending || status.isFetching;
  const actionError = unlink.error || refresh.error || connect.error;

  return (
    <Card className="mb-4" data-testid="github-app-panel">
      <div className="flex flex-col gap-4 border-b border-border p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10">
            <Github className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">GitHub App</h3>
            <p className="mt-1 text-xs text-muted-foreground">Repository-scoped, read-only access. Separate from the OAuth connection below.</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void status.refetch()} data-testid="button-github-app-status">
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            {status.isFetching ? "Checking…" : "Check status"}
          </Button>
          <Button size="sm" disabled={!enabled || busy} onClick={() => { setNotice(""); connect.mutate(); }} data-testid="button-github-app-connect">
            {connect.isPending ? "Opening GitHub…" : "Connect GitHub App"}
          </Button>
        </div>
      </div>
      <div className="space-y-4 p-4">
        <div className="flex items-start gap-2 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <p>Contents: read-only. Metadata: read-only. Organization Members: read-only, used to verify organization administrators.</p>
            <p>Choose only the repositories you need on GitHub. Install the App, then complete the separate App authorization step. This App cannot write receipt archives.</p>
          </div>
        </div>
        {callback && <p role="status" className="text-sm text-muted-foreground">{callback}</p>}
        {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
        {actionError && <p role="alert" className="break-words text-sm text-destructive">{githubAppError(actionError)}</p>}
        {status.isLoading ? (
          <div className="space-y-2" aria-label="Loading GitHub App status" role="status">
            <Skeleton className="h-4 w-44" /><Skeleton className="h-3 w-64 max-w-full" />
          </div>
        ) : status.isError ? (
          <div role="alert" className="space-y-1 text-sm">
            <p className="font-medium">GitHub App status could not be checked</p>
            <p className="break-words text-muted-foreground">{githubAppError(status.error)}</p>
            <p className="text-xs text-muted-foreground">Use Check status to retry. No connection or access has been verified.</p>
          </div>
        ) : !enabled ? (
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium text-foreground">{!status.data?.configured ? "GitHub App not configured" : "GitHub App unavailable"}</p>
              <p className="mt-1">{status.data?.message || "Installation access cannot be checked in this environment. Your OAuth connection is unchanged."}</p>
            </div>
          </div>
        ) : (
          <>
            {status.data?.message && <p className="text-sm text-muted-foreground">{status.data.message}</p>}
            {status.data?.installations.length === 0 ? (
              <div className="rounded-md border border-dashed border-border p-5">
                <h4 className="text-sm font-medium">No linked App installations</h4>
                <p className="mt-1 text-xs text-muted-foreground">Connect the GitHub App to select repository access. An existing OAuth connection does not grant this App access.</p>
              </div>
            ) : status.data?.installations.map((installation) => (
              <div key={installation.id} className="rounded-md border border-border" data-testid={`github-app-installation-${installation.id}`}>
                <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="break-all text-sm font-medium">{installation.accountLogin}</h4>
                      <Badge variant="outline">Status: {installation.status || "Unknown"}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Installation #{installation.id} · Repository selection: {installation.repositorySelection || "Unknown"}
                    </p>
                    <p className="text-xs text-muted-foreground">Installation access is not proof of verified repository provenance or administrator authority.</p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button asChild variant="outline" size="sm">
                      <a href={`https://github.com/settings/installations/${installation.id}`} target="_blank" rel="noopener noreferrer">Manage on GitHub<ExternalLink className="ml-1.5 h-3 w-3" /></a>
                    </Button>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => {
                      setNotice("");
                      refresh.mutate(installation.id, { onSuccess: () => setNotice(`Installation access refreshed for ${installation.accountLogin}.`) });
                    }} data-testid={`button-github-app-refresh-${installation.id}`}>
                      {refresh.isPending && refresh.variables === installation.id ? "Refreshing…" : "Refresh"}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => { unlink.reset(); setUnlinkTarget(installation); }} data-testid={`button-github-app-unlink-${installation.id}`}>Unlink</Button>
                  </div>
                </div>
                <div className="space-y-2 border-t border-border px-4 py-3">
                  <p className="text-xs font-medium">Repositories reported by GitHub ({installation.repositories.length})</p>
                  {installation.repositories.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No repositories reported. Review the installation on GitHub, then refresh access.</p>
                  ) : (
                    <ul className="max-h-64 space-y-2 overflow-y-auto">
                      {installation.repositories.map((repo) => (
                        <li key={repo.id}>
                          <a className="inline-flex items-center gap-1.5 break-all text-sm text-primary underline-offset-4 hover:underline" href={`https://github.com/${repo.fullName.split("/").map(encodeURIComponent).join("/")}`} target="_blank" rel="noopener noreferrer">
                            {repo.fullName}<ExternalLink className="h-3 w-3 shrink-0" />
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                  {installation.marketplace && <p className="break-words text-xs text-muted-foreground">Marketplace observation: {installation.marketplace.status || "Unknown"} · Plan ID: {installation.marketplace.planId ?? "Not reported"}. Billing not activated.</p>}
                </div>
              </div>
            ))}
          </>
        )}
        <p className="border-t border-border pt-3 text-xs text-muted-foreground">Marketplace observations do not activate billing or change your subscription. Stripe billing remains unchanged.</p>
      </div>
      <AlertDialog open={!!unlinkTarget} onOpenChange={(open) => { if (!open && !unlink.isPending) setUnlinkTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink {unlinkTarget?.accountLogin}?</AlertDialogTitle>
            <AlertDialogDescription>This removes the installation link from your local ForgeProof account. It does not uninstall the GitHub App, revoke its GitHub permissions, or change billing. To remove GitHub access, manage the installation on GitHub.</AlertDialogDescription>
          </AlertDialogHeader>
          {unlink.error && <p role="alert" className="text-sm text-destructive">{githubAppError(unlink.error)}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unlink.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={unlink.isPending} onClick={(event) => {
              event.preventDefault();
              if (!unlinkTarget) return;
              unlink.mutate(unlinkTarget.id, { onSuccess: () => {
                setUnlinkTarget(null);
                setNotice("Installation unlinked locally. The GitHub App remains installed on GitHub.");
              } });
            }}>{unlink.isPending ? "Unlinking…" : "Unlink locally"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
