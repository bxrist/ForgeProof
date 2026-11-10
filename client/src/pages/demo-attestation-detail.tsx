import { Link, useParams } from "wouter";
import { ArrowLeft, ArrowRight, FileCheck } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { SEO } from "@/components/SEO";
import { useDemoLifecycle, illustrationStage } from "@/hooks/use-demo-lifecycle";

export default function DemoAttestationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { receipts, update, advance, reset } = useDemoLifecycle();
  const receipt = receipts.find(item => item.id === id);
  if (!receipt) return (
    <div className="min-h-[100dvh] bg-background flex flex-col items-center justify-center p-6 gap-4">
      <FileCheck className="w-10 h-10 text-muted-foreground" />
      <h1 className="font-display text-xl font-semibold">Illustration not found</h1>
      <p className="text-sm text-muted-foreground max-w-md text-center">Production receipt IDs are not used in this demo. Choose a local example instead; no production evidence has been fetched.</p>
      <Link href="/demo" className="text-primary underline">Back to local illustration</Link>
    </div>
  );
  const children = receipts.filter(item => item.parent === receipt.id);
  return (
    <div className="min-h-[100dvh] bg-background">
      <SEO title="Illustrative declaration" description="Local lifecycle simulation, not a real signed receipt." path={`/demo/attestation/${receipt.id}`} />
      <header className="border-b border-border bg-background/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <Link href="/demo" className="flex items-center gap-2 text-sm"><ArrowLeft className="w-4 h-4" />Back to illustration</Link>
          <Badge variant="outline">No production evidence</Badge>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <Card className="p-6 space-y-3">
          <Badge variant="outline">Local fixture · {receipt.id}</Badge>
          <h1 className="font-display text-xl font-semibold">{receipt.name} · {receipt.type}</h1>
          <p className="text-sm text-muted-foreground break-all">{receipt.path}</p>
          <p className="text-sm">Declared model: {receipt.model} · {receipt.provider}</p>
          <p className="text-sm text-muted-foreground">Declared origin: UNKNOWN · unverified</p>
          <p className="text-xs text-muted-foreground">This example has no real receipt hash, source commit, cryptographic signature, certificate, or production export. A simulated comparison below is a plain local text comparison, not cryptographic verification.</p>
        </Card>
        <Card className="p-6 space-y-4">
          <div className="flex justify-between gap-3 flex-wrap"><h2 className="font-semibold text-sm">Interactive lifecycle</h2><Badge variant="outline">{illustrationStage(receipt)}</Badge></div>
          <ol className="grid gap-2 md:grid-cols-4 text-xs">{["Draft declaration", "Simulate signature", "Compare local text", "Simulate archive"].map((step, index) => <li key={step} className={`p-3 rounded-md border ${index === receipt.stage ? "border-primary bg-primary/5" : "border-border text-muted-foreground"}`}>{index + 1}. {step}</li>)}</ol>
          <label htmlFor="illustration-content" className="block text-sm font-medium">Illustrative content</label>
          <Textarea id="illustration-content" className="font-mono text-xs" value={receipt.content} onChange={event => update(receipt.id, { content: event.target.value, result: undefined, stage: receipt.stage > 1 ? 1 : receipt.stage })} />
          <p className="text-xs text-muted-foreground">Simulate signing to capture this text. Edit it afterward, then compare to demonstrate a mismatch.</p>
          {receipt.result && <p role="status" className={receipt.result === "mismatch" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>{receipt.result === "match" ? "Simulated match: current text equals the captured text. No signature was verified." : "Simulated mismatch: text changed after capture. Reset the illustration to start over."}</p>}
          <div className="flex gap-3 flex-wrap">
            <Button disabled={receipt.stage === 3 || receipt.result === "mismatch"} onClick={() => advance(receipt.id)}>{["Simulate signing", "Simulate comparison", "Simulate archive", "Illustration complete"][receipt.stage]}</Button>
            <Button variant="outline" onClick={reset}>Reset all examples</Button>
          </div>
        </Card>
        <Card className="p-6 space-y-4">
          <h2 className="font-semibold text-sm">Parent/child lineage</h2>
          <p className="text-xs text-muted-foreground">These illustrative relationships are not ledger prevEntryHash links. Model declarations do not independently prove authorship or a file-level audit.</p>
          {receipt.parent && <Link href={`/demo/attestation/${receipt.parent}`} className="block text-sm text-primary underline">Open parent declaration</Link>}
          {children.map(child => <Link key={child.id} href={`/demo/attestation/${child.id}`} className="flex items-center gap-2 text-sm text-primary"><ArrowRight className="w-4 h-4" />Open child {child.type} declaration</Link>)}
          <p className="text-xs text-muted-foreground">Optional receipt archive: {receipt.stage === 3 ? "simulated only; no Git commit created" : "absent; no Git commit created"}. Original source commit and source manifest: not available in this illustration.</p>
        </Card>
        <Card className="p-6 space-y-2">
          <h2 className="font-semibold text-sm">Evidence boundary</h2>
          <p className="text-sm text-muted-foreground">In the real console, a verified source manifest means its hash matches the receipt and its signature is valid. A manifest listing 816 files still has one receipt signature, not 816 individual audits.</p>
          <p className="text-xs text-muted-foreground">Authentication, billing, source hashes, signatures, AI authorship and execution location have not been verified by this demo. No payment is needed to explore it.</p>
        </Card>
      </main>
    </div>
  );
}
