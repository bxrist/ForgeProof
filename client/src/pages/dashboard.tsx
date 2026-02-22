import { useState, useMemo, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { AttestationReceipt, Repository, ApiKey, Organization, AuditLog } from "@shared/schema";
import { ForgeProofLogo } from "@/components/ForgeProofLogo";
import { useTheme } from "@/components/ThemeProvider";
import { OnboardingWalkthrough } from "@/components/OnboardingWalkthrough";
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
  Moon,
  Sun,
  Copy,
  RefreshCw,
  LogOut,
  BarChart3,
  Trash2,
  ChevronRight,
  Search,
  Filter,
  CheckCircle2,
  Info,
  Building,
  Users,
  Activity,
  Mail,
  Save,
} from "lucide-react";
import { SiGithub } from "react-icons/si";
import { SEO } from "@/components/SEO";

function formatRelativeTime(date: Date | string | null | undefined): string {
  if (!date) return "";
  const now = new Date();
  const then = new Date(date);
  const diffMs = now.getTime() - then.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth} month${diffMonth === 1 ? "" : "s"} ago`;
  const diffYear = Math.floor(diffMonth / 12);
  return `${diffYear} year${diffYear === 1 ? "" : "s"} ago`;
}

function getAuditLogIcon(action: string) {
  if (action.startsWith("api_key")) return Key;
  if (action.startsWith("repository")) return GitBranch;
  if (action.startsWith("org")) return Building;
  if (action.startsWith("notifications")) return Mail;
  return Activity;
}

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

function getAttestationTypeBadge(type: string | null | undefined) {
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

function getAuditVerdictDisplay(verdict: string | null | undefined) {
  if (!verdict) return null;
  switch (verdict) {
    case "secure":
      return <span className="text-xs text-green-600 dark:text-green-400 font-medium" data-testid="text-verdict-secure"><CheckCircle2 className="w-3 h-3 inline mr-0.5" /> Secure</span>;
    case "flagged":
      return <span className="text-xs text-red-600 dark:text-red-400 font-medium" data-testid="text-verdict-flagged"><Info className="w-3 h-3 inline mr-0.5" /> Flagged</span>;
    case "remediated":
      return <span className="text-xs text-blue-600 dark:text-blue-400 font-medium" data-testid="text-verdict-remediated"><RefreshCw className="w-3 h-3 inline mr-0.5" /> Remediated</span>;
    case "needs_review":
      return <span className="text-xs text-yellow-600 dark:text-yellow-400 font-medium" data-testid="text-verdict-needs-review"><Clock className="w-3 h-3 inline mr-0.5" /> Needs Review</span>;
    default:
      return null;
  }
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
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm truncate">{receipt.fileName}</span>
          {getAttestationTypeBadge(receipt.attestationType)}
          {receipt.parentAttestationId && (
            <Link2 className="w-3 h-3 text-muted-foreground shrink-0" data-testid={`icon-parent-link-${receipt.id}`} />
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground truncate">{receipt.filePath}</span>
          {getAuditVerdictDisplay(receipt.auditVerdict)}
        </div>
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

function RepositoryRow({ repo, onDelete }: { repo: Repository; onDelete: (id: number) => void }) {
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
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onDelete(repo.id)}
        data-testid={`button-delete-repo-${repo.id}`}
      >
        <Trash2 className="w-4 h-4 text-muted-foreground" />
      </Button>
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
      toast({ title: "API key created successfully" });
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

function CreateOrgDialog() {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [open, setOpen] = useState(false);
  const { toast } = useToast();

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; description: string }) => {
      const res = await apiRequest("POST", "/api/organizations", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/organizations"] });
      toast({ title: "Team created successfully" });
      setOpen(false);
      setName("");
      setDescription("");
    },
    onError: () => {
      toast({ title: "Failed to create team", variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="button-create-team">
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          Create Team
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Team</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-1.5 block">Team Name</label>
            <Input
              placeholder="e.g., Engineering"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="input-team-name"
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1.5 block">Description</label>
            <Textarea
              placeholder="What does this team work on?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="resize-none"
              data-testid="input-team-description"
            />
          </div>
          <Button
            className="w-full"
            onClick={() => createMutation.mutate({ name, description })}
            disabled={!name.trim() || createMutation.isPending}
            data-testid="button-submit-team"
          >
            {createMutation.isPending ? "Creating..." : "Create Team"}
          </Button>
        </div>
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

function LoadingCards() {
  return (
    <div className="space-y-3 p-4">
      {[1, 2, 3].map((i) => (
        <Card key={i} className="p-4">
          <div className="flex items-center gap-4">
            <Skeleton className="w-10 h-10 rounded-md" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-56" />
            </div>
            <Skeleton className="h-8 w-20 rounded-md" />
          </div>
        </Card>
      ))}
    </div>
  );
}

function LoadingTimeline() {
  return (
    <div className="space-y-3 p-4">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex items-start gap-3">
          <Skeleton className="w-8 h-8 rounded-md shrink-0" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  url: string;
  description: string | null;
  default_branch: string;
  private: boolean;
}

function GitHubRepoSyncPanel() {
  const { toast } = useToast();
  const [ghRepos, setGhRepos] = useState<GitHubRepo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [showPanel, setShowPanel] = useState(false);

  const fetchGhRepos = async () => {
    setLoadingRepos(true);
    try {
      const res = await fetch("/api/github/repos", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setGhRepos(data);
      setShowPanel(true);
    } catch {
      toast({ title: "Failed to fetch GitHub repos", variant: "destructive" });
    } finally {
      setLoadingRepos(false);
    }
  };

  const addRepoMutation = useMutation({
    mutationFn: async (repo: GitHubRepo) => {
      const res = await apiRequest("POST", "/api/repositories", {
        githubId: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        url: repo.url,
        defaultBranch: repo.default_branch,
        description: repo.description,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/repositories"] });
      toast({ title: "Repository added" });
    },
    onError: () => {
      toast({ title: "Failed to add repository", variant: "destructive" });
    },
  });

  return (
    <div>
      <Button
        variant="outline"
        size="sm"
        onClick={fetchGhRepos}
        disabled={loadingRepos}
        data-testid="button-sync-gh-repos"
      >
        <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loadingRepos ? "animate-spin" : ""}`} />
        Sync Repos
      </Button>
      {showPanel && ghRepos.length > 0 && (
        <Card className="mt-4">
          <div className="flex items-center justify-between gap-4 p-4 border-b border-border">
            <h3 className="font-semibold text-sm">Available GitHub Repos</h3>
            <Badge variant="outline" className="text-xs">{ghRepos.length} repos</Badge>
          </div>
          <div className="divide-y divide-border max-h-80 overflow-y-auto">
            {ghRepos.map((repo) => (
              <div key={repo.id} className="flex items-center gap-4 p-3" data-testid={`row-gh-repo-${repo.id}`}>
                <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center shrink-0">
                  <SiGithub className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">{repo.full_name}</div>
                  {repo.description && (
                    <div className="text-xs text-muted-foreground truncate">{repo.description}</div>
                  )}
                </div>
                {repo.private && <Badge variant="secondary" className="text-xs">Private</Badge>}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => addRepoMutation.mutate(repo)}
                  disabled={addRepoMutation.isPending}
                  data-testid={`button-add-repo-${repo.id}`}
                >
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  Add
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}
      {showPanel && ghRepos.length === 0 && !loadingRepos && (
        <p className="text-sm text-muted-foreground mt-3">No repos found on your GitHub account.</p>
      )}
    </div>
  );
}

function NotificationPreferences() {
  const { toast } = useToast();
  const { data: prefs, isLoading } = useQuery<{ notificationEmail: string | null }>({
    queryKey: ["/api/notifications/preferences"],
  });
  const [email, setEmail] = useState("");
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (prefs && !initialized) {
      setEmail(prefs.notificationEmail || "");
      setInitialized(true);
    }
  }, [prefs, initialized]);

  const saveMutation = useMutation({
    mutationFn: async (notificationEmail: string) => {
      await apiRequest("POST", "/api/notifications/preferences", { notificationEmail });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/notifications/preferences"] });
      toast({ title: "Notification preferences saved" });
    },
    onError: () => {
      toast({ title: "Failed to save preferences", variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="p-4 space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  return (
    <Card className="mt-4">
      <div className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Mail className="w-4 h-4 text-muted-foreground" />
          <h3 className="font-semibold text-sm">Notification Preferences</h3>
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="email"
            placeholder="Enter notification email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => {
              if (email !== (prefs?.notificationEmail || "")) {
                saveMutation.mutate(email);
              }
            }}
            data-testid="input-notification-email"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => saveMutation.mutate(email)}
            disabled={saveMutation.isPending}
            data-testid="button-save-notification-email"
          >
            <Save className="w-3.5 h-3.5 mr-1.5" />
            Save
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function DashboardPage() {
  const { user, isLoading: authLoading, logout } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { theme, toggleTheme } = useTheme();
  const [searchQuery, setSearchQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [complianceFilter, setComplianceFilter] = useState("all");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("github") === "connected") {
      toast({ title: "GitHub connected successfully" });
      window.history.replaceState({}, "", window.location.pathname);
    } else if (params.get("github") === "error") {
      toast({ title: "Failed to connect GitHub", variant: "destructive" });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const { data: receipts, isLoading: receiptsLoading } = useQuery<AttestationReceipt[]>({
    queryKey: ["/api/attestations"],
  });

  const { data: repos, isLoading: reposLoading } = useQuery<Repository[]>({
    queryKey: ["/api/repositories"],
  });

  const { data: keys, isLoading: keysLoading } = useQuery<ApiKey[]>({
    queryKey: ["/api/api-keys"],
  });

  const { data: githubStatus } = useQuery<{ configured: boolean; connected: boolean }>({
    queryKey: ["/api/github/status"],
  });

  const { data: orgs, isLoading: orgsLoading } = useQuery<Organization[]>({
    queryKey: ["/api/organizations"],
  });

  const { data: auditLogs, isLoading: auditLogsLoading } = useQuery<AuditLog[]>({
    queryKey: ["/api/audit-logs"],
  });

  const uniqueProviders = useMemo(() => {
    if (!receipts) return [];
    return Array.from(new Set(receipts.map((r) => r.modelProvider))).sort();
  }, [receipts]);

  const filteredReceipts = useMemo(() => {
    if (!receipts) return [];
    return receipts.filter((r) => {
      const query = searchQuery.toLowerCase();
      const matchesSearch =
        !query ||
        r.fileName.toLowerCase().includes(query) ||
        r.filePath.toLowerCase().includes(query);
      const matchesProvider =
        providerFilter === "all" || r.modelProvider === providerFilter;
      const matchesCompliance =
        complianceFilter === "all" ||
        (r.complianceStatus || "unverified").toLowerCase() === complianceFilter.toLowerCase();
      return matchesSearch && matchesProvider && matchesCompliance;
    });
  }, [receipts, searchQuery, providerFilter, complianceFilter]);

  const deleteKeyMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/api-keys/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/api-keys"] });
      toast({ title: "API key deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete API key", variant: "destructive" });
    },
  });

  const deleteRepoMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/repositories/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/repositories"] });
      toast({ title: "Repository removed" });
    },
    onError: () => {
      toast({ title: "Failed to remove repository", variant: "destructive" });
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

  const deleteOrgMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/organizations/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/organizations"] });
      toast({ title: "Team deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete team", variant: "destructive" });
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
      <SEO title="Dashboard" description="Manage your attestation receipts, repositories, API keys, and team settings." path="/dashboard" />
      <OnboardingWalkthrough />
      <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-4 h-16">
            <Link href="/" className="flex items-center gap-2">
              <ForgeProofLogo size={44} />
              <span className="font-display font-bold text-xl tracking-tight">ForgeProof</span>
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
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleTheme}
                data-testid="button-dashboard-theme-toggle"
                className="w-8 h-8"
              >
                {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </Button>
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
          <TabsList className="flex-wrap">
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
            <TabsTrigger value="teams" data-testid="tab-teams">
              <Users className="w-4 h-4 mr-1.5" />
              Teams
            </TabsTrigger>
            <TabsTrigger value="activity-log" data-testid="tab-activity-log">
              <Activity className="w-4 h-4 mr-1.5" />
              Activity Log
            </TabsTrigger>
          </TabsList>

          <TabsContent value="attestations">
            <Card>
              <div className="flex items-center justify-between gap-4 p-4 border-b border-border">
                <h3 className="font-semibold text-sm">Attestation Receipts</h3>
                <Badge variant="outline" className="text-xs">
                  {filteredReceipts.length} of {receipts?.length ?? 0}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-3 p-4 border-b border-border">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by file name or path..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9"
                    data-testid="input-dashboard-search"
                  />
                </div>
                <Select value={providerFilter} onValueChange={setProviderFilter}>
                  <SelectTrigger className="w-[180px]" data-testid="select-dashboard-provider">
                    <Filter className="w-3.5 h-3.5 mr-1.5 text-muted-foreground" />
                    <SelectValue placeholder="Provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Providers</SelectItem>
                    {uniqueProviders.map((p) => (
                      <SelectItem key={p} value={p}>{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={complianceFilter} onValueChange={setComplianceFilter}>
                  <SelectTrigger className="w-[180px]" data-testid="select-dashboard-compliance">
                    <Filter className="w-3.5 h-3.5 mr-1.5 text-muted-foreground" />
                    <SelectValue placeholder="Compliance" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="verified">Verified</SelectItem>
                    <SelectItem value="mismatch">Mismatch</SelectItem>
                    <SelectItem value="unverified">Unverified</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {receiptsLoading ? (
                <LoadingRows />
              ) : filteredReceipts.length > 0 ? (
                <div className="divide-y divide-border">
                  {filteredReceipts.map((r) => (
                    <AttestationRow key={r.id} receipt={r} />
                  ))}
                </div>
              ) : receipts && receipts.length > 0 ? (
                <EmptyState
                  icon={Search}
                  title="No matching attestations"
                  desc="Try adjusting your search or filter criteria."
                />
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
            <Card className="mb-4">
              <div className="flex items-center justify-between gap-4 p-4">
                {githubStatus?.connected ? (
                  <>
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-md bg-green-500/10 dark:bg-green-500/20 flex items-center justify-center shrink-0">
                        <CheckCircle2 className="w-4.5 h-4.5 text-green-600 dark:text-green-400" />
                      </div>
                      <div>
                        <div className="font-medium text-sm">GitHub Connected</div>
                        <div className="text-xs text-muted-foreground">Your GitHub account is linked</div>
                      </div>
                    </div>
                    <GitHubRepoSyncPanel />
                  </>
                ) : !githubStatus?.configured ? (
                  <>
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-md bg-muted flex items-center justify-center shrink-0">
                        <Info className="w-4.5 h-4.5 text-muted-foreground" />
                      </div>
                      <div>
                        <div className="font-medium text-sm">GitHub OAuth is not configured</div>
                        <div className="text-xs text-muted-foreground">Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to enable GitHub integration</div>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                        <SiGithub className="w-4.5 h-4.5 text-primary" />
                      </div>
                      <div>
                        <div className="font-medium text-sm">Connect your GitHub account</div>
                        <div className="text-xs text-muted-foreground">Link GitHub to sync repositories and attest code</div>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      onClick={async () => {
                        try {
                          const res = await fetch("/api/github/connect", { credentials: "include" });
                          const data = await res.json();
                          if (data.url) {
                            window.location.href = data.url;
                          }
                        } catch {
                          toast({ title: "Failed to initiate GitHub connection", variant: "destructive" });
                        }
                      }}
                      data-testid="button-connect-github"
                    >
                      <SiGithub className="w-3.5 h-3.5 mr-1.5" />
                      Connect GitHub
                    </Button>
                  </>
                )}
              </div>
            </Card>
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
                    <RepositoryRow key={r.id} repo={r} onDelete={(id) => deleteRepoMutation.mutate(id)} />
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
            <NotificationPreferences />
          </TabsContent>

          <TabsContent value="teams">
            <Card>
              <div className="flex items-center justify-between gap-4 p-4 border-b border-border">
                <h3 className="font-semibold text-sm">Teams</h3>
                <CreateOrgDialog />
              </div>
              {orgsLoading ? (
                <LoadingCards />
              ) : orgs && orgs.length > 0 ? (
                <div className="divide-y divide-border">
                  {orgs.map((org) => (
                    <div key={org.id} className="flex items-center gap-4 p-4" data-testid={`row-team-${org.id}`}>
                      <div className="w-9 h-9 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                        <Building className="w-4.5 h-4.5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm">{org.name}</div>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <Badge variant="outline" className="text-xs">{org.slug}</Badge>
                          {org.description && (
                            <span className="text-xs text-muted-foreground truncate">{org.description}</span>
                          )}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => deleteOrgMutation.mutate(org.id)}
                        data-testid={`button-delete-team-${org.id}`}
                      >
                        <Trash2 className="w-4 h-4 text-muted-foreground" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={Users}
                  title="No teams yet"
                  desc="Create a team to collaborate with others on attestation receipts."
                />
              )}
            </Card>
          </TabsContent>

          <TabsContent value="activity-log">
            <Card>
              <div className="flex items-center justify-between gap-4 p-4 border-b border-border">
                <h3 className="font-semibold text-sm">Activity Log</h3>
                <Badge variant="outline" className="text-xs" data-testid="text-audit-log-count">
                  {auditLogs?.length ?? 0} events
                </Badge>
              </div>
              {auditLogsLoading ? (
                <LoadingTimeline />
              ) : auditLogs && auditLogs.length > 0 ? (
                <div className="divide-y divide-border">
                  {auditLogs.map((log) => {
                    const LogIcon = getAuditLogIcon(log.action);
                    return (
                      <div key={log.id} className="flex items-start gap-3 p-4" data-testid={`row-audit-log-${log.id}`}>
                        <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center shrink-0 mt-0.5">
                          <LogIcon className="w-4 h-4 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm">{log.action.replace(/[._]/g, " ")}</div>
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            {log.resourceType && (
                              <Badge variant="secondary" className="text-xs">{log.resourceType}</Badge>
                            )}
                            {log.resourceId && (
                              <span className="text-xs text-muted-foreground">#{log.resourceId}</span>
                            )}
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground whitespace-nowrap shrink-0" data-testid={`text-audit-log-time-${log.id}`}>
                          {formatRelativeTime(log.createdAt)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <EmptyState
                  icon={Activity}
                  title="No activity yet"
                  desc="Your activity log will appear here as you use ForgeProof."
                />
              )}
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
