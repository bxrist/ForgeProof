import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, ChevronRight, FileCheck, GitBranch, Moon, Sun, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ForgeProofLogo } from "@/components/ForgeProofLogo";
import { useTheme } from "@/components/ThemeProvider";
import { SEO } from "@/components/SEO";
import { useDemoLifecycle, illustrationStage } from "@/hooks/use-demo-lifecycle";

export default function DemoPage() {
  const { theme, toggleTheme } = useTheme();
  const { receipts, advance, reset } = useDemoLifecycle();
  const [search, setSearch] = useState("");
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");
  const filtered = useMemo(() => receipts.filter(receipt =>
    `${receipt.name} ${receipt.path} ${receipt.model} ${receipt.id}`.toLowerCase().includes(search.toLowerCase()) &&
    (type === "all" || receipt.type === type) && (status === "all" || String(receipt.stage) === status)
  ), [receipts, search, type, status]);
  return (
    <div className="min-h-[100dvh] bg-background">
      <SEO title="Illustrative lifecycle demo" description="Explore a local, interactive receipt lifecycle. No real signatures, customer data, or production evidence." path="/demo" />
      <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 min-h-16 flex items-center justify-between gap-3 py-2">
          <Link href="/" className="flex items-center gap-2"><ForgeProofLogo size={44} /><span className="font-display font-bold text-xl tracking-tight">ForgeProof</span></Link>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="Toggle theme" data-testid="button-demo-theme-toggle">{theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}</Button>
            <Link href="/sdk" className="text-sm text-muted-foreground hover:text-foreground">SDK</Link>
            <Link href="/" className="flex items-center gap-1 text-sm"><ArrowLeft className="w-4 h-4" />Home</Link>
          </div>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div>
          <Badge variant="outline" className="mb-3">Isolated illustration · local fixtures only</Badge>
          <h1 className="font-display text-2xl font-bold tracking-tight">Explore the receipt lifecycle</h1>
          <p className="text-sm text-muted-foreground mt-2 max-w-3xl">Capture a declaration, simulate signing, compare content, then simulate an archive. Nothing here is production evidence. No API calls, real receipt IDs, signatures, certificate exports, or payment required.</p>
        </div>
        <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
          <Card className="p-5 space-y-3">
            <h2 className="font-semibold text-sm flex items-center gap-2"><FileCheck className="w-4 h-4 text-primary" />Three example declarations, one linked story</h2>
            <p className="text-sm text-muted-foreground">Origin → review → refactor. Each declaration remains distinct. Parent/child lineage describes a relationship; ledger prevEntryHash describes ordering, not ancestry.</p>
            <p className="text-xs text-muted-foreground">Open an example to edit its content after capture and see a simulated mismatch. UNKNOWN origin never becomes a location verification pass.</p>
          </Card>
          <Card className="p-5 space-y-3">
            <h2 className="font-semibold text-sm">What a real certificate can establish</h2>
            <p className="text-sm text-muted-foreground">Valid hashes and signatures establish signed-content integrity. They do not independently establish AI authorship, execution location, or a security audit of each file.</p>
            <p className="text-xs text-muted-foreground">Example: an 816-file source manifest can be bound to one receipt signature. That is not 816 individual signatures or audits.</p>
          </Card>
        </div>
        <div className="flex flex-col md:flex-row gap-3">
          <Input aria-label="Search illustrative receipts" placeholder="Search example path, model, or label…" value={search} onChange={event => setSearch(event.target.value)} className="flex-1" data-testid="input-search" />
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="md:w-44" aria-label="Declaration type"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All types</SelectItem><SelectItem value="origin">Origin</SelectItem><SelectItem value="review">Review</SelectItem><SelectItem value="refactor">Refactor</SelectItem></SelectContent>
          </Select>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="md:w-52" aria-label="Illustration stage"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All stages</SelectItem><SelectItem value="0">Draft example</SelectItem><SelectItem value="1">Signature simulated</SelectItem><SelectItem value="2">Comparison simulated</SelectItem><SelectItem value="3">Archive simulated</SelectItem></SelectContent>
          </Select>
        </div>
        <Card>
          <div className="flex justify-between gap-3 p-4 border-b border-border items-center"><h2 className="font-semibold text-sm">Illustrative declarations</h2><Badge variant="outline">{filtered.length} of {receipts.length}</Badge></div>
          <div className="divide-y divide-border">
            {filtered.map(receipt => (
              <div className="p-4 flex flex-col sm:flex-row gap-3 sm:items-center" key={receipt.id} data-testid={`row-demo-attestation-${receipt.id}`}>
                <Link href={`/demo/attestation/${receipt.id}`} className="flex items-center gap-3 flex-1 min-w-0 group">
                  <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0"><GitBranch className="w-4 h-4 text-primary" /></div>
                  <div className="min-w-0"><p className="text-sm font-medium group-hover:text-primary">{receipt.name} · {receipt.type}</p><p className="text-xs text-muted-foreground break-all">{receipt.path}</p><p className="text-xs text-muted-foreground mt-1">{receipt.model} · origin UNKNOWN</p></div>
                  <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground" />
                </Link>
                <Badge variant="outline" className="self-start sm:self-auto">{illustrationStage(receipt)}</Badge>
                <Button size="sm" variant="outline" disabled={receipt.stage === 3 || receipt.result === "mismatch"} onClick={() => advance(receipt.id)}>
                  {["Simulate signing", "Simulate comparison", "Simulate archive", "Illustration complete"][receipt.stage]}
                </Button>
              </div>
            ))}
            {!filtered.length && <div className="text-center py-12 px-5"><FileCheck className="mx-auto w-8 h-8 text-muted-foreground mb-3" /><h3 className="text-sm font-semibold">No matching examples</h3><p className="text-sm text-muted-foreground mb-3">Try another path or clear your filters.</p><Button variant="outline" onClick={() => { setSearch(""); setType("all"); setStatus("all"); }}>Clear filters</Button></div>}
          </div>
        </Card>
        <div className="flex flex-col sm:flex-row justify-between gap-3 items-start">
          <p className="text-xs text-muted-foreground">Changes stay in this browser session. This standalone illustration works even if production APIs are empty or unavailable.</p>
          <Button variant="outline" size="sm" onClick={() => { reset(); setSearch(""); setType("all"); setStatus("all"); }}><RefreshCw className="w-3.5 h-3.5 mr-2" />Reset illustration</Button>
        </div>
      </main>
    </div>
  );
}
