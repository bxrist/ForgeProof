import { Link, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import type { AttestationReceipt } from "@shared/schema";
import { ForgeProofLogo } from "@/components/ForgeProofLogo";
import {
  ArrowLeft,
  ArrowRight,
  Download,
  Copy,
  FileCheck,
  Hash,
  Cpu,
  MapPin,
  Clock,
  Building2,
  Fingerprint,
  Link2,
  CheckCircle2,
  FileText,
  Info,
  RefreshCw,
  GitBranch,
} from "lucide-react";
import { SEO } from "@/components/SEO";

type AttestationWithChildren = AttestationReceipt & {
  childAttestations?: AttestationReceipt[];
};

function getTypeBadge(type: string | null | undefined) {
  switch (type) {
    case "security_audit":
      return <Badge variant="secondary" className="text-xs bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 no-default-hover-elevate no-default-active-elevate" data-testid="badge-type-audit">Audit</Badge>;
    case "refactor":
      return <Badge variant="secondary" className="text-xs bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400 no-default-hover-elevate no-default-active-elevate" data-testid="badge-type-refactor">Refactor</Badge>;
    case "review":
      return <Badge variant="secondary" className="text-xs bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400 no-default-hover-elevate no-default-active-elevate" data-testid="badge-type-review">Review</Badge>;
    case "origin":
    default:
      return <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 no-default-hover-elevate no-default-active-elevate" data-testid="badge-type-origin">Origin</Badge>;
  }
}

function getTypeLabel(type: string | null | undefined) {
  switch (type) {
    case "security_audit": return "Audit";
    case "refactor": return "Refactor";
    case "review": return "Review";
    case "origin": default: return "Origin";
  }
}

function getVerdictDisplay(verdict: string | null | undefined) {
  if (!verdict) return null;
  switch (verdict) {
    case "secure":
      return <span className="text-sm text-green-600 dark:text-green-400 font-medium" data-testid="text-verdict-secure"><CheckCircle2 className="w-3.5 h-3.5 inline mr-1" />Secure</span>;
    case "flagged":
      return <span className="text-sm text-red-600 dark:text-red-400 font-medium" data-testid="text-verdict-flagged"><Info className="w-3.5 h-3.5 inline mr-1" />Flagged</span>;
    case "remediated":
      return <span className="text-sm text-blue-600 dark:text-blue-400 font-medium" data-testid="text-verdict-remediated"><RefreshCw className="w-3.5 h-3.5 inline mr-1" />Remediated</span>;
    case "needs_review":
      return <span className="text-sm text-yellow-600 dark:text-yellow-400 font-medium" data-testid="text-verdict-needs-review"><Clock className="w-3.5 h-3.5 inline mr-1" />Needs Review</span>;
    default:
      return null;
  }
}

function DetailRow({ label, value, icon: Icon, mono = false }: { label: string; value: string; icon?: any; mono?: boolean }) {
  const { toast } = useToast();
  const copyable = mono && value.length > 20;

  return (
    <div className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4 py-3">
      <div className="flex items-center gap-2 sm:w-48 shrink-0">
        {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className={`text-sm break-all ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
        {copyable && (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={() => {
              navigator.clipboard.writeText(value);
              toast({ title: "Copied to clipboard" });
            }}
            data-testid="button-copy-value"
          >
            <Copy className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

export default function AttestationDetailPage() {
  const params = useParams<{ id: string }>();
  const { user, isLoading: authLoading } = useAuth();
  const { toast } = useToast();

  const { data: receipt, isLoading } = useQuery<AttestationWithChildren>({
    queryKey: ["/api/attestations", params.id],
    enabled: !!params.id,
  });

  const handleDownload = () => {
    if (!receipt) return;
    const receiptData = {
      receipt_version: receipt.receiptVersion,
      id: receipt.id,
      timestamp: receipt.createdAt,
      file_name: receipt.fileName,
      file_path: receipt.filePath,
      file_hash: receipt.fileHash,
      model_name: receipt.modelName,
      model_provider: receipt.modelProvider,
      country_of_origin: receipt.countryOfOrigin,
      signature: receipt.signature,
      public_key: receipt.publicKey,
      entry_hash: receipt.entryHash,
      prev_entry_hash: receipt.prevEntryHash,
      metadata: receipt.metadata,
    };
    const blob = new Blob([JSON.stringify(receiptData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `forgeproof-receipt-${receipt.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Receipt downloaded" });
  };

  if (authLoading || isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center gap-4 h-16">
              <Link href="/dashboard">
                <Button variant="ghost" size="icon">
                  <ArrowLeft className="w-4 h-4" />
                </Button>
              </Link>
              <Skeleton className="h-5 w-48" />
            </div>
          </div>
        </header>
        <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
          <Skeleton className="h-32 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
        </main>
      </div>
    );
  }

  if (!receipt) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center">
        <FileCheck className="w-12 h-12 text-muted-foreground mb-4" />
        <h2 className="font-display text-xl font-semibold mb-2">Attestation Not Found</h2>
        <p className="text-sm text-muted-foreground mb-4">This receipt doesn't exist or you don't have access.</p>
        <Link href="/dashboard">
          <Button variant="outline">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Dashboard
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <SEO title="Attestation Receipt" description="View detailed cryptographic attestation receipt with signature verification." path={`/attestation/${params.id}`} />
      <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-4 h-16">
            <div className="flex items-center gap-3">
              <Link href="/dashboard">
                <Button variant="ghost" size="icon">
                  <ArrowLeft className="w-4 h-4" />
                </Button>
              </Link>
              <div>
                <h1 className="font-display text-sm font-semibold">Attestation Receipt</h1>
                <p className="text-xs text-muted-foreground">#{receipt.id}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="outline" size="sm" onClick={() => window.open(`/api/receipt/${receipt.id}/export`, '_blank')} data-testid="button-download-certificate">
                <FileText className="w-3.5 h-3.5 mr-1.5" />
                Certificate
              </Button>
              <Button variant="outline" size="sm" onClick={handleDownload} data-testid="button-download-receipt">
                <Download className="w-3.5 h-3.5 mr-1.5" />
                Download JSON
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <Card className="p-6">
          <div className="flex items-start gap-4 mb-4">
            <div className="w-12 h-12 rounded-lg bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
              <FileCheck className="w-6 h-6 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="font-display text-lg font-semibold truncate">{receipt.fileName}</h2>
              <p className="text-sm text-muted-foreground truncate">{receipt.filePath}</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">
                <CheckCircle2 className="w-3 h-3 mr-1" />
                Verified
              </Badge>
              <Badge variant="outline">{receipt.receiptVersion}</Badge>
            </div>
          </div>

          <div className="grid sm:grid-cols-3 gap-4">
            <div className="flex items-center gap-3 p-3 rounded-md bg-muted/50">
              <Cpu className="w-5 h-5 text-primary" />
              <div>
                <div className="text-xs text-muted-foreground">Model</div>
                <div className="text-sm font-medium">{receipt.modelName}</div>
              </div>
            </div>
            <div className="flex items-center gap-3 p-3 rounded-md bg-muted/50">
              <Building2 className="w-5 h-5 text-primary" />
              <div>
                <div className="text-xs text-muted-foreground">Provider</div>
                <div className="text-sm font-medium">{receipt.modelProvider}</div>
              </div>
            </div>
            <div className="flex items-center gap-3 p-3 rounded-md bg-muted/50">
              <MapPin className="w-5 h-5 text-primary" />
              <div>
                <div className="text-xs text-muted-foreground">Origin</div>
                <div className="text-sm font-medium">{receipt.countryOfOrigin}</div>
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <h3 className="font-semibold text-sm mb-4 flex items-center gap-2">
            <Fingerprint className="w-4 h-4 text-primary" />
            Cryptographic Details
          </h3>
          <div className="divide-y divide-border">
            <DetailRow label="File Hash" value={receipt.fileHash} icon={Hash} mono />
            <DetailRow label="Entry Hash" value={receipt.entryHash} icon={Hash} mono />
            <DetailRow label="Previous Hash" value={receipt.prevEntryHash || "Genesis (no previous entry)"} icon={Link2} mono />
            <DetailRow label="Signature" value={receipt.signature} icon={Fingerprint} mono />
            <DetailRow label="Public Key" value={receipt.publicKey} icon={FileText} mono />
          </div>
        </Card>

        <Card className="p-6">
          <h3 className="font-semibold text-sm mb-4 flex items-center gap-2">
            <Clock className="w-4 h-4 text-primary" />
            Metadata
          </h3>
          <div className="divide-y divide-border">
            <DetailRow label="Created" value={receipt.createdAt ? new Date(receipt.createdAt).toLocaleString() : "Unknown"} icon={Clock} />
            <DetailRow label="Receipt Version" value={receipt.receiptVersion || "v1"} />
            {receipt.metadata ? (
              <div className="py-3">
                <div className="text-sm text-muted-foreground mb-2">Additional Metadata</div>
                <pre className="text-xs font-mono bg-muted/50 p-3 rounded-md overflow-x-auto">
                  {JSON.stringify(receipt.metadata as Record<string, unknown>, null, 2)}
                </pre>
              </div>
            ) : null}
          </div>
        </Card>

        <Card className="p-6" data-testid="card-attestation-chain">
          <h3 className="font-semibold text-sm mb-4 flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-primary" />
            Attestation Chain
          </h3>

          {receipt.auditVerdict && (
            <div className="flex items-center gap-3 p-3 rounded-md bg-muted/50 mb-4" data-testid="section-audit-verdict">
              <div className="text-xs text-muted-foreground">Audit Verdict:</div>
              {getVerdictDisplay(receipt.auditVerdict)}
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap mb-4 p-3 rounded-md bg-muted/50 overflow-x-auto" data-testid="chain-diagram">
            <div className="flex items-center gap-1 px-3 py-1.5 rounded-md border border-border bg-background shrink-0" data-testid="chain-node-current">
              {getTypeBadge(receipt.attestationType)}
              <span className="text-xs text-muted-foreground ml-1">{receipt.modelName}</span>
            </div>
            {receipt.childAttestations && receipt.childAttestations.length > 0 && receipt.childAttestations.map((child) => (
              <div key={child.id} className="flex items-center gap-2 shrink-0">
                <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
                <Link href={`/attestation/${child.id}`}>
                  <div className="flex items-center gap-1 px-3 py-1.5 rounded-md border border-border bg-background hover-elevate cursor-pointer" data-testid={`chain-node-child-${child.id}`}>
                    {getTypeBadge(child.attestationType)}
                    <span className="text-xs text-muted-foreground ml-1">{child.modelName}</span>
                  </div>
                </Link>
              </div>
            ))}
          </div>

          {receipt.parentAttestationId && (
            <div className="mb-4" data-testid="section-parent-attestation">
              <div className="text-sm text-muted-foreground mb-1">Parent Attestation</div>
              <Link href={`/attestation/${receipt.parentAttestationId}`}>
                <Button variant="outline" size="sm" data-testid="link-parent-attestation">
                  <Link2 className="w-3.5 h-3.5 mr-1.5" />
                  View Parent #{receipt.parentAttestationId}
                </Button>
              </Link>
            </div>
          )}

          {receipt.childAttestations && receipt.childAttestations.length > 0 && (
            <div data-testid="section-child-attestations">
              <div className="text-sm text-muted-foreground mb-2">Child Attestations</div>
              <div className="divide-y divide-border">
                {receipt.childAttestations.map((child) => (
                  <div key={child.id} className="flex items-center gap-3 py-3" data-testid={`row-child-attestation-${child.id}`}>
                    {getTypeBadge(child.attestationType)}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{child.fileName}</div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-muted-foreground">{child.modelProvider} / {child.modelName}</span>
                        {getVerdictDisplay(child.auditVerdict)}
                      </div>
                    </div>
                    <Link href={`/attestation/${child.id}`}>
                      <Button variant="ghost" size="sm" data-testid={`link-child-attestation-${child.id}`}>
                        View
                        <ArrowRight className="w-3.5 h-3.5 ml-1" />
                      </Button>
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!receipt.parentAttestationId && (!receipt.childAttestations || receipt.childAttestations.length === 0) && (
            <p className="text-sm text-muted-foreground" data-testid="text-no-chain">This is a standalone attestation with no linked chain.</p>
          )}
        </Card>
      </main>
    </div>
  );
}
