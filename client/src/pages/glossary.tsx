import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ForgeProofLogo } from "@/components/ForgeProofLogo";
import { useTheme } from "@/components/ThemeProvider";
import { SEO } from "@/components/SEO";
import {
  ArrowLeft,
  Moon,
  Sun,
  BookOpen,
  Hash,
  Fingerprint,
  Layers,
  FileCheck,
  Shield,
  Globe,
  GitBranch,
  Lock,
  Link2,
  Cpu,
  Eye,
  Server,
} from "lucide-react";

interface Term {
  term: string;
  plainLanguage: string;
  technical: string;
  icon: typeof Hash;
  example?: string;
}

const terms: Term[] = [
  {
    term: "Attestation",
    plainLanguage: "A signed statement that something happened. Like a notarized document, but for code — cryptographic proof that a specific AI model generated a specific file at a specific time.",
    technical: "A digitally signed JSON receipt containing file hash, model identity, provider, timestamp, geographic origin, and a link to the previous entry in the hash chain. Signed with Ed25519.",
    icon: FileCheck,
    example: "\"GPT-4 generated auth.ts on Feb 21, 2026 from a US-based endpoint\" — signed and hash-chained.",
  },
  {
    term: "Provenance",
    plainLanguage: "The complete history of where something came from. For code, it answers: who wrote it, which tool was used, where was it processed, and when did it happen.",
    technical: "The chain of custody metadata attached to a software artifact, including origin (human or AI), toolchain, geographic jurisdiction, and temporal ordering. ForgeProof creates a cryptographic provenance record.",
    icon: GitBranch,
  },
  {
    term: "Artifact",
    plainLanguage: "Any file or piece of code that ForgeProof tracks. Think of it as the \"thing\" being attested — a source file, a configuration file, or any digital output from an AI model.",
    technical: "A software artifact is any file identified by its path and content hash. In ForgeProof, artifacts are identified by file_path and file_hash (SHA-256 of the file content).",
    icon: Layers,
    example: "src/utils/auth.ts with hash sha256:a3f2e8c1... is an artifact.",
  },
  {
    term: "Chain of Custody",
    plainLanguage: "An unbroken record showing every step a piece of code went through — from creation, through review, to deployment. If any step is missing or modified, the chain is broken and detectable.",
    technical: "A cryptographic hash chain where each attestation receipt includes the entry_hash of the previous receipt. Verification traverses the chain to confirm no entries have been inserted, removed, or reordered.",
    icon: Link2,
  },
  {
    term: "Lineage",
    plainLanguage: "The family tree of a piece of code. Which model created it, which model reviewed it, which model fixed the issues — all connected in sequence.",
    technical: "The sequence of attestation receipts associated with a single artifact across its lifecycle: origin attestation, security audit attestation, remediation attestation. Each receipt links to its predecessor via the hash chain.",
    icon: Layers,
    example: "File auth.ts: Origin (GPT-4) → Audit (Claude) → Remediation (Claude) — three linked attestations.",
  },
  {
    term: "Model Identity",
    plainLanguage: "The specific AI model that generated code — not just \"OpenAI\" but exactly \"GPT-4-turbo\" or \"claude-sonnet-4\". This is what gets recorded in every attestation.",
    technical: "Recorded as two fields: model_name (e.g., gpt-4-turbo) and model_provider (e.g., OpenAI). Used for analytics, compliance reporting, and provider separation enforcement in multi-model attestation.",
    icon: Cpu,
  },
  {
    term: "Entry Hash",
    plainLanguage: "A unique fingerprint for each attestation receipt. If even a single character in the receipt changes, the fingerprint changes completely — making tampering instantly detectable.",
    technical: "SHA-256 hash computed over the canonical JSON representation of an attestation receipt (excluding the entry_hash field itself). Used as the primary identifier and as input to the hash chain.",
    icon: Hash,
    example: "sha256:7b9e4d2f... — changes completely if any receipt field is modified.",
  },
  {
    term: "Hash Chain",
    plainLanguage: "A series of attestation receipts where each one is mathematically linked to the one before it. Like a chain — if you remove or change any link, the whole structure breaks and you can see it happened.",
    technical: "Each attestation receipt includes a prev_entry_hash field containing the entry_hash of the immediately preceding receipt. Verification starts from the first entry and confirms each link. A broken chain indicates tampering.",
    icon: Link2,
  },
  {
    term: "Digital Signature (Ed25519)",
    plainLanguage: "A mathematical proof that a receipt was created by ForgeProof and hasn't been modified. Anyone can verify the signature using the public key, without needing to trust ForgeProof itself.",
    technical: "Ed25519 is an elliptic curve signature scheme using Curve25519. Provides 128-bit security, fast signing (< 1ms), small signatures (64 bytes), and deterministic output. ForgeProof signs the full receipt content.",
    icon: Fingerprint,
  },
  {
    term: "SHA-256",
    plainLanguage: "A one-way mathematical function that turns any amount of data into a fixed 64-character fingerprint. Used to create unique identifiers for files and to build the hash chain.",
    technical: "A cryptographic hash function from the SHA-2 family producing a 256-bit (32-byte) digest. Collision-resistant: no known practical method to find two different inputs that produce the same hash. Used for file_hash and entry_hash in ForgeProof.",
    icon: Hash,
  },
  {
    term: "Provider Separation",
    plainLanguage: "A rule that says the AI model that wrote code cannot be the same model that certifies it's secure. It's like requiring an independent auditor — you can't audit your own work.",
    technical: "ForgeProof enforces that security audit attestations must come from a different model_provider than the origin attestation. The API rejects audit attestations where the audit provider matches the origin provider.",
    icon: Shield,
  },
  {
    term: "Receipt",
    plainLanguage: "The output of an attestation — a signed document containing all the provenance metadata for a specific file. Think of it as a digital certificate of origin.",
    technical: "A JSON object containing: receipt_version, file_path, file_hash, model_name, model_provider, country_of_origin, timestamp, signature (Ed25519), entry_hash (SHA-256), prev_entry_hash, and optional attestation_type and repository fields.",
    icon: FileCheck,
  },
  {
    term: "Sovereign Model",
    plainLanguage: "An AI model that processes data within a specific country or jurisdiction. Important for organizations that need to keep their code within national borders for regulatory reasons.",
    technical: "A model operating within a declared geographic jurisdiction. ForgeProof records the country_of_origin for each attestation, enabling compliance verification against GDPR, CCPA, and data residency requirements.",
    icon: Globe,
  },
  {
    term: "Tamper-Evident",
    plainLanguage: "Not tamper-proof (nothing is), but tamper-evident — if someone modifies the data, the modification is mathematically detectable. Like a sealed envelope that shows if it's been opened.",
    technical: "Achieved through the combination of Ed25519 signatures (receipt integrity) and SHA-256 hash chains (ledger integrity). Any modification to a receipt breaks its signature; any modification to the ledger breaks the chain.",
    icon: Lock,
  },
  {
    term: "SBOM (Software Bill of Materials)",
    plainLanguage: "A complete list of all components in a piece of software — like an ingredients list for code. ForgeProof adds AI provenance data to this list.",
    technical: "A machine-readable document (typically SPDX or CycloneDX format) listing all components, dependencies, and their metadata. ForgeProof's roadmap includes SBOM generation with provenance data embedded.",
    icon: Layers,
  },
  {
    term: "SLSA (Supply-chain Levels for Software Artifacts)",
    plainLanguage: "An industry framework for securing the software build process. SLSA proves a binary was built from specific source code — but doesn't track which AI wrote that source code. ForgeProof fills this gap.",
    technical: "A Google-originated framework defining security levels for build integrity. SLSA provenance attests to build processes; ForgeProof attests to code generation processes. The two are complementary: ForgeProof → SLSA covers generation through build.",
    icon: Shield,
  },
];

export default function GlossaryPage() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="min-h-screen bg-background">
      <SEO
        title="Terminology - ForgeProof"
        description="Definitions of key terms in code provenance and software supply chain security: attestation, provenance, hash chain, Ed25519, and more."
        path="/glossary"
      />

      <nav className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <Link href="/" className="flex items-center gap-2">
              <ForgeProofLogo size={36} />
              <span className="font-display font-bold text-lg">ForgeProof</span>
            </Link>
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={toggleTheme} className="w-8 h-8" data-testid="button-theme-toggle">
                {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </Button>
              <Link href="/">
                <Button variant="outline" size="sm" data-testid="button-back-home">
                  <ArrowLeft className="w-4 h-4 mr-1.5" />
                  Back to Home
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </nav>

      <main className="pt-24 pb-16">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="mb-12">
            <Badge variant="outline" className="mb-4">
              <BookOpen className="w-3 h-3 mr-1" />
              Reference
            </Badge>
            <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mb-4" data-testid="heading-glossary">
              Terminology
            </h1>
            <p className="text-lg text-muted-foreground leading-relaxed max-w-3xl">
              Key terms used throughout ForgeProof and in the broader software supply chain security space. Each term includes a plain-language explanation and technical detail.
            </p>
          </div>

          <div className="space-y-6">
            {terms.map((item, i) => (
              <Card key={item.term} className="p-6" id={item.term.toLowerCase().replace(/[^a-z0-9]+/g, "-")} data-testid={`card-term-${i}`}>
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                    <item.icon className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-display text-lg font-semibold mb-3">{item.term}</h3>

                    <div className="mb-3">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">In plain language</p>
                      <p className="text-sm leading-relaxed">{item.plainLanguage}</p>
                    </div>

                    <div className="mb-3">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Technical detail</p>
                      <p className="text-sm text-muted-foreground leading-relaxed">{item.technical}</p>
                    </div>

                    {item.example && (
                      <div className="bg-muted/50 rounded-md p-3">
                        <p className="text-xs font-semibold text-muted-foreground mb-1">Example</p>
                        <p className="text-sm font-mono text-muted-foreground">{item.example}</p>
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>

          <Card className="mt-12 p-6 sm:p-8 bg-primary/5 dark:bg-primary/10 border-primary/20">
            <div className="text-center">
              <h3 className="font-display text-lg font-semibold mb-3">Learn More</h3>
              <p className="text-sm text-muted-foreground mb-4 max-w-lg mx-auto">
                Explore ForgeProof's security model, API documentation, and verification tools.
              </p>
              <div className="flex flex-wrap justify-center gap-3">
                <Link href="/threat-model">
                  <Button variant="outline" data-testid="link-threat-model">
                    <Shield className="w-4 h-4 mr-2" />
                    Threat Model
                  </Button>
                </Link>
                <Link href="/sdk">
                  <Button variant="outline" data-testid="link-sdk">
                    <Layers className="w-4 h-4 mr-2" />
                    SDK Docs
                  </Button>
                </Link>
                <Link href="/verify">
                  <Button variant="outline" data-testid="link-verify">
                    <Eye className="w-4 h-4 mr-2" />
                    Verify Chain
                  </Button>
                </Link>
              </div>
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
}