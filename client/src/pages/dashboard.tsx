import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { AttestationReceipt, Repository, ApiKey } from "@shared/schema";
import { ForgeProofLogo } from "@/components/ForgeProofLogo";
import {
  FileCheck,
  GitBranch,
  Key,
  Plus,
  ArrowRight,
  Download,
  Clock,
  Link2,
  Hash,
  Cpu,
  MapPin,
  ExternalLink,
  Copy,
  RefreshCw,
  LogOut,
  BarChart3,
  Trash2,
  ChevronRight,
} from "lucide-react";

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
      className="flex items-center gap-4 p-4 rounded-md hover-elevate cursor-pointer transition-colors"
      onClick={() => navigate(`/attestation/${receipt.id}`)}
      data-testid={`row-attestation-${receipt.id}`}
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

function RepositoryRow({ repo }: { repo: Repository }) {
  return (
    <div className="flex items-center gap-4 p-4" data-testid={`row-repo-${repo.id}`}>
      <div className="w-9 h-9 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
        <GitBranch className="w-4.5 h-4.5 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm">{repo.fullName}</div>
        <div className="text-xs text-muted-foreground">{repo.defaultBranch || "main"}</div>
      </div>
      <a href={repo.url} target="_blank" rel="noopener noreferrer">
        <Button variant="ghost" size="icon">
          <ExternalLink className="w-4 h-4" />
        </Button>
      </a>
    </div>
  );
}

function ApiKeyRow({ apiKey, onDelete }: { apiKey: ApiKey; onDelete: (id: number) => void }) {
  const { toast } = useToast();
  return (
    <div className="flex items-center gap-4 p-4" data-testid={`row-apikey-${apiKey.id}`}>
      <div className="w-9 h-9 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
        <Key className="w-4.5 h-4.5 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm">{apiKey.name}</div>
        <div className="flex items-center gap-2 mt-0.5">
          <code className="text-xs text-muted-foreground font-mono">{apiKey.keyPrefix}...</code>
          {apiKey.isActive ? (
            <Badge variant="secondary" className="text-xs">Active</Badge>
          ) : (
            <Badge variant="destructive" className="text-xs">Inactive</Badge>
          )}
        </div>
      </div>
      <div className="hidden sm:block text-xs text-muted-foreground">
        {apiKey.lastUsedAt ? `Used ${new Date(apiKey.lastUsedAt).toLocaleDateString()}` : "Never used"}
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onDelete(apiKey.id)}
        data-testid={`button-delete-key-${apiKey.id}`}
      >
        <Trash2 className="w-4 h-4 text-muted-foreground" />
      </Button>
    </div>
  );
}

function CreateApiKeyDialog() {
  const [name, setName] = useState("");
  const [generatedKey, setGeneratedKey] = useState("");
  const [open, setOpen] = useState(false);
  const { toast } = useToast();

  const createMutation = useMutation({
    mutationFn: async (keyName: string) => {
      const res = await apiRequest("POST", "/api/api-keys", { name: keyName });
      return res.json();
    },
    onSuccess: (data) => {
      setGeneratedKey(data.fullKey);
      queryClient.invalidateQueries({ queryKey: ["/api/api-keys"] });
    },
    onError: () => {
      toast({ title: "Failed to create API key", variant: "destructive" });
    },
  });

  const handleCreate = () => {
    if (!name.trim()) return;
    createMutation.mutate(name);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(generatedKey);
    toast({ title: "API key copied to clipboard" });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setName(""); setGeneratedKey(""); } }}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="button-create-api-key">
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          New API Key
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create API Key</DialogTitle>
        </DialogHeader>
        {generatedKey ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Your API key has been created. Copy it now - you won't be able to see it again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 p-3 bg-muted rounded-md text-xs font-mono break-all">{generatedKey}</code>
              <Button variant="outline" size="icon" onClick={handleCopy} data-testid="button-copy-key">
                <Copy className="w-4 h-4" />
              </Button>
            </div>
            <Button className="w-full" onClick={() => setOpen(false)} data-testid="button-done-key">Done</Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1.5 block">Key Name</label>
              <Input
                placeholder="e.g., CI Pipeline Key"
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="input-key-name"
              />
            </div>
            <Button
              className="w-full"
              onClick={handleCreate}
              disabled={!name.trim() || createMutation.isPending}
              data-testid="button-submit-key"
            >
              {createMutation.isPending ? "Creating..." : "Create Key"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EmptyState({ icon: Icon, title, desc }: { icon: any; title: string; desc: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center mb-4">
        <Icon className="w-6 h-6 text-muted-foreground" />
      </div>
      <h3 className="font-semibold mb-1">{title}</h3>
      <p className="text-sm text-muted-foreground max-w-sm">{desc}</p>
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

export default function DashboardPage() {
  const { user, isLoading: authLoading, logout } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data: receipts, isLoading: receiptsLoading } = useQuery<AttestationReceipt[]>({
    queryKey: ["/api/attestations"],
  });

  const { data: repos, isLoading: reposLoading } = useQuery<Repository[]>({
    queryKey: ["/api/repositories"],
  });

  const { data: keys, isLoading: keysLoading } = useQuery<ApiKey[]>({
    queryKey: ["/api/api-keys"],
  });

  const deleteKeyMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/api-keys/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/api-keys"] });
      toast({ title: "API key deleted" });
    },
  });

  const syncReposMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/repositories/sync");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/repositories"] });
      toast({ title: "Repositories synced" });
    },
    onError: () => {
      toast({ title: "Failed to sync repositories", variant: "destructive" });
    },
  });

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  if (!user) {
    navigate("/");
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-4 h-16">
            <Link href="/" className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center">
                <ForgeProofLogo size={18} className="text-primary-foreground" />
              </div>
              <span className="font-display font-bold text-lg tracking-tight">ForgeProof</span>
            </Link>

            <div className="flex items-center gap-3">
              <div className="hidden sm:flex items-center gap-2 mr-2">
                <Avatar className="w-7 h-7">
                  <AvatarImage src={user.profileImageUrl || ""} />
                  <AvatarFallback className="text-xs">
                    {(user.firstName?.[0] || user.email?.[0] || "U").toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm font-medium">{user.firstName || user.email || "User"}</span>
              </div>
              <Button variant="ghost" size="icon" onClick={() => logout()} data-testid="button-logout">
                <LogOut className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="font-display text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage your attestation receipts, repositories, and API keys.</p>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard
            label="Attestations"
            value={receipts?.length ?? 0}
            icon={FileCheck}
            loading={receiptsLoading}
          />
          <StatCard
            label="Repositories"
            value={repos?.length ?? 0}
            icon={GitBranch}
            loading={reposLoading}
          />
          <StatCard
            label="API Keys"
            value={keys?.length ?? 0}
            icon={Key}
            loading={keysLoading}
          />
          <StatCard
            label="Chain Integrity"
            value="Verified"
            icon={Link2}
            loading={false}
          />
        </div>

        <Tabs defaultValue="attestations" className="space-y-4">
          <TabsList>
            <TabsTrigger value="attestations" data-testid="tab-attestations">
              <FileCheck className="w-4 h-4 mr-1.5" />
              Attestations
            </TabsTrigger>
            <TabsTrigger value="repositories" data-testid="tab-repositories">
              <GitBranch className="w-4 h-4 mr-1.5" />
              Repositories
            </TabsTrigger>
            <TabsTrigger value="api-keys" data-testid="tab-api-keys">
              <Key className="w-4 h-4 mr-1.5" />
              API Keys
            </TabsTrigger>
          </TabsList>

          <TabsContent value="attestations">
            <Card>
              <div className="flex items-center justify-between gap-4 p-4 border-b border-border">
                <h3 className="font-semibold text-sm">Attestation Receipts</h3>
                <Badge variant="outline" className="text-xs">
                  {receipts?.length ?? 0} total
                </Badge>
              </div>
              {receiptsLoading ? (
                <LoadingRows />
              ) : receipts && receipts.length > 0 ? (
                <div className="divide-y divide-border">
                  {receipts.map((r) => (
                    <AttestationRow key={r.id} receipt={r} />
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={FileCheck}
                  title="No attestations yet"
                  desc="Attestation receipts will appear here when AI agents attest code in your repositories."
                />
              )}
            </Card>
          </TabsContent>

          <TabsContent value="repositories">
            <Card>
              <div className="flex items-center justify-between gap-4 p-4 border-b border-border">
                <h3 className="font-semibold text-sm">Connected Repositories</h3>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => syncReposMutation.mutate()}
                  disabled={syncReposMutation.isPending}
                  data-testid="button-sync-repos"
                >
                  <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${syncReposMutation.isPending ? "animate-spin" : ""}`} />
                  Sync from GitHub
                </Button>
              </div>
              {reposLoading ? (
                <LoadingRows />
              ) : repos && repos.length > 0 ? (
                <div className="divide-y divide-border">
                  {repos.map((r) => (
                    <RepositoryRow key={r.id} repo={r} />
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={GitBranch}
                  title="No repositories connected"
                  desc="Click 'Sync from GitHub' to import your repositories."
                />
              )}
            </Card>
          </TabsContent>

          <TabsContent value="api-keys">
            <Card>
              <div className="flex items-center justify-between gap-4 p-4 border-b border-border">
                <h3 className="font-semibold text-sm">API Keys</h3>
                <CreateApiKeyDialog />
              </div>
              {keysLoading ? (
                <LoadingRows />
              ) : keys && keys.length > 0 ? (
                <div className="divide-y divide-border">
                  {keys.map((k) => (
                    <ApiKeyRow key={k.id} apiKey={k} onDelete={(id) => deleteKeyMutation.mutate(id)} />
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={Key}
                  title="No API keys"
                  desc="Create an API key to allow AI agents to submit attestation receipts programmatically."
                />
              )}
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
