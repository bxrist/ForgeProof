import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ForgeProofLogo } from "@/components/ForgeProofLogo";
import { useTheme } from "@/components/ThemeProvider";
import {
  ArrowLeft,
  Search,
  CheckCircle2,
  XCircle,
  Hash,
  FileCheck,
  Cpu,
  MapPin,
  Moon,
  Sun,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  Link2,
  Copy,
} from "lucide-react";

interface LookupResult {
  id: number;
  fileName: string;
  filePath: string;
  fileHash: string;
  entryHash: string;
  prevEntryHash: string | null;
  signatureValid: boolean;
  hashMatch: boolean;
  complianceStatus: string;
  detectedCountry: string | null;
  countryOfOrigin: string;
  modelName: string;
  modelProvider: string;
  signature: string;
  publicKey: string;
  receiptVersion: string;
  createdAt: string;
}

function ComplianceBadge({ status }: { status: string }) {
  if (status === "verified") {
    return (
      <Badge variant="secondary" className="text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" data-testid="badge-compliance">
        <ShieldCheck className="w-3 h-3 mr-1" />
        Geo Verified
      </Badge>
    );
  }
  if (status === "mismatch") {
    return (
      <Badge variant="destructive" className="text-xs" data-testid="badge-compliance">
        <ShieldAlert className="w-3 h-3 mr-1" />
        Geo Mismatch
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-xs" data-testid="badge-compliance">
      <ShieldQuestion className="w-3 h-3 mr-1" />
      Unverified
    </Badge>
  );
}

export default function LookupPage() {
  const { theme, toggleTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleLookup = async () => {
    const trimmed = query.trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);
    setResult(null);
    setSearched(true);

    try {
      const res = await fetch(`/api/lookup?q=${encodeURIComponent(trimmed)}`);
      if (res.status === 404) {
        setError("No attestation found for the given ID or hash.");
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.message || "An error occurred while looking up the receipt.");
        return;
      }
      const data: LookupResult = await res.json();
      setResult(data);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleLookup();
  };

  const copyEmbedCode = () => {
    if (!result) return;
    const embedUrl = `${window.location.origin}/api/badge/${result.id}.svg`;
    navigator.clipboard.writeText(embedUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

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
                data-testid="button-lookup-theme-toggle"
              >
                {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </Button>
              <Link href="/demo">
                <Button variant="ghost" size="sm" data-testid="button-back-demo">
                  <ArrowLeft className="w-3.5 h-3.5 mr-1.5" />
                  Demo
                </Button>
              </Link>
              <Link href="/">
                <Button variant="ghost" size="sm" data-testid="button-back-home">
                  <ArrowLeft className="w-3.5 h-3.5 mr-1.5" />
                  Home
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8 text-center">
          <h1 className="font-display text-2xl font-bold tracking-tight" data-testid="lookup-heading">
            Receipt Lookup
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Paste a receipt ID or entry hash to verify an attestation receipt.
          </p>
        </div>

        <div className="flex items-center gap-3 mb-8">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Receipt ID or entry hash (e.g. 1 or a3f8c9...)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              className="pl-10 font-mono"
              data-testid="input-lookup-query"
            />
          </div>
          <Button
            onClick={handleLookup}
            disabled={loading || !query.trim()}
            data-testid="button-lookup-verify"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                Verifying
              </span>
            ) : (
              <>
                <Search className="w-4 h-4 mr-1.5" />
                Verify
              </>
            )}
          </Button>
        </div>

        {loading && (
          <Card className="p-12 text-center" data-testid="lookup-loading">
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-muted-foreground">Looking up receipt...</p>
            </div>
          </Card>
        )}

        {error && !loading && (
          <Card className="p-12 text-center" data-testid="lookup-error">
            <div className="flex flex-col items-center gap-3">
              <div className="w-14 h-14 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                <XCircle className="w-7 h-7 text-red-600 dark:text-red-400" />
              </div>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
          </Card>
        )}

        {!loading && !error && searched && !result && (
          <Card className="p-12 text-center" data-testid="lookup-not-found">
            <div className="flex flex-col items-center gap-3">
              <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center">
                <Search className="w-7 h-7 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">No results found.</p>
            </div>
          </Card>
        )}

        {result && !loading && (
          <div className="space-y-6" data-testid="lookup-result">
            <Card className="p-6">
              <div className="flex items-center gap-4 mb-6">
                <div className={`w-14 h-14 rounded-full flex items-center justify-center ${result.signatureValid && result.hashMatch ? "bg-green-100 dark:bg-green-900/30" : "bg-red-100 dark:bg-red-900/30"}`}>
                  {result.signatureValid && result.hashMatch ? (
                    <ShieldCheck className="w-7 h-7 text-green-600 dark:text-green-400" />
                  ) : (
                    <ShieldAlert className="w-7 h-7 text-red-600 dark:text-red-400" />
                  )}
                </div>
                <div>
                  <h2 className="font-display text-lg font-bold" data-testid="text-lookup-title">
                    Receipt #{result.id}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {result.signatureValid && result.hashMatch ? "This receipt is cryptographically valid." : "Verification issues detected."}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
                <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50">
                  {result.signatureValid ? (
                    <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400 shrink-0" />
                  ) : (
                    <XCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0" />
                  )}
                  <div>
                    <div className="text-xs text-muted-foreground">Signature</div>
                    <div className="text-sm font-medium" data-testid="text-signature-status">
                      {result.signatureValid ? "Valid" : "Invalid"}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50">
                  {result.hashMatch ? (
                    <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400 shrink-0" />
                  ) : (
                    <XCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0" />
                  )}
                  <div>
                    <div className="text-xs text-muted-foreground">Hash Chain</div>
                    <div className="text-sm font-medium" data-testid="text-hash-match-status">
                      {result.hashMatch ? "Matches" : "Doesn't Match"}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50">
                  <div>
                    <div className="text-xs text-muted-foreground">Compliance</div>
                    <div className="mt-0.5" data-testid="text-compliance-status">
                      <ComplianceBadge status={result.complianceStatus || "unverified"} />
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                    <FileCheck className="w-3.5 h-3.5" />
                    <span className="font-medium uppercase tracking-wider">File Details</span>
                  </div>
                  <div className="space-y-1.5 pl-5">
                    <div className="flex items-start gap-2 text-sm">
                      <span className="text-muted-foreground shrink-0">Name:</span>
                      <span className="font-medium" data-testid="text-file-name">{result.fileName}</span>
                    </div>
                    <div className="flex items-start gap-2 text-sm">
                      <span className="text-muted-foreground shrink-0">Path:</span>
                      <span className="font-mono text-xs break-all" data-testid="text-file-path">{result.filePath}</span>
                    </div>
                    <div className="flex items-start gap-2 text-sm">
                      <span className="text-muted-foreground shrink-0">Hash:</span>
                      <code className="font-mono text-xs break-all" data-testid="text-file-hash">{result.fileHash}</code>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                    <Cpu className="w-3.5 h-3.5" />
                    <span className="font-medium uppercase tracking-wider">Model Info</span>
                  </div>
                  <div className="space-y-1.5 pl-5">
                    <div className="flex items-start gap-2 text-sm">
                      <span className="text-muted-foreground shrink-0">Name:</span>
                      <span className="font-medium" data-testid="text-model-name">{result.modelName}</span>
                    </div>
                    <div className="flex items-start gap-2 text-sm">
                      <span className="text-muted-foreground shrink-0">Provider:</span>
                      <span data-testid="text-model-provider">{result.modelProvider}</span>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                    <MapPin className="w-3.5 h-3.5" />
                    <span className="font-medium uppercase tracking-wider">Country</span>
                  </div>
                  <div className="space-y-1.5 pl-5">
                    <div className="flex items-start gap-2 text-sm">
                      <span className="text-muted-foreground shrink-0">Declared:</span>
                      <span data-testid="text-country-declared">{result.countryOfOrigin}</span>
                    </div>
                    <div className="flex items-start gap-2 text-sm">
                      <span className="text-muted-foreground shrink-0">Detected:</span>
                      <span data-testid="text-country-detected">{result.detectedCountry || "N/A"}</span>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                    <Link2 className="w-3.5 h-3.5" />
                    <span className="font-medium uppercase tracking-wider">Chain</span>
                  </div>
                  <div className="space-y-1.5 pl-5">
                    <div className="flex items-start gap-2 text-sm">
                      <span className="text-muted-foreground shrink-0">Entry Hash:</span>
                      <code className="font-mono text-xs break-all" data-testid="text-entry-hash">{result.entryHash}</code>
                    </div>
                    <div className="flex items-start gap-2 text-sm">
                      <span className="text-muted-foreground shrink-0">Prev Hash:</span>
                      <code className="font-mono text-xs break-all" data-testid="text-prev-entry-hash">{result.prevEntryHash || "None (genesis)"}</code>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                    <Hash className="w-3.5 h-3.5" />
                    <span className="font-medium uppercase tracking-wider">Timestamp</span>
                  </div>
                  <div className="pl-5">
                    <span className="text-sm" data-testid="text-timestamp">
                      {result.createdAt ? new Date(result.createdAt).toLocaleString() : "Unknown"}
                    </span>
                  </div>
                </div>
              </div>
            </Card>

            <Card className="p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Badge Embed URL</div>
                  <code className="font-mono text-xs break-all text-muted-foreground" data-testid="text-badge-url">
                    /api/badge/{result.id}.svg
                  </code>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={copyEmbedCode}
                  data-testid="button-copy-embed"
                >
                  <Copy className="w-3.5 h-3.5 mr-1.5" />
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </Card>
          </div>
        )}

        {!searched && !loading && (
          <div className="text-center py-16">
            <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
              <Search className="w-6 h-6 text-muted-foreground" />
            </div>
            <h3 className="font-semibold mb-1">Enter a receipt ID or hash</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              You can look up any attestation receipt by its numeric ID or its hex entry hash to independently verify its cryptographic integrity.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
