import { useState, useMemo } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AttestationReceipt } from "@shared/schema";
import { ForgeProofLogo } from "@/components/ForgeProofLogo";
import {
  FileCheck,
  GitBranch,
  Link2,
  Cpu,
  MapPin,
  ChevronRight,
  ArrowLeft,
  Download,
  ExternalLink,
  Search,
  Filter,
  BarChart3,
  Moon,
  Sun,
} from "lucide-react";
import { SiGithub } from "react-icons/si";
import { useTheme } from "@/components/ThemeProvider";
import { SEO } from "@/components/SEO";

function StatCard({ label, value, icon: Icon, loading }: { label: string; value: string | number; icon: any; loading?: boolean }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-2 mb-3">
        <span className="text-sm text-muted-foreground">{label}</span>
        <div className="w-8 h-8 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center">
          <Icon className="w-4 h-4 text-primary" />
        </div>
      </div>
      {loading ? (
        <Skeleton className="h-8 w-20" />
      ) : (
        <div className="font-display text-2xl font-bold">{value}</div>
      )}
    </Card>
  );
}

function AttestationRow({ receipt }: { receipt: AttestationReceipt }) {
  const [, navigate] = useLocation();
  return (
    <div
      className="flex items-center gap-4 p-4 rounded-md hover:bg-muted/50 cursor-pointer transition-colors"
      onClick={() => navigate(`/demo/attestation/${receipt.id}`)}
      data-testid={`row-demo-attestation-${receipt.id}`}
    >
      <div className="w-9 h-9 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
        <FileCheck className="w-4.5 h-4.5 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate">{receipt.fileName}</div>
        <div className="text-xs text-muted-foreground truncate">{receipt.filePath}</div>
      </div>
      <div className="hidden sm:flex items-center gap-2">
        <Badge variant="secondary" className="text-xs">
          <Cpu className="w-3 h-3 mr-1" />
          {receipt.modelProvider}
        </Badge>
        <Badge variant="outline" className="text-xs">
          <MapPin className="w-3 h-3 mr-1" />
          {receipt.countryOfOrigin}
        </Badge>
      </div>
      <div className="hidden md:block text-xs text-muted-foreground whitespace-nowrap">
        {receipt.createdAt ? new Date(receipt.createdAt).toLocaleDateString() : ""}
      </div>
      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2 p-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="w-9 h-9 rounded-md" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function DemoPage() {
  const { data: receipts, isLoading } = useQuery<AttestationReceipt[]>({
    queryKey: ["/api/demo/attestations"],
  });
  const { theme, toggleTheme } = useTheme();

  const [searchQuery, setSearchQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [complianceFilter, setComplianceFilter] = useState("all");

  const uniqueProviders = useMemo(() => {
    if (!receipts) return [];
    const providers = new Set(receipts.map((r) => r.modelProvider).filter(Boolean));
    return Array.from(providers).sort();
  }, [receipts]);

  const filteredReceipts = useMemo(() => {
    if (!receipts) return [];
    return receipts.filter((r) => {
      const query = searchQuery.toLowerCase();
      if (query && !(r.fileName?.toLowerCase().includes(query) || r.filePath?.toLowerCase().includes(query))) {
        return false;
      }
      if (providerFilter !== "all" && r.modelProvider !== providerFilter) {
        return false;
      }
      if (complianceFilter !== "all" && r.complianceStatus !== complianceFilter) {
        return false;
      }
      return true;
    });
  }, [receipts, searchQuery, providerFilter, complianceFilter]);

  return (
    <div className="min-h-screen bg-background">
      <SEO title="Demo" description="Explore ForgeProof's self-attesting seed data. View cryptographic attestation receipts without login." path="/demo" />
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
                data-testid="button-demo-theme-toggle"
                className="w-8 h-8"
              >
                {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </Button>
              <Link href="/verify">
                <Button variant="ghost" size="sm" data-testid="button-demo-verify">
                  <Link2 className="w-3.5 h-3.5 mr-1.5" />
                  Verify
                </Button>
              </Link>
              <Link href="/lookup">
                <Button variant="ghost" size="sm" data-testid="button-demo-lookup">
                  <Search className="w-3.5 h-3.5 mr-1.5" />
                  Lookup
                </Button>
              </Link>
              <Link href="/analytics">
                <Button variant="ghost" size="sm" data-testid="button-demo-analytics">
                  <BarChart3 className="w-3.5 h-3.5 mr-1.5" />
                  Analytics
                </Button>
              </Link>
              <Link href="/sdk">
                <Button variant="ghost" size="sm" data-testid="button-demo-sdk">
                  SDK
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

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-2">
            <Badge variant="secondary" className="text-xs">Live Demo</Badge>
          </div>
          <h1 className="font-display text-2xl font-bold tracking-tight">ForgeProof Attestation Ledger</h1>
          <p className="text-sm text-muted-foreground mt-1">
            ForgeProof attests its own codebase. Every file below was cryptographically signed during development — proof that ForgeProof practices what it preaches.
          </p>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard
            label="Attestations"
            value={receipts?.length ?? 0}
            icon={FileCheck}
            loading={isLoading}
          />
          <StatCard
            label="Repository"
            value="forgeproof"
            icon={GitBranch}
            loading={false}
          />
          <StatCard
            label="Chain Integrity"
            value="Verified"
            icon={Link2}
            loading={false}
          />
          <StatCard
            label="Signature"
            value="Ed25519"
            icon={FileCheck}
            loading={false}
          />
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              data-testid="input-search"
              placeholder="Search by file name or path..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Filter className="w-4 h-4" />
            </div>
            <Select value={providerFilter} onValueChange={setProviderFilter}>
              <SelectTrigger data-testid="select-provider-filter" className="w-[180px]">
                <SelectValue placeholder="All Providers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Providers</SelectItem>
                {uniqueProviders.map((provider) => (
                  <SelectItem key={provider} value={provider!}>{provider}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={complianceFilter} onValueChange={setComplianceFilter}>
              <SelectTrigger data-testid="select-compliance-filter" className="w-[180px]">
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="verified">Verified</SelectItem>
                <SelectItem value="mismatch">Mismatch</SelectItem>
                <SelectItem value="unverified">Unverified</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <Card>
          <div className="flex items-center justify-between gap-4 p-4 border-b border-border">
            <h3 className="font-semibold text-sm">Self-Attesting Receipts</h3>
            <Badge variant="outline" className="text-xs">
              {filteredReceipts.length} of {receipts?.length ?? 0}
            </Badge>
          </div>
          {isLoading ? (
            <LoadingRows />
          ) : filteredReceipts.length > 0 ? (
            <div className="divide-y divide-border">
              {filteredReceipts.map((r) => (
                <AttestationRow key={r.id} receipt={r} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center mb-4">
                <FileCheck className="w-6 h-6 text-muted-foreground" />
              </div>
              <h3 className="font-semibold mb-1">No attestations found</h3>
              <p className="text-sm text-muted-foreground max-w-sm">System attestations will appear here once the seed data is loaded.</p>
            </div>
          )}
        </Card>

        <div className="mt-8 p-6 rounded-lg bg-muted/50 border border-border">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <h3 className="font-semibold text-sm mb-1">Want to integrate ForgeProof?</h3>
              <p className="text-xs text-muted-foreground">
                AI agents can programmatically attest code via the REST API. Click any receipt above to see the full cryptographic details and download the JSON.
              </p>
            </div>
            <a href="https://github.com/bxrist/ForgeProof" target="_blank" rel="noopener noreferrer">
              <Button variant="outline" size="sm">
                <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                View Source
              </Button>
            </a>
          </div>
        </div>
      </main>
    </div>
  );
}
