import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { ForgeProofLogo } from "@/components/ForgeProofLogo";
import { SEO } from "@/components/SEO";
import { useUser, useClerk } from "@clerk/react";
import { apiRequest } from "@/lib/queryClient";
import { useTheme } from "@/components/ThemeProvider";
import { queryClient } from "@/lib/queryClient";
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  ExternalLink,
  Loader2,
  LogOut,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sun,
  XCircle,
} from "lucide-react";

type ReadinessCheckStatus = "ok" | "warning" | "error";

interface StripeReadinessCheck {
  key: string;
  label: string;
  status: ReadinessCheckStatus;
  detail: string;
}

interface StripeAccount {
  id: string;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
}

interface StripeReadiness {
  billingMode?: "live" | "sandbox";
  expectedAccountId: string | null;
  account: StripeAccount | null;
  ready: boolean;
  localReady?: boolean;
  remoteStatus?: string;
  checks: StripeReadinessCheck[];
  canReconcile: boolean;
}

class StripeReadinessRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "StripeReadinessRequestError";
    this.status = status;
  }
}

function messageForStatus(status: number, action: "load" | "reconcile"): string {
  if (status === 401) {
    return action === "load"
      ? "401 — Sign in is required to view Stripe readiness."
      : "401 — Your session has expired. Sign in again before reconciling.";
  }
  if (status === 403) {
    return action === "load"
      ? "403 — You do not have permission to view Stripe readiness."
      : "403 — You do not have permission to reconcile this Stripe account.";
  }
  return action === "load"
    ? "Unable to load Stripe readiness. Try again."
    : "Stripe reconciliation could not be completed. Review readiness and try again.";
}

async function fetchStripeReadiness(): Promise<StripeReadiness> {
  let response: Response;
  try {
    response = await apiRequest("GET", "/api/admin/stripe/readiness");
  } catch (error) {
    const status = Number((error as Error).message.match(/^(\d{3}):/)?.[1]) || 0;
    throw new StripeReadinessRequestError(status, messageForStatus(status, "load"));
  }

  if (!response.ok) {
    throw new StripeReadinessRequestError(response.status, messageForStatus(response.status, "load"));
  }

  try {
    return (await response.json()) as StripeReadiness;
  } catch {
    throw new StripeReadinessRequestError(0, messageForStatus(0, "load"));
  }
}

async function postStripeReconciliation(body: {
  preservationConfirmed: true;
  expectedAccountId: string | null;
}): Promise<unknown> {
  let response: Response;
  try {
    response = await apiRequest("POST", "/api/admin/stripe/reconcile", body);
  } catch (error) {
    const status = Number((error as Error).message.match(/^(\d{3}):/)?.[1]) || 0;
    throw new StripeReadinessRequestError(status, messageForStatus(status, "reconcile"));
  }

  if (!response.ok) {
    throw new StripeReadinessRequestError(response.status, messageForStatus(response.status, "reconcile"));
  }

  if (response.status === 204) {
    return { ok: true };
  }

  try {
    return await response.json();
  } catch {
    throw new StripeReadinessRequestError(0, messageForStatus(0, "reconcile"));
  }
}

function reconciliationCompleted(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;

  const result = response as Record<string, unknown>;
  if (result.reconciliation && typeof result.reconciliation === "object") {
    return (result.reconciliation as Record<string, unknown>).status === "ok";
  }
  const status = typeof result.status === "string" ? result.status.toLowerCase() : result.status;
  if (
    result.partial === true ||
    result.complete === false ||
    result.ready === false ||
    result.reconciled === false ||
    result.success === false ||
    result.ok === false ||
    status === "partial" ||
    status === "failed"
  ) {
    return false;
  }

  return (
    result.success === true ||
    result.ok === true ||
    result.reconciled === true ||
    status === "complete" ||
    status === "success" ||
    status === "reconciled"
  );
}

function setupStatus(value: boolean | undefined, accountAvailable: boolean): string {
  if (!accountAvailable || value === undefined) return "Unavailable";
  return value ? "Enabled" : "Not enabled";
}

function checkIcon(status: ReadinessCheckStatus) {
  if (status === "ok") return CheckCircle2;
  if (status === "error") return XCircle;
  return AlertTriangle;
}

function checkClasses(status: ReadinessCheckStatus): string {
  if (status === "ok") return "text-green-600 dark:text-green-400";
  if (status === "error") return "text-red-600 dark:text-red-400";
  return "text-yellow-600 dark:text-yellow-400";
}

function checkBadgeClasses(status: ReadinessCheckStatus): string {
  if (status === "ok") {
    return "text-green-700 dark:text-green-300 border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/40";
  }
  if (status === "error") {
    return "text-red-700 dark:text-red-300 border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40";
  }
  return "text-yellow-700 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-950/40";
}

function ReadinessLoading() {
  return (
    <div className="space-y-4" data-testid="stripe-readiness-loading">
      <Card className="p-5 space-y-4">
        <Skeleton className="h-5 w-44" />
        <Skeleton className="h-4 w-72" />
        <Skeleton className="h-4 w-64" />
      </Card>
      <Card className="p-5 space-y-4">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </Card>
    </div>
  );
}

export default function AdminStripePage() {
  const { user } = useUser();
  const { signOut } = useClerk();
  const logout = () => signOut({ redirectUrl: import.meta.env.BASE_URL });
  const { theme, toggleTheme } = useTheme();
  const [preservationConfirmed, setPreservationConfirmed] = useState(false);
  const [reconcileFeedback, setReconcileFeedback] = useState<{
    kind: "success" | "error" | "partial";
    message: string;
  } | null>(null);

  const readinessQuery = useQuery<StripeReadiness, StripeReadinessRequestError>({
    queryKey: ["/api/admin/stripe/readiness"],
    queryFn: fetchStripeReadiness,
  });

  const reconcileMutation = useMutation<
    unknown,
    StripeReadinessRequestError,
    { preservationConfirmed: true; expectedAccountId: string | null }
  >({
    mutationFn: postStripeReconciliation,
    onMutate: () => {
      setReconcileFeedback(null);
    },
    onSuccess: (response) => {
      const result = response && typeof response === "object"
        ? response as { reconciliation?: { localSuccess?: boolean; remoteStatus?: string } }
        : null;
      if (result?.reconciliation?.localSuccess &&
          !["verified", "not_applicable"].includes(result.reconciliation.remoteStatus || "")) {
        setReconcileFeedback({
          kind: "partial",
          message: "This environment was reconciled. The other environment's delivery and signing secret remain unverified; run its readiness check and reconciliation there after a separately approved release. No remote endpoint was changed.",
        });
      } else if (reconciliationCompleted(response)) {
        setReconcileFeedback({
          kind: "success",
          message: "Stripe reconciliation completed. Review the refreshed readiness checks below.",
        });
      } else {
        setReconcileFeedback({
          kind: "error",
          message:
            "Reconciliation did not complete fully. Review the refreshed readiness checks before trying again.",
        });
      }
    },
    onError: (error) => {
      setReconcileFeedback({ kind: "error", message: error.message });
    },
    onSettled: () => {
      setPreservationConfirmed(false);
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/stripe/readiness"] });
      void readinessQuery.refetch();
    },
  });

  const readinessError = readinessQuery.error;
  const readinessErrorMessage =
    readinessError instanceof StripeReadinessRequestError
      ? readinessError.message
      : "Unable to load Stripe readiness. Try again.";
  const readiness = readinessQuery.data;

  return (
    <div className="min-h-screen bg-background" data-testid="admin-stripe-page">
      <SEO
        title="Stripe readiness"
        description="Review Stripe account readiness before reconciliation."
        path="/admin/stripe"
      />
      <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-4 h-16">
            <Link href="/" className="flex items-center gap-2">
              <ForgeProofLogo size={44} />
              <span className="font-display font-bold text-xl tracking-tight">ForgeProof</span>
            </Link>

            <div className="flex items-center gap-2">
              <Link href="/dashboard">
                <Button variant="ghost" size="sm" data-testid="link-stripe-dashboard">
                  Dashboard
                </Button>
              </Link>
              {user && (
                <span className="hidden md:inline text-sm text-muted-foreground" data-testid="stripe-user-label">
                  {user.firstName || user.primaryEmailAddress?.emailAddress || "User"}
                </span>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleTheme}
                data-testid="button-stripe-theme-toggle"
                className="w-8 h-8"
              >
                {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </Button>
              {user && (
                <Button variant="ghost" size="icon" onClick={() => logout()} data-testid="button-stripe-logout">
                  <LogOut className="w-4 h-4" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-start justify-between gap-4 mb-8">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Badge variant="secondary" className="text-xs">
                <ShieldCheck className="w-3 h-3 mr-1" />
                Administration
              </Badge>
            </div>
            <h1 className="font-display text-2xl font-bold tracking-tight" data-testid="stripe-readiness-heading">
              Stripe readiness
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Confirm the expected Stripe account is intact before reconciliation.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void readinessQuery.refetch()}
            disabled={readinessQuery.isFetching || reconcileMutation.isPending}
            data-testid="button-refresh-stripe-readiness"
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${readinessQuery.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {readinessQuery.isLoading ? (
          <ReadinessLoading />
        ) : readinessQuery.isError ? (
          <Alert variant="destructive" data-testid="stripe-readiness-load-error">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Stripe readiness unavailable</AlertTitle>
            <AlertDescription>
              <span data-testid={`stripe-readiness-error-status-${readinessError?.status || "unknown"}`}>
                {readinessErrorMessage}
              </span>
              {readinessError?.status === 403 && user && (
                <p className="mt-2 text-sm">
                  Ask the project owner to authorize your account ID in
                  {" "}<code>FORGEPROOF_ADMIN_USER_IDS</code>:
                  {" "}<code data-testid="stripe-current-user-id">{user.externalId ?? user.id}</code>.
                  No Stripe access is granted until the server configuration allows it.
                </p>
              )}
              <div className="mt-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void readinessQuery.refetch()}
                  data-testid="button-retry-stripe-readiness"
                >
                  Try again
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : readiness ? (
          <div className="space-y-6">
            {reconcileFeedback && (
              <Alert
                variant={reconcileFeedback.kind === "error" ? "destructive" : "default"}
                data-testid={`stripe-reconcile-${reconcileFeedback.kind}`}
              >
                {reconcileFeedback.kind === "error" ? (
                  <AlertTriangle className="h-4 w-4" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                <AlertTitle>
                  {reconcileFeedback.kind === "error" ? "Reconciliation not complete" : reconcileFeedback.kind === "partial" ? "Local reconciliation complete; remote verification pending" : "Reconciliation complete"}
                </AlertTitle>
                <AlertDescription>{reconcileFeedback.message}</AlertDescription>
              </Alert>
            )}

            <Card className="p-5" data-testid="card-stripe-identity">
              <div className="flex items-center gap-2 mb-4">
                <CircleHelp className="w-4 h-4 text-muted-foreground" />
                <h2 className="font-semibold text-sm">Stripe account identity</h2>
              </div>
              <dl className="grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground mb-1">Expected account ID</dt>
                  <dd className="font-mono text-sm break-all" data-testid="text-stripe-expected-account-id">
                    {readiness.expectedAccountId || "Not configured"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground mb-1">Account returned by Stripe</dt>
                  <dd className="font-mono text-sm break-all" data-testid="text-stripe-account-id">
                    {readiness.account?.id || "No account returned"}
                  </dd>
                </div>
              </dl>
            </Card>

            <Card className="p-5" data-testid="card-stripe-setup-status">
              <div className="flex items-center gap-2 mb-4">
                <ShieldCheck className="w-4 h-4 text-muted-foreground" />
                <h2 className="font-semibold text-sm">Stripe setup status</h2>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-md border border-border p-3">
                  <div className="text-xs text-muted-foreground">Details submitted</div>
                  <div className="text-sm font-medium mt-1" data-testid="text-stripe-details-submitted">
                    {setupStatus(readiness.account?.detailsSubmitted, !!readiness.account)}
                  </div>
                </div>
                <div className="rounded-md border border-border p-3">
                  <div className="text-xs text-muted-foreground">Charges enabled</div>
                  <div className="text-sm font-medium mt-1" data-testid="text-stripe-charges-enabled">
                    {setupStatus(readiness.account?.chargesEnabled, !!readiness.account)}
                  </div>
                </div>
                <div className="rounded-md border border-border p-3">
                  <div className="text-xs text-muted-foreground">Payouts enabled</div>
                  <div className="text-sm font-medium mt-1" data-testid="text-stripe-payouts-enabled">
                    {setupStatus(readiness.account?.payoutsEnabled, !!readiness.account)}
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-4" data-testid="text-stripe-preservation-guidance">
                {readiness.billingMode === "live"
                  ? "Confirm this is the intended live account. Reconciliation synchronizes only the pinned ForgeProof catalog and this environment's webhook; it does not create charges or change other products."
                  : "These setup flags describe onboarding and capabilities only; they do not confirm that an account deletion was canceled. The account owner must preserve this account in the Stripe Dashboard and confirm that the deletion notice has been removed before reconciliation."}
              </p>
            </Card>

            <Card className="p-5" data-testid="card-stripe-checks">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-muted-foreground" />
                  <h2 className="font-semibold text-sm">Readiness checks</h2>
                </div>
                <Badge
                  variant={readiness.ready ? "secondary" : "outline"}
                  className={readiness.ready ? "text-green-700 dark:text-green-300" : ""}
                  data-testid="badge-stripe-readiness"
                >
                  {readiness.ready ? "Ready" : readiness.localReady ? "Locally ready; remote unverified" : "Not ready"}
                </Badge>
                <Badge variant="outline" data-testid="badge-stripe-can-reconcile">
                  {readiness.canReconcile ? "Reconciliation available" : "Reconciliation blocked"}
                </Badge>
              </div>
              {readiness.checks.length > 0 ? (
                <div className="divide-y divide-border">
                  {readiness.checks.map((check) => {
                    const Icon = checkIcon(check.status);
                    return (
                      <div
                        key={check.key}
                        className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
                        data-testid={`stripe-check-${check.key}`}
                      >
                        <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${checkClasses(check.status)}`} />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm">{check.label}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">{check.detail}</div>
                        </div>
                        <Badge
                          variant="outline"
                          className={`text-xs shrink-0 ${checkBadgeClasses(check.status)}`}
                          data-testid={`stripe-check-status-${check.key}`}
                        >
                          {check.status}
                        </Badge>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground" data-testid="stripe-checks-empty">
                  No readiness checks were returned.
                </p>
              )}
            </Card>

            <Card className="p-5" data-testid="card-stripe-reconciliation">
              <div className="flex items-center gap-2 mb-2">
                <ShieldCheck className="w-4 h-4 text-muted-foreground" />
                <h2 className="font-semibold text-sm">Reconciliation</h2>
              </div>
              <p className="text-sm text-muted-foreground mb-4">
                {readiness.billingMode === "live"
                  ? "Complete production billing setup by synchronizing ForgeProof's existing products and prices and registering or verifying its production webhook. Other products and webhook endpoints are left unchanged."
                  : "Reconciliation is only available after the account owner has preserved the account in Stripe and verified that the deletion notice is gone."}
              </p>
              <div className="flex items-start gap-3 rounded-md border border-border p-3 mb-4">
                <Checkbox
                  id="stripe-preservation-confirmed"
                  checked={preservationConfirmed}
                  onCheckedChange={(checked) => setPreservationConfirmed(checked === true)}
                  disabled={reconcileMutation.isPending}
                  data-testid="checkbox-stripe-preservation-confirmed"
                />
                <label htmlFor="stripe-preservation-confirmed" className="text-sm leading-5 cursor-pointer">
                  {readiness.billingMode === "live"
                    ? "I confirm this is the intended live Stripe account and authorize ForgeProof-only catalog synchronization and webhook setup."
                    : "I confirm the account owner preserved this account in the Stripe Dashboard and the deletion notice has been removed."}
                </label>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <Button
                  onClick={() =>
                    reconcileMutation.mutate({
                      preservationConfirmed: true,
                      expectedAccountId: readiness.expectedAccountId,
                    })
                  }
                  disabled={
                    !preservationConfirmed ||
                    !readiness.canReconcile ||
                    reconcileMutation.isPending
                  }
                  data-testid="button-stripe-reconcile"
                >
                  {reconcileMutation.isPending && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
                  {reconcileMutation.isPending ? "Reconciling..." : "Reconcile Stripe account"}
                </Button>
                {!readiness.canReconcile && (
                  <span className="text-xs text-muted-foreground" data-testid="text-stripe-reconcile-unavailable">
                    Reconciliation is unavailable until the server checks pass.
                  </span>
                )}
                {readiness.canReconcile && !preservationConfirmed && (
                  <span className="text-xs text-muted-foreground" data-testid="text-stripe-reconcile-confirmation-needed">
                    {readiness.billingMode === "live" ? "Confirm the live account above to enable setup." : "Confirm preservation above to enable reconciliation."}
                  </span>
                )}
              </div>
              <a
                href="https://dashboard.stripe.com"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-4"
                data-testid="link-stripe-dashboard-external"
              >
                Open Stripe Dashboard
                <ExternalLink className="w-3 h-3" />
              </a>
            </Card>
          </div>
        ) : (
          <Alert variant="destructive" data-testid="stripe-readiness-empty-error">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Stripe readiness unavailable</AlertTitle>
            <AlertDescription>Please refresh and try again.</AlertDescription>
          </Alert>
        )}
      </main>
    </div>
  );
}