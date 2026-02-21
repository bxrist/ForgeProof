import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ForgeProofLogo } from "@/components/ForgeProofLogo";
import { useTheme } from "@/components/ThemeProvider";
import { SEO } from "@/components/SEO";
import {
  ArrowLeft,
  Moon,
  Sun,
  BarChart3,
  Cpu,
  MapPin,
  Globe,
  ShieldCheck,
  FileCheck,
} from "lucide-react";

interface AnalyticsData {
  total: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  byCountry: Record<string, number>;
  byCompliance: Record<string, number>;
  byDate: Record<string, number>;
}

function StatCard({
  label,
  value,
  icon: Icon,
  loading,
}: {
  label: string;
  value: string | number;
  icon: any;
  loading?: boolean;
}) {
  return (
    <Card className="p-5" data-testid={`stat-card-${label.toLowerCase().replace(/\s+/g, "-")}`}>
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

function HorizontalBarChart({
  data,
  colorFn,
}: {
  data: Record<string, number>;
  colorFn?: (key: string) => string;
}) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...entries.map(([, v]) => v), 1);

  const defaultColor = "bg-primary";

  return (
    <div className="space-y-3">
      {entries.map(([label, count]) => {
        const pct = (count / max) * 100;
        const color = colorFn ? colorFn(label) : defaultColor;
        return (
          <div key={label} data-testid={`bar-${label.toLowerCase().replace(/\s+/g, "-")}`}>
            <div className="flex items-center justify-between gap-4 mb-1">
              <span className="text-sm font-medium truncate">{label}</span>
              <span className="text-sm text-muted-foreground tabular-nums shrink-0">{count}</span>
            </div>
            <div className="h-3 w-full rounded-md bg-muted overflow-hidden">
              <div
                className={`h-full rounded-md transition-all ${color}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
      {entries.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-4">No data available</p>
      )}
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map((i) => (
        <div key={i}>
          <div className="flex items-center justify-between gap-4 mb-1">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-8" />
          </div>
          <Skeleton className="h-3 w-full rounded-md" />
        </div>
      ))}
    </div>
  );
}

function complianceColor(key: string): string {
  const lower = key.toLowerCase();
  if (lower === "verified") return "bg-green-500 dark:bg-green-600";
  if (lower === "mismatch") return "bg-red-500 dark:bg-red-600";
  return "bg-gray-400 dark:bg-gray-500";
}

function providerColor(): string {
  return "bg-blue-500 dark:bg-blue-600";
}

export default function AnalyticsPage() {
  const { data, isLoading } = useQuery<AnalyticsData>({
    queryKey: ["/api/analytics"],
  });
  const { theme, toggleTheme } = useTheme();

  const providerCount = data ? Object.keys(data.byProvider).length : 0;
  const modelCount = data ? Object.keys(data.byModel).length : 0;
  const countryCount = data ? Object.keys(data.byCountry).length : 0;

  return (
    <div className="min-h-screen bg-background" data-testid="analytics-page">
      <SEO title="Analytics" description="Visual analytics showing attestation data by provider, model, country, and compliance status." path="/analytics" />
      <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-4 h-16">
            <Link href="/" className="flex items-center gap-2">
              <ForgeProofLogo size={44} />
              <span className="font-display font-bold text-xl tracking-tight">ForgeProof</span>
            </Link>

            <div className="flex items-center gap-3 flex-wrap">
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleTheme}
                data-testid="button-analytics-theme-toggle"
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

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-2">
            <Badge variant="secondary" className="text-xs">
              <BarChart3 className="w-3 h-3 mr-1" />
              Analytics
            </Badge>
          </div>
          <h1 className="font-display text-2xl font-bold tracking-tight" data-testid="analytics-heading">
            AI Provider Dashboard
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Aggregate analytics across all attestation receipts — providers, models, geography, and compliance.
          </p>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard
            label="Total Attestations"
            value={data?.total ?? 0}
            icon={FileCheck}
            loading={isLoading}
          />
          <StatCard
            label="Providers"
            value={providerCount}
            icon={Cpu}
            loading={isLoading}
          />
          <StatCard
            label="Models"
            value={modelCount}
            icon={BarChart3}
            loading={isLoading}
          />
          <StatCard
            label="Countries"
            value={countryCount}
            icon={Globe}
            loading={isLoading}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="p-5" data-testid="chart-by-provider">
            <div className="flex items-center gap-2 mb-4">
              <Cpu className="w-4 h-4 text-muted-foreground" />
              <h2 className="font-semibold text-sm">By Provider</h2>
            </div>
            {isLoading ? (
              <ChartSkeleton />
            ) : data?.byProvider ? (
              <HorizontalBarChart data={data.byProvider} colorFn={providerColor} />
            ) : (
              <p className="text-sm text-muted-foreground">No data</p>
            )}
          </Card>

          <Card className="p-5" data-testid="chart-by-model">
            <div className="flex items-center gap-2 mb-4">
              <BarChart3 className="w-4 h-4 text-muted-foreground" />
              <h2 className="font-semibold text-sm">By Model</h2>
            </div>
            {isLoading ? (
              <ChartSkeleton />
            ) : data?.byModel ? (
              <HorizontalBarChart data={data.byModel} />
            ) : (
              <p className="text-sm text-muted-foreground">No data</p>
            )}
          </Card>

          <Card className="p-5" data-testid="chart-by-country">
            <div className="flex items-center gap-2 mb-4">
              <MapPin className="w-4 h-4 text-muted-foreground" />
              <h2 className="font-semibold text-sm">By Country</h2>
            </div>
            {isLoading ? (
              <ChartSkeleton />
            ) : data?.byCountry ? (
              <HorizontalBarChart data={data.byCountry} />
            ) : (
              <p className="text-sm text-muted-foreground">No data</p>
            )}
          </Card>

          <Card className="p-5" data-testid="chart-by-compliance">
            <div className="flex items-center gap-2 mb-4">
              <ShieldCheck className="w-4 h-4 text-muted-foreground" />
              <h2 className="font-semibold text-sm">By Compliance Status</h2>
            </div>
            {isLoading ? (
              <ChartSkeleton />
            ) : data?.byCompliance ? (
              <HorizontalBarChart data={data.byCompliance} colorFn={complianceColor} />
            ) : (
              <p className="text-sm text-muted-foreground">No data</p>
            )}
          </Card>
        </div>
      </main>
    </div>
  );
}
