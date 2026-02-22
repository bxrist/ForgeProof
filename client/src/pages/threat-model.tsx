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
  Shield,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Lock,
  Eye,
  Fingerprint,
  Hash,
  Layers,
  Server,
  Users,
  FileCheck,
} from "lucide-react";

export default function ThreatModelPage() {
  const { theme, toggleTheme } = useTheme();

  const proves = [
    {
      claim: "Which AI model produced a given file",
      mechanism: "Model name and provider recorded in signed attestation receipt at generation time",
    },
    {
      claim: "The file content has not been modified since attestation",
      mechanism: "SHA-256 hash of file content stored in receipt; any change produces a different hash",
    },
    {
      claim: "The attestation receipt has not been tampered with",
      mechanism: "Ed25519 digital signature over the full receipt; signature verification fails if any field is altered",
    },
    {
      claim: "The order and completeness of the attestation ledger",
      mechanism: "Each receipt includes the hash of the previous entry, forming a hash chain; inserting, removing, or reordering entries breaks the chain",
    },
    {
      claim: "That a security audit was performed by a different AI provider",
      mechanism: "Provider separation enforcement rejects audit attestations from the same provider as the origin attestation",
    },
    {
      claim: "The declared country of origin at attestation time",
      mechanism: "Country field recorded in the signed receipt; the declared jurisdiction is part of the cryptographic commitment",
    },
  ];

  const doesNotProve = [
    {
      claim: "That the declared model actually generated the code",
      explanation: "ForgeProof records the model identity as declared by the caller. A malicious caller could claim code was written by GPT-4 when it was written by hand. ForgeProof attests provenance claims, not ground truth.",
    },
    {
      claim: "That the code is free of vulnerabilities",
      explanation: "A security audit attestation records that an AI performed a review, not that the code is secure. The quality of the audit depends on the auditing model's capabilities.",
    },
    {
      claim: "That the country of origin is accurate",
      explanation: "The geographic jurisdiction is self-declared by the caller. ForgeProof does not independently verify the caller's location or the model's hosting location.",
    },
    {
      claim: "That the AI model was not compromised",
      explanation: "If an AI model is poisoned or compromised at the provider level, ForgeProof will faithfully attest the output. ForgeProof trusts the model identity, not the model behavior.",
    },
    {
      claim: "Prevention of code modification after attestation",
      explanation: "ForgeProof detects modifications (hash mismatch), but does not prevent them. It provides evidence, not enforcement.",
    },
  ];

  const trustAssumptions = [
    {
      assumption: "ForgeProof server integrity",
      detail: "The signing key is held by the ForgeProof server. If the server is compromised, an attacker could forge attestation receipts. Self-hosting mitigates this risk by keeping the signing key under your control.",
      mitigation: "Self-host ForgeProof on trusted infrastructure. Rotate signing keys periodically. Monitor audit logs for anomalous attestation patterns.",
    },
    {
      assumption: "API key holder identity",
      detail: "Anyone with a valid API key can create attestations. ForgeProof authenticates the key, not the identity of the human or machine using it.",
      mitigation: "Treat API keys like credentials. Rotate keys regularly. Scope keys to specific repositories or teams. Monitor API key usage in the audit log.",
    },
    {
      assumption: "AI provider truthfulness",
      detail: "ForgeProof records the model name and provider as declared by the API caller. It assumes the caller accurately reports which model generated the code.",
      mitigation: "Use dedicated agent endpoints (/api/v1/agents/openai, /claude, /replit) which enforce provider-specific validation. Integrate attestation into your CI/CD pipeline where agent identity is controlled.",
    },
    {
      assumption: "Hash function security (SHA-256)",
      detail: "ForgeProof relies on SHA-256 being collision-resistant. If SHA-256 is broken, an attacker could create a different file with the same hash.",
      mitigation: "SHA-256 is considered secure for the foreseeable future. NIST has no plans to deprecate it. ForgeProof's architecture supports hash algorithm migration if needed.",
    },
    {
      assumption: "Signature algorithm security (Ed25519)",
      detail: "Ed25519 is assumed to be unforgeable. Quantum computers could theoretically break Ed25519 in the future.",
      mitigation: "Ed25519 is currently considered quantum-resistant up to ~128 bits of security. Post-quantum signature migration is on the roadmap.",
    },
  ];

  const attackScenarios = [
    {
      name: "Forged attestation (insider threat)",
      description: "An attacker with server access creates fake attestation receipts claiming code was written by a specific AI model.",
      impact: "High",
      impactColor: "text-red-500",
      mitigations: [
        "Self-host on hardened infrastructure with access controls",
        "Monitor audit logs for attestations from unexpected sources",
        "Implement multi-party signing (on roadmap)",
        "Export and verify receipts independently using the public key",
      ],
    },
    {
      name: "API key theft",
      description: "An attacker obtains a valid API key and creates attestations impersonating an authorized user.",
      impact: "High",
      impactColor: "text-red-500",
      mitigations: [
        "Rotate API keys regularly through the dashboard",
        "Revoke compromised keys immediately",
        "Scope keys to specific repositories",
        "Review audit logs for unexpected attestation activity",
      ],
    },
    {
      name: "Ledger tampering",
      description: "An attacker with database access modifies, deletes, or reorders attestation receipts.",
      impact: "Medium",
      impactColor: "text-amber-500",
      mitigations: [
        "Hash chain verification detects any modification to the ledger",
        "Regularly export receipts to external storage for comparison",
        "Run /api/verify/chain periodically to confirm ledger integrity",
        "Database access controls and encryption at rest",
      ],
    },
    {
      name: "Model identity spoofing",
      description: "A caller claims code was generated by GPT-4 when it was actually written by a human or a different model.",
      impact: "Medium",
      impactColor: "text-amber-500",
      mitigations: [
        "Use agent-specific endpoints that enforce provider identity",
        "Integrate attestation into controlled CI/CD pipelines",
        "Cross-reference attestation timestamps with AI session logs",
        "Multi-model attestation creates additional verification points",
      ],
    },
    {
      name: "Replay attack",
      description: "An attacker re-submits a previously valid attestation request to create duplicate entries.",
      impact: "Low",
      impactColor: "text-green-500",
      mitigations: [
        "Each attestation includes a unique timestamp and generates a unique entry hash",
        "Hash chain ensures each entry links to the exact previous state",
        "Duplicate detection at the API level",
        "Audit log records all API calls with timestamps",
      ],
    },
  ];

  return (
    <div className="min-h-screen bg-background">
      <SEO
        title="Threat Model - ForgeProof"
        description="ForgeProof's security threat model: what it proves, what it doesn't, trust assumptions, and attack scenario analysis."
        path="/threat-model"
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
              <Shield className="w-3 h-3 mr-1" />
              Security
            </Badge>
            <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mb-4" data-testid="heading-threat-model">
              Threat Model
            </h1>
            <p className="text-lg text-muted-foreground leading-relaxed max-w-3xl">
              ForgeProof provides cryptographic evidence of code provenance, not absolute guarantees. Understanding what the system proves and what it does not is essential for making informed trust decisions.
            </p>
          </div>

          <section className="mb-16" id="what-it-proves">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-full bg-green-500/10 dark:bg-green-400/20 flex items-center justify-center">
                <CheckCircle2 className="w-5 h-5 text-green-500 dark:text-green-400" />
              </div>
              <h2 className="font-display text-2xl font-bold" data-testid="heading-what-it-proves">What ForgeProof Proves</h2>
            </div>
            <div className="space-y-4">
              {proves.map((item, i) => (
                <Card key={i} className="p-5" data-testid={`card-proves-${i}`}>
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="w-5 h-5 text-green-500 dark:text-green-400 mt-0.5 shrink-0" />
                    <div>
                      <h4 className="font-semibold mb-1">{item.claim}</h4>
                      <p className="text-sm text-muted-foreground leading-relaxed">{item.mechanism}</p>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </section>

          <section className="mb-16" id="what-it-does-not-prove">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-full bg-red-500/10 dark:bg-red-400/20 flex items-center justify-center">
                <XCircle className="w-5 h-5 text-red-500 dark:text-red-400" />
              </div>
              <h2 className="font-display text-2xl font-bold" data-testid="heading-what-it-does-not-prove">What ForgeProof Does Not Prove</h2>
            </div>
            <div className="space-y-4">
              {doesNotProve.map((item, i) => (
                <Card key={i} className="p-5" data-testid={`card-does-not-prove-${i}`}>
                  <div className="flex items-start gap-3">
                    <XCircle className="w-5 h-5 text-red-500 dark:text-red-400 mt-0.5 shrink-0" />
                    <div>
                      <h4 className="font-semibold mb-1">{item.claim}</h4>
                      <p className="text-sm text-muted-foreground leading-relaxed">{item.explanation}</p>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </section>

          <section className="mb-16" id="trust-assumptions">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-full bg-amber-500/10 dark:bg-amber-400/20 flex items-center justify-center">
                <Lock className="w-5 h-5 text-amber-500 dark:text-amber-400" />
              </div>
              <h2 className="font-display text-2xl font-bold" data-testid="heading-trust-assumptions">Trust Assumptions</h2>
            </div>
            <p className="text-muted-foreground mb-6">
              Every security system operates under a set of assumptions. ForgeProof's security guarantees hold as long as these assumptions are met.
            </p>
            <div className="space-y-4">
              {trustAssumptions.map((item, i) => (
                <Card key={i} className="p-5" data-testid={`card-trust-assumption-${i}`}>
                  <h4 className="font-semibold mb-2 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                    {item.assumption}
                  </h4>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-3">{item.detail}</p>
                  <div className="bg-muted/50 rounded-md p-3">
                    <p className="text-xs font-semibold text-foreground mb-1">Mitigation</p>
                    <p className="text-sm text-muted-foreground leading-relaxed">{item.mitigation}</p>
                  </div>
                </Card>
              ))}
            </div>
          </section>

          <section className="mb-16" id="attack-scenarios">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-full bg-red-500/10 dark:bg-red-400/20 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-red-500 dark:text-red-400" />
              </div>
              <h2 className="font-display text-2xl font-bold" data-testid="heading-attack-scenarios">Attack Scenarios</h2>
            </div>
            <div className="space-y-4">
              {attackScenarios.map((scenario, i) => (
                <Card key={i} className="p-5" data-testid={`card-attack-scenario-${i}`}>
                  <div className="flex items-center gap-3 mb-3">
                    <h4 className="font-semibold">{scenario.name}</h4>
                    <Badge variant="outline" className={scenario.impactColor}>
                      Impact: {scenario.impact}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-4">{scenario.description}</p>
                  <div>
                    <p className="text-xs font-semibold text-foreground mb-2">Mitigations</p>
                    <ul className="space-y-1.5">
                      {scenario.mitigations.map((m, j) => (
                        <li key={j} className="flex items-start gap-2 text-sm text-muted-foreground">
                          <Shield className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                          <span>{m}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </Card>
              ))}
            </div>
          </section>

          <section className="mb-12" id="security-guarantees">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-full bg-primary/10 dark:bg-primary/20 flex items-center justify-center">
                <Fingerprint className="w-5 h-5 text-primary" />
              </div>
              <h2 className="font-display text-2xl font-bold" data-testid="heading-security-guarantees">Security Guarantees Summary</h2>
            </div>
            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-security-guarantees">
                  <thead>
                    <tr className="border-b border-border bg-muted/50">
                      <th className="text-left p-4 font-semibold">Property</th>
                      <th className="text-left p-4 font-semibold">Mechanism</th>
                      <th className="text-left p-4 font-semibold">Strength</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { property: "Integrity", mechanism: "SHA-256 file hashing", strength: "Computationally infeasible to forge" },
                      { property: "Authenticity", mechanism: "Ed25519 digital signatures", strength: "128-bit security level" },
                      { property: "Non-repudiation", mechanism: "Signed receipts with timestamps", strength: "Cryptographic proof of attestation" },
                      { property: "Ordering", mechanism: "Hash-chained ledger", strength: "Detects insertion, deletion, reordering" },
                      { property: "Independence", mechanism: "Provider separation enforcement", strength: "Enforced at API level" },
                      { property: "Auditability", mechanism: "Immutable audit log", strength: "Complete history of all operations" },
                    ].map((row, i) => (
                      <tr key={i} className="border-b border-border last:border-0">
                        <td className="p-4 font-medium">{row.property}</td>
                        <td className="p-4 text-muted-foreground">{row.mechanism}</td>
                        <td className="p-4 text-muted-foreground">{row.strength}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </section>

          <Card className="p-6 sm:p-8 bg-primary/5 dark:bg-primary/10 border-primary/20">
            <div className="text-center">
              <h3 className="font-display text-lg font-semibold mb-3">Questions or Findings?</h3>
              <p className="text-sm text-muted-foreground mb-4 max-w-lg mx-auto">
                If you discover a vulnerability or have questions about ForgeProof's security model, please reach out through our GitHub repository.
              </p>
              <div className="flex flex-wrap justify-center gap-3">
                <Link href="/glossary">
                  <Button variant="outline" data-testid="link-glossary">
                    <FileCheck className="w-4 h-4 mr-2" />
                    Terminology
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
                    <Hash className="w-4 h-4 mr-2" />
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