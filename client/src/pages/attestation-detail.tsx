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
} from "lucide-react";
import { SEO } from "@/components/SEO";

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

  const { data: receipt, isLoading } = useQuery<AttestationReceipt>({
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
      </main>
    </div>
  );
}
