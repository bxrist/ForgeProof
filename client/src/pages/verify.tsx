import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ForgeProofLogo } from "@/components/ForgeProofLogo";
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Link2,
  Hash,
  FileCheck,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  ChevronRight,
  AlertTriangle,
  Moon,
  Sun,
} from "lucide-react";
import { useTheme } from "@/components/ThemeProvider";

interface ChainEntry {
  id: number;
  fileName: string;
  filePath: string;
  entryHash: string;
  prevEntryHash: string | null;
  chainValid: boolean;
  signatureValid: boolean;
  valid: boolean;
  complianceStatus: string;
  createdAt: string;
}

interface ChainResult {
  chainIntegrity: boolean;
  entries: ChainEntry[];
  totalEntries: number;
}

function ComplianceBadge({ status }: { status: string }) {
  if (status === "verified") {
    return (
      <Badge variant="secondary" className="text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
        <ShieldCheck className="w-3 h-3 mr-1" />
        Geo Verified
      </Badge>
    );
  }
  if (status === "mismatch") {
    return (
      <Badge variant="destructive" className="text-xs">
        <ShieldAlert className="w-3 h-3 mr-1" />
        Geo Mismatch
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-xs">
      <ShieldQuestion className="w-3 h-3 mr-1" />
      Unverified
    </Badge>
  );
}

function ChainEntryRow({ entry, index }: { entry: ChainEntry; index: number }) {
  return (
    <div className="relative" data-testid={`chain-entry-${entry.id}`}>
      {index > 0 && (
        <div className="absolute left-[22px] -top-4 w-0.5 h-4 bg-border" />
      )}
      <div className={`flex items-start gap-4 p-4 rounded-lg border ${entry.valid ? "border-border" : "border-destructive/50 bg-destructive/5"}`}>
        <div className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 ${entry.valid ? "bg-green-100 dark:bg-green-900/30" : "bg-red-100 dark:bg-red-900/30"}`}>
          {entry.valid ? (
            <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" />
          ) : (
            <XCircle className="w-5 h-5 text-red-600 dark:text-red-400" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-sm truncate">{entry.fileName}</span>
            <span className="text-xs text-muted-foreground">#{entry.id}</span>
          </div>
          <div className="text-xs text-muted-foreground truncate mb-2">{entry.filePath}</div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={entry.chainValid ? "secondary" : "destructive"} className="text-xs">
              <Link2 className="w-3 h-3 mr-1" />
              Chain {entry.chainValid ? "Valid" : "Broken"}
            </Badge>
            <Badge variant={entry.signatureValid ? "secondary" : "destructive"} className="text-xs">
              <FileCheck className="w-3 h-3 mr-1" />
              Sig {entry.signatureValid ? "Valid" : "Invalid"}
            </Badge>
            <ComplianceBadge status={entry.complianceStatus || "unverified"} />
          </div>

          <div className="mt-2 space-y-0.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Hash className="w-3 h-3" />
              <code className="font-mono truncate">{entry.entryHash.substring(0, 24)}...</code>
            </div>
            {entry.prevEntryHash && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ChevronRight className="w-3 h-3" />
                <span>prev:</span>
                <code className="font-mono truncate">{entry.prevEntryHash.substring(0, 24)}...</code>
              </div>
            )}
          </div>
        </div>

        <div className="hidden sm:block text-xs text-muted-foreground whitespace-nowrap">
          {entry.createdAt ? new Date(entry.createdAt).toLocaleDateString() : ""}
        </div>
      </div>
    </div>
  );
}

export default function VerifyPage() {
  const { data, isLoading } = useQuery<ChainResult>({
    queryKey: ["/api/verify/chain"],
  });
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-4 h-16">
            <Link href="/" className="flex items-center gap-2">
              <ForgeProofLogo size={44} />
              <span className="font-display font-bold text-xl tracking-tight">ForgeProof</span>
            </Link>

            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleTheme}
                data-testid="button-verify-theme-toggle"
                className="w-8 h-8"
              >
                {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </Button>
              <Link href="/demo">
                <Button variant="ghost" size="sm" data-testid="button-back-demo">
                  <ArrowLeft className="w-3.5 h-3.5 mr-1.5" />
                  Demo
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="font-display text-2xl font-bold tracking-tight" data-testid="verify-heading">
            Hash Chain Verification
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Independently verify the integrity of every attestation in the ForgeProof ledger.
          </p>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : data ? (
          <>
            <Card className="p-6 mb-6">
              <div className="flex items-center gap-4">
                <div className={`w-14 h-14 rounded-full flex items-center justify-center ${data.chainIntegrity ? "bg-green-100 dark:bg-green-900/30" : "bg-red-100 dark:bg-red-900/30"}`}>
                  {data.chainIntegrity ? (
                    <ShieldCheck className="w-7 h-7 text-green-600 dark:text-green-400" />
                  ) : (
                    <AlertTriangle className="w-7 h-7 text-red-600 dark:text-red-400" />
                  )}
                </div>
                <div>
                  <h2 className="font-display text-lg font-bold" data-testid="chain-status">
                    {data.chainIntegrity ? "Chain Integrity Verified" : "Chain Integrity Compromised"}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {data.totalEntries} entries in the attestation ledger
                  </p>
                </div>
                <Badge
                  className="ml-auto"
                  variant={data.chainIntegrity ? "secondary" : "destructive"}
                  data-testid="chain-integrity-badge"
                >
                  {data.chainIntegrity ? "PASS" : "FAIL"}
                </Badge>
              </div>
            </Card>

            <div className="space-y-3">
              {data.entries.map((entry, i) => (
                <ChainEntryRow key={entry.id} entry={entry} index={i} />
              ))}
            </div>
          </>
        ) : (
          <Card className="p-12 text-center">
            <p className="text-muted-foreground">No attestation data found.</p>
          </Card>
        )}
      </main>
    </div>
  );
}
