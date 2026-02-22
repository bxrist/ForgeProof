import { useState, useEffect } from "react";
import { Link } from "wouter";
import { motion, useInView } from "framer-motion";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import {
  Globe,
  Lock,
  FileCheck,
  GitBranch,
  Terminal,
  ArrowRight,
  CheckCircle2,
  Cpu,
  MapPin,
  Fingerprint,
  Layers,
  Code2,
  Building2,
  Users,
  ExternalLink,
  ChevronRight,
  Zap,
  Eye,
  Hash,
  Menu,
  Link2,
  X,
  Shield,
} from "lucide-react";
import { SiGithub } from "react-icons/si";
import { ForgeProofLogo } from "@/components/ForgeProofLogo";
import { SEO } from "@/components/SEO";
import { useTheme } from "@/components/ThemeProvider";
import { Moon, Sun } from "lucide-react";

function FadeIn({ children, delay = 0, className = "" }: { children: React.ReactNode; delay?: number; className?: string }) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 24 }}
      animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 }}
      transition={{ duration: 0.5, delay, ease: "easeOut" }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

function AnimatedCounter({ value, suffix = "" }: { value: number; suffix?: string }) {
  const [count, setCount] = useState(0);
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true });

  useEffect(() => {
    if (!isInView) return;
    let start = 0;
    const end = value;
    const duration = 1500;
    const increment = end / (duration / 16);
    const timer = setInterval(() => {
      start += increment;
      if (start >= end) {
        setCount(end);
        clearInterval(timer);
      } else {
        setCount(Math.floor(start));
      }
    }, 16);
    return () => clearInterval(timer);
  }, [isInView, value]);

  return <span ref={ref}>{count.toLocaleString()}{suffix}</span>;
}

function ReceiptPreview() {
  const lines = [
    { key: "receipt_version", value: '"v1"', color: "text-green-400" },
    { key: "timestamp", value: '"2026-02-21T08:30:00Z"', color: "text-yellow-400" },
    { key: "file_hash", value: '"sha256:a3f2e8..."', color: "text-cyan-400" },
    { key: "model_name", value: '"gpt-4-turbo"', color: "text-green-400" },
    { key: "model_provider", value: '"OpenAI"', color: "text-green-400" },
    { key: "country_of_origin", value: '"US"', color: "text-orange-400" },
    { key: "signature", value: '"ed25519:7Bf3..."', color: "text-purple-400" },
    { key: "prev_entry_hash", value: '"sha256:9c1d..."', color: "text-cyan-400" },
  ];

  return (
    <div className="bg-[#0d1117] rounded-lg border border-[#30363d] overflow-hidden font-mono text-sm">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#30363d] bg-[#161b22]">
        <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
        <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
        <div className="w-3 h-3 rounded-full bg-[#28c840]" />
        <span className="ml-2 text-xs text-[#8b949e]">forgeproof-receipt.json</span>
      </div>
      <div className="p-4 space-y-0.5">
        <div className="text-[#8b949e]">{"{"}</div>
        {lines.map((line, i) => (
          <motion.div
            key={line.key}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.8 + i * 0.12, duration: 0.3 }}
            className="pl-4"
          >
            <span className="text-[#79c0ff]">"{line.key}"</span>
            <span className="text-[#8b949e]">: </span>
            <span className={line.color}>{line.value}</span>
            {i < lines.length - 1 && <span className="text-[#8b949e]">,</span>}
          </motion.div>
        ))}
        <div className="text-[#8b949e]">{"}"}</div>
      </div>
    </div>
  );
}

function Navbar() {
  const { user, isAuthenticated } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between gap-4 h-16">
          <Link href="/" className="flex items-center gap-2">
            <ForgeProofLogo size={44} />
            <span className="font-display font-bold text-xl tracking-tight" data-testid="logo-text">ForgeProof</span>
          </Link>

          <div className="hidden md:flex items-center gap-1">
            <a href="#sovereignty" className="px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground rounded-md">Sovereignty</a>
            <a href="#how-it-works" className="px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground rounded-md">How It Works</a>
            <a href="#use-cases" className="px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground rounded-md">Use Cases</a>
            <a href="#multi-model" className="px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground rounded-md">Multi-Model</a>
            <a href="#features" className="px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground rounded-md">Features</a>
            <a href="#api" className="px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground rounded-md">API</a>
            <Link href="/sdk" className="px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground rounded-md">SDK</Link>
          </div>

          <div className="hidden md:flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              data-testid="button-theme-toggle"
              className="w-8 h-8"
            >
              {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </Button>
            <a
              href="https://github.com"
              target="_blank"
              rel="noopener noreferrer"
              data-testid="link-github"
            >
              <Button variant="outline" size="sm">
                <SiGithub className="w-4 h-4 mr-1.5" />
                View on GitHub
              </Button>
            </a>
            {isAuthenticated ? (
              <Link href="/dashboard">
                <Button size="sm" data-testid="button-dashboard">
                  Dashboard
                  <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
                </Button>
              </Link>
            ) : (
              <Link href="/demo">
                <Button size="sm" data-testid="button-try-demo">
                  Try the Demo
                  <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
                </Button>
              </Link>
            )}
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMobileOpen(!mobileOpen)}
            data-testid="button-mobile-menu"
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </Button>
        </div>

        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            className="md:hidden pb-4 space-y-2"
          >
            <a href="#sovereignty" className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => setMobileOpen(false)}>Sovereignty</a>
            <a href="#how-it-works" className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => setMobileOpen(false)}>How It Works</a>
            <a href="#use-cases" className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => setMobileOpen(false)}>Use Cases</a>
            <a href="#multi-model" className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => setMobileOpen(false)}>Multi-Model</a>
            <a href="#features" className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => setMobileOpen(false)}>Features</a>
            <a href="#api" className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => setMobileOpen(false)}>API</a>
            <Link href="/sdk" className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => setMobileOpen(false)}>SDK</Link>
            <Link href="/analytics" className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => setMobileOpen(false)}>Analytics</Link>
            <Link href="/verify" className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => setMobileOpen(false)}>Verify</Link>
            <Link href="/lookup" className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => setMobileOpen(false)}>Lookup</Link>
            <div className="flex flex-col gap-2 pt-2">
              <a href="https://github.com" target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm" className="w-full">
                  <SiGithub className="w-4 h-4 mr-1.5" />
                  View on GitHub
                </Button>
              </a>
              <Button variant="outline" size="sm" className="w-full" onClick={toggleTheme}>
                {theme === "dark" ? <Sun className="w-4 h-4 mr-1.5" /> : <Moon className="w-4 h-4 mr-1.5" />}
                {theme === "dark" ? "Light Mode" : "Dark Mode"}
              </Button>
              {isAuthenticated ? (
                <Link href="/dashboard">
                  <Button size="sm" className="w-full">Dashboard</Button>
                </Link>
              ) : (
                <Link href="/demo">
                  <Button size="sm" className="w-full">Try the Demo</Button>
                </Link>
              )}
            </div>
          </motion.div>
        )}
      </div>
    </nav>
  );
}

function HeroSection() {
  return (
    <section className="relative pt-32 pb-20 sm:pt-40 sm:pb-28 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent dark:from-primary/10" />
      <div className="absolute top-20 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-primary/5 rounded-full blur-3xl dark:bg-primary/10" />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          <div className="space-y-8">
            <FadeIn>
              <Badge variant="secondary" className="mb-2">
                <Zap className="w-3 h-3 mr-1" />
                Now with Ed25519 Cryptographic Attestation
              </Badge>
            </FadeIn>

            <FadeIn delay={0.1}>
              <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.1]">
                Code Provenance{" "}
                <span className="text-primary">for the AI Era</span>
              </h1>
            </FadeIn>

            <FadeIn delay={0.2}>
              <p className="text-lg sm:text-xl text-muted-foreground leading-relaxed max-w-xl">
                Cryptographically attest which AI models generate your code, where they operate, and create a tamper-evident chain of provenance for every file in your repository.
              </p>
            </FadeIn>

            <FadeIn delay={0.3}>
              <div className="flex flex-wrap items-center gap-3">
                <Link href="/demo">
                  <Button size="lg" data-testid="button-hero-try-demo">
                    Try the Demo
                    <ArrowRight className="w-4 h-4 ml-2" />
                  </Button>
                </Link>
                <a href="https://github.com" target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="lg" data-testid="button-hero-github">
                    <SiGithub className="w-4 h-4 mr-2" />
                    View on GitHub
                  </Button>
                </a>
              </div>
            </FadeIn>

            <FadeIn delay={0.4}>
              <div className="flex items-center gap-6 text-sm text-muted-foreground pt-2">
                <div className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-primary" />
                  <span>Ed25519 Signed</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-primary" />
                  <span>Hash-Chained</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-primary" />
                  <span>Open Source</span>
                </div>
              </div>
            </FadeIn>
          </div>

          <FadeIn delay={0.4} className="lg:pl-4">
            <ReceiptPreview />
          </FadeIn>
        </div>
      </div>
    </section>
  );
}

function StatsSection() {
  return (
    <section className="py-16 border-y border-border bg-card/50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          {[
            { value: 12500, suffix: "+", label: "Attestations Created" },
            { value: 340, suffix: "+", label: "Repositories Tracked" },
            { value: 8, suffix: "", label: "AI Models Supported" },
            { value: 99.9, suffix: "%", label: "Verification Accuracy" },
          ].map((stat, i) => (
            <FadeIn key={stat.label} delay={i * 0.1}>
              <div className="text-center">
                <div className="font-display text-3xl sm:text-4xl font-bold text-foreground">
                  <AnimatedCounter value={stat.value} suffix={stat.suffix} />
                </div>
                <div className="mt-1.5 text-sm text-muted-foreground">{stat.label}</div>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

function SovereigntySection() {
  return (
    <section id="sovereignty" className="py-20 sm:py-28">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <FadeIn>
          <div className="text-center max-w-3xl mx-auto mb-16">
            <Badge variant="outline" className="mb-4">
              <Globe className="w-3 h-3 mr-1" />
              Sovereignty & Compliance
            </Badge>
            <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Model & Data Sovereignty
            </h2>
            <p className="text-lg text-muted-foreground">
              As AI models generate an increasing share of production code, organizations need to know exactly which models touched their codebase and where those models operate.
            </p>
          </div>
        </FadeIn>

        <div className="grid md:grid-cols-2 gap-8 lg:gap-12">
          <FadeIn delay={0.1}>
            <Card className="p-6 sm:p-8 h-full">
              <div className="w-12 h-12 rounded-lg bg-primary/10 dark:bg-primary/20 flex items-center justify-center mb-5">
                <Cpu className="w-6 h-6 text-primary" />
              </div>
              <h3 className="font-display text-xl font-semibold mb-3">Model Sovereignty</h3>
              <p className="text-muted-foreground mb-5 leading-relaxed">
                Track exactly which AI model produced each piece of code in your repository. From GPT-4 to Claude to Replit Agent, ForgeProof creates a permanent, verifiable record of AI model provenance.
              </p>
              <ul className="space-y-3">
                {[
                  "Model identification and version tracking",
                  "Provider attribution (OpenAI, Anthropic, Replit)",
                  "Generation timestamp with millisecond precision",
                  "Model capability and permission auditing",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </FadeIn>

          <FadeIn delay={0.2}>
            <Card className="p-6 sm:p-8 h-full">
              <div className="w-12 h-12 rounded-lg bg-primary/10 dark:bg-primary/20 flex items-center justify-center mb-5">
                <MapPin className="w-6 h-6 text-primary" />
              </div>
              <h3 className="font-display text-xl font-semibold mb-3">Data Sovereignty</h3>
              <p className="text-muted-foreground mb-5 leading-relaxed">
                Verify where AI models process and store your data. Critical for GDPR, CCPA, and sector-specific compliance requirements where data residency matters.
              </p>
              <ul className="space-y-3">
                {[
                  "Geographic origin tracking (country/jurisdiction)",
                  "GDPR and CCPA compliance verification",
                  "Cross-border data flow documentation",
                  "Regulatory audit trail generation",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </FadeIn>
        </div>
      </div>
    </section>
  );
}

function TrustSection() {
  const steps = [
    {
      icon: Code2,
      title: "Code Generation",
      desc: "AI agent generates or modifies code in your repository",
    },
    {
      icon: Hash,
      title: "SHA-256 Hashing",
      desc: "File content is hashed to create a unique fingerprint",
    },
    {
      icon: Fingerprint,
      title: "Ed25519 Signing",
      desc: "Receipt is cryptographically signed with Ed25519",
    },
    {
      icon: Layers,
      title: "Chain Linking",
      desc: "Each entry links to the previous via hash chain",
    },
    {
      icon: FileCheck,
      title: "Receipt Issued",
      desc: "Tamper-evident receipt with full provenance metadata",
    },
  ];

  return (
    <section className="py-20 sm:py-28 bg-card/50 border-y border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <FadeIn>
          <div className="text-center max-w-3xl mx-auto mb-16">
            <Badge variant="outline" className="mb-4">
              <Lock className="w-3 h-3 mr-1" />
              Trust & Verification
            </Badge>
            <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Cryptographic Trust Architecture
            </h2>
            <p className="text-lg text-muted-foreground">
              Every attestation is secured with Ed25519 digital signatures and linked in a tamper-evident hash chain, making it impossible to alter provenance records undetected.
            </p>
          </div>
        </FadeIn>

        <div className="relative">
          <div className="hidden md:block absolute top-1/2 left-0 right-0 h-px bg-border -translate-y-1/2" />
          <div className="grid grid-cols-1 md:grid-cols-5 gap-6 md:gap-4">
            {steps.map((step, i) => (
              <FadeIn key={step.title} delay={i * 0.1}>
                <div className="relative flex flex-col items-center text-center">
                  <div className="w-14 h-14 rounded-full bg-background border-2 border-primary flex items-center justify-center mb-4 z-10">
                    <step.icon className="w-6 h-6 text-primary" />
                  </div>
                  <h4 className="font-semibold text-sm mb-1.5">{step.title}</h4>
                  <p className="text-xs text-muted-foreground leading-relaxed max-w-[180px]">{step.desc}</p>
                  {i < steps.length - 1 && (
                    <ChevronRight className="hidden md:block absolute right-0 top-5 text-muted-foreground w-4 h-4 translate-x-1/2" />
                  )}
                </div>
              </FadeIn>
            ))}
          </div>
        </div>

        <FadeIn delay={0.5}>
          <div className="mt-16 grid sm:grid-cols-3 gap-6">
            {[
              {
                icon: Link2,
                title: "Tamper-Evident",
                desc: "Hash-chained entries ensure any modification to the attestation ledger is immediately detectable.",
              },
              {
                icon: Eye,
                title: "Publicly Verifiable",
                desc: "Anyone can independently verify signatures using the public key without trusting ForgeProof.",
              },
              {
                icon: GitBranch,
                title: "Git-Native",
                desc: "Attestations integrate directly with your GitHub workflow, no file uploads needed.",
              },
            ].map((item) => (
              <Card key={item.title} className="p-5">
                <item.icon className="w-5 h-5 text-primary mb-3" />
                <h4 className="font-semibold text-sm mb-1.5">{item.title}</h4>
                <p className="text-xs text-muted-foreground leading-relaxed">{item.desc}</p>
              </Card>
            ))}
          </div>
        </FadeIn>
      </div>
    </section>
  );
}

function HowItWorksSection() {
  return (
    <section id="how-it-works" className="py-20 sm:py-28">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <FadeIn>
          <div className="text-center max-w-3xl mx-auto mb-16">
            <Badge variant="outline" className="mb-4">
              <Terminal className="w-3 h-3 mr-1" />
              Getting Started
            </Badge>
            <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              How It Works
            </h2>
            <p className="text-lg text-muted-foreground">
              Three steps to verifiable code provenance. ForgeProof integrates seamlessly with your existing development workflow.
            </p>
          </div>
        </FadeIn>

        <div className="grid md:grid-cols-3 gap-8">
          {[
            {
              step: "01",
              title: "Connect Your Repository",
              desc: "Link your GitHub repository to ForgeProof. We read your code directly from GitHub - no manual file uploads needed.",
              icon: GitBranch,
            },
            {
              step: "02",
              title: "AI Agents Attest Code",
              desc: "When an AI model generates code, it calls the ForgeProof API to create a signed attestation receipt with provenance metadata.",
              icon: Cpu,
            },
            {
              step: "03",
              title: "Verify & Audit",
              desc: "View your attestation ledger, download individual receipts, and verify signatures to build a complete audit trail.",
              icon: FileCheck,
            },
          ].map((item, i) => (
            <FadeIn key={item.step} delay={i * 0.15}>
              <div className="relative">
                <div className="text-6xl font-display font-bold text-primary/10 dark:text-primary/15 absolute -top-4 -left-2">
                  {item.step}
                </div>
                <div className="relative pt-8 pl-2">
                  <div className="w-10 h-10 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center mb-4">
                    <item.icon className="w-5 h-5 text-primary" />
                  </div>
                  <h3 className="font-display text-lg font-semibold mb-2">{item.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{item.desc}</p>
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

function UseCasesSection() {
  return (
    <section id="use-cases" className="py-20 sm:py-28 bg-card/50 border-y border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <FadeIn>
          <div className="text-center max-w-3xl mx-auto mb-16">
            <Badge variant="outline" className="mb-4">
              <Users className="w-3 h-3 mr-1" />
              Use Cases
            </Badge>
            <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Built for Every Team
            </h2>
            <p className="text-lg text-muted-foreground">
              Whether you're a solo developer or an enterprise, ForgeProof provides the provenance guarantees your workflow needs.
            </p>
          </div>
        </FadeIn>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {[
            {
              icon: Code2,
              title: "Developer Tools",
              desc: "Integrate attestation into your CI/CD pipeline. Every AI-assisted commit gets a verifiable receipt automatically.",
            },
            {
              icon: Building2,
              title: "Enterprise Compliance",
              desc: "Meet regulatory requirements for AI-generated code with auditable provenance trails and geographic compliance verification.",
            },
            {
              icon: Users,
              title: "Open Source Projects",
              desc: "Maintain transparency about which AI models contributed to your project. Build trust with contributors and users.",
            },
            {
              icon: Fingerprint,
              title: "Security Auditing",
              desc: "Identify exactly which AI model produced each piece of code during security reviews and vulnerability assessments.",
            },
            {
              icon: Globe,
              title: "Cross-Border Teams",
              desc: "Track data sovereignty compliance across distributed teams using different AI providers in different jurisdictions.",
            },
            {
              icon: Terminal,
              title: "AI Agent Integration",
              desc: "OpenAI, Claude, and Replit Agent can programmatically attest the code they generate via our REST API.",
            },
          ].map((item, i) => (
            <FadeIn key={item.title} delay={i * 0.08}>
              <Card className="p-5 h-full">
                <item.icon className="w-5 h-5 text-primary mb-3" />
                <h4 className="font-semibold mb-1.5">{item.title}</h4>
                <p className="text-sm text-muted-foreground leading-relaxed">{item.desc}</p>
              </Card>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

function MultiModelSection() {
  const flowSteps = [
    {
      label: "Origin",
      icon: Terminal,
      provider: "OpenAI GPT-4",
      text: "Writes the code",
      accentClass: "border-blue-500/40 dark:border-blue-400/40",
      iconBgClass: "bg-blue-500/10 dark:bg-blue-400/20",
      iconColorClass: "text-blue-500 dark:text-blue-400",
      badgeVariant: "secondary" as const,
    },
    {
      label: "Security Audit",
      icon: Shield,
      provider: "Anthropic Claude",
      text: "Reviews for vulnerabilities",
      accentClass: "border-green-500/40 dark:border-green-400/40",
      iconBgClass: "bg-green-500/10 dark:bg-green-400/20",
      iconColorClass: "text-green-500 dark:text-green-400",
      badgeVariant: "secondary" as const,
    },
    {
      label: "Remediation",
      icon: CheckCircle2,
      provider: "Anthropic Claude",
      text: "Fixes issues & re-attests",
      accentClass: "border-purple-500/40 dark:border-purple-400/40",
      iconBgClass: "bg-purple-500/10 dark:bg-purple-400/20",
      iconColorClass: "text-purple-500 dark:text-purple-400",
      badgeVariant: "secondary" as const,
    },
  ];

  const chainReceipts = [
    { id: "#1", label: "Origin", model: "GPT-4", hash: "sha256:abc" },
    { id: "#2", label: "Audit", model: "Claude", hash: "sha256:abc" },
    { id: "#3", label: "Remediation", model: "Claude", hash: "sha256:def" },
  ];

  return (
    <section id="multi-model" className="py-20 sm:py-28 bg-card/50 border-y border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <FadeIn>
          <div className="text-center max-w-3xl mx-auto mb-16">
            <Badge variant="outline" className="mb-4">
              <Shield className="w-3 h-3 mr-1" />
              Multi-Model Attestation
            </Badge>
            <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Separation of Concerns for AI Code
            </h2>
            <p className="text-lg text-muted-foreground">
              The model that writes code should never be the model that certifies it's secure.
            </p>
          </div>
        </FadeIn>

        <div className="relative grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8 mb-12">
          {flowSteps.map((step, i) => (
            <FadeIn key={step.label} delay={i * 0.15}>
              <div className="relative">
                <Card className={`p-6 h-full border-2 ${step.accentClass}`} data-testid={`card-multimodel-${step.label.toLowerCase().replace(/\s+/g, "-")}`}>
                  <div className={`w-12 h-12 rounded-lg ${step.iconBgClass} flex items-center justify-center mb-4`}>
                    <step.icon className={`w-6 h-6 ${step.iconColorClass}`} />
                  </div>
                  <Badge variant={step.badgeVariant} className="mb-3">
                    {step.label}
                  </Badge>
                  <p className="font-semibold text-sm mb-1">{step.provider}</p>
                  <p className="text-sm text-muted-foreground">{step.text}</p>
                </Card>
                {i < flowSteps.length - 1 && (
                  <div className="hidden md:flex absolute top-1/2 -right-6 -translate-y-1/2 z-10 items-center justify-center w-8">
                    <ArrowRight className="w-5 h-5 text-muted-foreground" />
                  </div>
                )}
              </div>
            </FadeIn>
          ))}
        </div>

        <FadeIn delay={0.5}>
          <Card className="p-6 sm:p-8 bg-primary/5 dark:bg-primary/10 border-primary/20 mb-12">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-full bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                <Shield className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h4 className="font-semibold mb-2">Key Principle</h4>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  ForgeProof enforces that security audit attestations must come from a different AI provider than the origin. OpenAI cannot audit OpenAI's code. This creates genuine independent verification.
                </p>
              </div>
            </div>
          </Card>
        </FadeIn>

        <FadeIn delay={0.6}>
          <div className="text-center mb-6">
            <h3 className="font-display text-lg font-semibold mb-2">Attestation Chain</h3>
            <p className="text-sm text-muted-foreground">How the cryptographic chain of trust is built</p>
          </div>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-0">
            {chainReceipts.map((receipt, i) => (
              <div key={receipt.id} className="flex items-center gap-3">
                <Card className="p-4 text-center min-w-[140px]" data-testid={`card-chain-receipt-${i}`}>
                  <p className="font-mono text-xs text-muted-foreground mb-1">Receipt {receipt.id}</p>
                  <p className="font-semibold text-sm mb-0.5">{receipt.label}</p>
                  <p className="text-xs text-muted-foreground">{receipt.model}</p>
                  <p className="font-mono text-xs text-primary mt-1">{receipt.hash}</p>
                </Card>
                {i < chainReceipts.length - 1 && (
                  <ArrowRight className="hidden sm:block w-4 h-4 text-muted-foreground shrink-0" />
                )}
              </div>
            ))}
          </div>
        </FadeIn>
      </div>
    </section>
  );
}

function PlatformFeaturesSection() {
  const features = [
    {
      icon: Shield,
      title: "Multi-Model Attestation",
      desc: "Enforce separation of concerns: the AI that writes code cannot audit its own security. Different models attest origin and security independently, creating a cryptographic chain of trust.",
    },
    {
      icon: Link2,
      title: "Hash Chain Verification",
      desc: "Every attestation is cryptographically linked to the previous entry using SHA-256, creating an immutable, tamper-evident ledger. Verify chain integrity at /verify.",
    },
    {
      icon: GitBranch,
      title: "GitHub Integration",
      desc: "Connect your GitHub account via OAuth, sync repositories, and automatically attest code on every push event through webhooks.",
    },
    {
      icon: Terminal,
      title: "MCP Tool Server",
      desc: "Expose ForgeProof as a Model Context Protocol server. AI agents can discover and call attest, lookup, verify, and batch attest tools.",
    },
    {
      icon: Cpu,
      title: "GPT Actions & OpenAPI",
      desc: "Ready-to-use OpenAPI spec at /api/openapi.json. Configure ChatGPT custom GPTs to create attestations directly from conversations.",
    },
    {
      icon: Users,
      title: "Team Collaboration",
      desc: "Create organizations, invite team members, and share repositories and attestation data across your team.",
    },
    {
      icon: Eye,
      title: "Analytics Dashboard",
      desc: "Visual analytics showing attestation data by AI provider, model, country of origin, and compliance status.",
    },
    {
      icon: Code2,
      title: "SDK & Code Examples",
      desc: "Python, TypeScript, and curl examples for every API endpoint. Copy-paste integration in minutes.",
    },
    {
      icon: Fingerprint,
      title: "Badge Embeds",
      desc: "Generate SVG badges for individual attestations or entire repositories. Embed proof of provenance in your README.",
    },
    {
      icon: FileCheck,
      title: "Certificate Export",
      desc: "Export printable HTML certificates for any attestation receipt. Includes signature verification status and full hash chain data.",
    },
    {
      icon: MapPin,
      title: "Geographic Compliance",
      desc: "Declare and verify the country of origin for every AI-generated code file. Track compliance across jurisdictions.",
    },
    {
      icon: Hash,
      title: "Public Lookup",
      desc: "Anyone can independently verify any attestation receipt by ID or hash at /lookup. No login required.",
    },
    {
      icon: Layers,
      title: "Audit Logging",
      desc: "Every action is logged with timestamps, user IDs, and resource details. Full activity trail for compliance and security.",
    },
  ];

  return (
    <section id="features" className="py-20 sm:py-28">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <FadeIn>
          <div className="text-center max-w-3xl mx-auto mb-16">
            <Badge variant="outline" className="mb-4">
              <Layers className="w-3 h-3 mr-1" />
              Platform Features
            </Badge>
            <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Everything You Need for Code Provenance
            </h2>
            <p className="text-lg text-muted-foreground">
              From cryptographic attestation to team collaboration, ForgeProof provides a complete platform for tracking AI-generated code.
            </p>
          </div>
        </FadeIn>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature, i) => (
            <FadeIn key={feature.title} delay={i * 0.06}>
              <Card className="p-5 h-full" data-testid={`card-feature-${i}`}>
                <div className="w-10 h-10 rounded-full bg-primary/10 dark:bg-primary/20 flex items-center justify-center mb-4">
                  <feature.icon className="w-5 h-5 text-primary" />
                </div>
                <h4 className="font-semibold mb-1.5">{feature.title}</h4>
                <p className="text-sm text-muted-foreground leading-relaxed">{feature.desc}</p>
              </Card>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

function ApiSection() {
  const [activeAgent, setActiveAgent] = useState<"openai" | "claude" | "replit">("openai");

  const agentSnippets = {
    openai: `// OpenAI Agent attestation
const response = await fetch(
  "/api/v1/agents/openai",
  {
    method: "POST",
    headers: {
      "Authorization": "Bearer fp_sk_...",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      files: [{
        file_path: "src/utils/auth.ts",
        file_hash: "sha256:a3f2e8c1..."
      }],
      model_name: "gpt-4-turbo",
      model_provider: "OpenAI",
      country_of_origin: "US",
      session_id: "chatcmpl-abc123"
    })
  }
);
const { receipts } = await response.json();`,
    claude: `// Claude Agent attestation
const response = await fetch(
  "/api/v1/agents/claude",
  {
    method: "POST",
    headers: {
      "Authorization": "Bearer fp_sk_...",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      files: [{
        file_path: "src/server/api.ts",
        file_hash: "sha256:7b9e4d2f..."
      }],
      model_name: "claude-sonnet-4-20250514",
      model_provider: "Anthropic",
      country_of_origin: "US",
      session_id: "msg_01XFDUDYJg"
    })
  }
);
const { receipts } = await response.json();`,
    replit: `// Replit Agent attestation
const response = await fetch(
  "/api/v1/agents/replit",
  {
    method: "POST",
    headers: {
      "Authorization": "Bearer fp_sk_...",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      files: [{
        file_path: "src/index.tsx",
        file_hash: "sha256:c4a8f1e3..."
      }],
      model_name: "replit-agent-v1",
      model_provider: "Replit",
      country_of_origin: "US",
      session_id: "repl_session_xyz"
    })
  }
);
const { receipts } = await response.json();`,
  };

  const agentLabels = { openai: "OpenAI", claude: "Claude", replit: "Replit" };

  return (
    <section id="api" className="py-20 sm:py-28">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <FadeIn>
            <div className="space-y-6">
              <Badge variant="outline">
                <Terminal className="w-3 h-3 mr-1" />
                REST API
              </Badge>
              <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">
                Built for AI Agents
              </h2>
              <p className="text-lg text-muted-foreground leading-relaxed">
                Dedicated endpoints for each AI agent platform. OpenAI, Claude, and Replit Agent each get a tailored API that handles batch attestation with a single call.
              </p>
              <ul className="space-y-3">
                {[
                  "Dedicated endpoints: /api/v1/agents/openai, /claude, /replit",
                  "Batch attest multiple files in a single request",
                  "API key authentication with Bearer tokens",
                  "Geographic compliance verification on every request",
                  "Generic endpoint at /api/v1/attest for custom integrations",
                  "Self-attesting: ForgeProof attests its own codebase",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-3 pt-2">
                <Link href="/demo">
                  <Button data-testid="button-api-get-key">
                    View Demo
                    <ArrowRight className="w-4 h-4 ml-2" />
                  </Button>
                </Link>
                <Link href="/verify">
                  <Button variant="outline" data-testid="button-api-verify">
                    <Link2 className="w-4 h-4 mr-2" />
                    Verify Chain
                  </Button>
                </Link>
                <Link href="/sdk">
                  <Button variant="outline" data-testid="button-api-sdk">
                    <Code2 className="w-4 h-4 mr-2" />
                    SDK Docs
                  </Button>
                </Link>
              </div>
            </div>
          </FadeIn>

          <FadeIn delay={0.2}>
            <div className="bg-[#0d1117] rounded-lg border border-[#30363d] overflow-hidden font-mono text-xs sm:text-sm">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#30363d] bg-[#161b22]">
                <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
                <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
                <div className="w-3 h-3 rounded-full bg-[#28c840]" />
                <div className="flex items-center gap-1 ml-3">
                  {(["openai", "claude", "replit"] as const).map((agent) => (
                    <button
                      key={agent}
                      onClick={() => setActiveAgent(agent)}
                      className={`px-2.5 py-1 text-xs rounded transition-colors ${activeAgent === agent ? "bg-[#30363d] text-[#e6edf3]" : "text-[#8b949e] hover:text-[#e6edf3]"}`}
                      data-testid={`tab-agent-${agent}`}
                    >
                      {agentLabels[agent]}
                    </button>
                  ))}
                </div>
              </div>
              <pre className="p-4 overflow-x-auto">
                <code className="text-[#e6edf3]">{agentSnippets[activeAgent]}</code>
              </pre>
            </div>
          </FadeIn>
        </div>
      </div>
    </section>
  );
}

function CTASection() {
  return (
    <section className="py-20 sm:py-28 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-t from-primary/5 via-transparent to-transparent dark:from-primary/10" />
      <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <FadeIn>
          <div className="flex items-center justify-center mx-auto mb-8">
            <ForgeProofLogo size={140} />
          </div>
          <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            Start Building Trust in AI-Generated Code
          </h2>
          <p className="text-lg text-muted-foreground mb-8 max-w-2xl mx-auto">
            Join developers and organizations who are creating a verifiable record of their AI-assisted development workflow.
          </p>
          <div className="flex flex-wrap justify-center items-center gap-4">
            <Link href="/demo">
              <Button size="lg" data-testid="button-cta-try-demo">
                Try the Demo
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </Link>
            <a href="https://github.com" target="_blank" rel="noopener noreferrer">
              <Button variant="outline" size="lg" data-testid="button-cta-github">
                <SiGithub className="w-4 h-4 mr-2" />
                View on GitHub
              </Button>
            </a>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border bg-card/50 py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <ForgeProofLogo size={36} />
              <span className="font-display font-bold tracking-tight">ForgeProof</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Code provenance for the AI era.
            </p>
            <div className="text-sm text-muted-foreground">
              &copy; 2026 ForgeProof. Open Source.
            </div>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-3">Platform</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><a href="#sovereignty" className="hover:text-foreground transition-colors">Sovereignty</a></li>
              <li><a href="#how-it-works" className="hover:text-foreground transition-colors">How It Works</a></li>
              <li><a href="#use-cases" className="hover:text-foreground transition-colors">Use Cases</a></li>
              <li><a href="#features" className="hover:text-foreground transition-colors">Features</a></li>
              <li><a href="#api" className="hover:text-foreground transition-colors">API</a></li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-3">Resources</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/demo" className="hover:text-foreground transition-colors">Demo</Link></li>
              <li><Link href="/verify" className="hover:text-foreground transition-colors">Verify</Link></li>
              <li><Link href="/lookup" className="hover:text-foreground transition-colors">Lookup</Link></li>
              <li><Link href="/sdk" className="hover:text-foreground transition-colors">SDK</Link></li>
              <li><Link href="/analytics" className="hover:text-foreground transition-colors">Analytics</Link></li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-3">Connect</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <a href="https://github.com" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors flex items-center gap-1.5">
                  <SiGithub className="w-3.5 h-3.5" />
                  GitHub
                </a>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </footer>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      <SEO title="ForgeProof - Code Provenance for the AI Era" description="Track AI-generated code provenance with cryptographic attestation. Ed25519 signatures, SHA-256 hash chains, geographic compliance verification." path="/" />
      <Navbar />
      <HeroSection />
      <StatsSection />
      <SovereigntySection />
      <TrustSection />
      <HowItWorksSection />
      <UseCasesSection />
      <MultiModelSection />
      <PlatformFeaturesSection />
      <ApiSection />
      <CTASection />
      <Footer />
    </div>
  );
}
