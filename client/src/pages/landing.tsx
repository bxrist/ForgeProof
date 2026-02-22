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
  Scale,
  Boxes,
  BookOpen,
  Rocket,
  Heart,
  GitPullRequest,
  AlertTriangle,
  Milestone,
  Server,
  Download,
} from "lucide-react";
import { SiGithub } from "react-icons/si";
import { ForgeProofLogo } from "@/components/ForgeProofLogo";
import { FlyingCloudLogo } from "@/components/FlyingCloudLogo";
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
          <Link href="/" className="flex items-center gap-3" data-testid="link-home">
            <FlyingCloudLogo size={84} />
            <div className="flex flex-col leading-tight">
              <span className="font-display font-bold text-lg tracking-tight" data-testid="logo-text">ForgeProof</span>
              <span className="text-[9px] text-muted-foreground tracking-wide uppercase hidden sm:block">by Flying Cloud Technology</span>
            </div>
          </Link>

          <div className="hidden md:flex items-center gap-1">
            <a href="#architecture" className="px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground rounded-md" data-testid="nav-architecture">Architecture</a>
            <a href="#use-cases" className="px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground rounded-md" data-testid="nav-use-cases">Use Cases</a>
            <a href="#why-forgeproof" className="px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground rounded-md" data-testid="nav-why-forgeproof">Why ForgeProof</a>
            <a href="#regulations" className="px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground rounded-md" data-testid="nav-compliance">Compliance</a>
            <Link href="/threat-model" className="px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground rounded-md" data-testid="nav-threat-model">Threat Model</Link>
            <Link href="/sdk" className="px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground rounded-md" data-testid="nav-sdk">SDK</Link>
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
              href="https://github.com/bxrist/ForgeProof"
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
            <a href="#architecture" className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => setMobileOpen(false)} data-testid="mobile-nav-architecture">Architecture</a>
            <a href="#use-cases" className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => setMobileOpen(false)} data-testid="mobile-nav-use-cases">Use Cases</a>
            <a href="#why-forgeproof" className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => setMobileOpen(false)} data-testid="mobile-nav-why-forgeproof">Why ForgeProof</a>
            <a href="#regulations" className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => setMobileOpen(false)} data-testid="mobile-nav-compliance">Compliance</a>
            <Link href="/threat-model" className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => setMobileOpen(false)} data-testid="mobile-nav-threat-model">Threat Model</Link>
            <Link href="/glossary" className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => setMobileOpen(false)} data-testid="mobile-nav-glossary">Glossary</Link>
            <Link href="/sdk" className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => setMobileOpen(false)} data-testid="mobile-nav-sdk">SDK</Link>
            <Link href="/demo" className="block px-3 py-2 text-sm text-muted-foreground hover:text-foreground" onClick={() => setMobileOpen(false)} data-testid="mobile-nav-demo">Demo</Link>
            <div className="flex flex-col gap-2 pt-2">
              <a href="https://github.com/bxrist/ForgeProof" target="_blank" rel="noopener noreferrer">
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
              <div className="flex items-center gap-3 mb-3">
                <a href="https://www.flyingcloudtech.com" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 hover:opacity-80 transition-opacity" data-testid="link-hero-fct">
                  <FlyingCloudLogo size={80} />
                  <span className="text-xs text-muted-foreground font-medium">A Flying Cloud Technology Project</span>
                </a>
              </div>
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
                <a href="https://github.com/bxrist/ForgeProof" target="_blank" rel="noopener noreferrer">
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
              The Problem
            </Badge>
            <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Your Software Supply Chain Has a Blind Spot
            </h2>
            <p className="text-lg text-muted-foreground">
              AI models now generate production code at scale. But your organization has no record of which model wrote which file, where that model operates, or whether anyone independently verified the output. This is an uncontrolled supply chain risk.
            </p>
          </div>
        </FadeIn>

        <div className="grid md:grid-cols-3 gap-6 lg:gap-8 mb-12">
          {[
            {
              icon: AlertTriangle,
              title: "No Model Accountability",
              desc: "GPT-4, Claude, Gemini, Copilot — code ships from multiple AI models with no record of which model produced what. When a vulnerability appears, you can't trace it to its source.",
              color: "text-red-500 dark:text-red-400",
              bgColor: "bg-red-500/10 dark:bg-red-400/20",
            },
            {
              icon: Globe,
              title: "No Jurisdiction Tracking",
              desc: "Your code may be processed by models operating in jurisdictions that conflict with your compliance requirements. Without provenance records, you can't demonstrate data sovereignty.",
              color: "text-amber-500 dark:text-amber-400",
              bgColor: "bg-amber-500/10 dark:bg-amber-400/20",
            },
            {
              icon: Shield,
              title: "No Independent Verification",
              desc: "The model that writes your code is often the same one that reviews it. Without enforced separation of concerns, there's no genuine independent audit of AI-generated output.",
              color: "text-amber-500 dark:text-amber-400",
              bgColor: "bg-amber-500/10 dark:bg-amber-400/20",
            },
          ].map((item, i) => (
            <FadeIn key={item.title} delay={i * 0.1}>
              <Card className="p-6 h-full" data-testid={`card-problem-${i}`}>
                <div className={`w-12 h-12 rounded-lg ${item.bgColor} flex items-center justify-center mb-5`}>
                  <item.icon className={`w-6 h-6 ${item.color}`} />
                </div>
                <h3 className="font-display text-lg font-semibold mb-3">{item.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{item.desc}</p>
              </Card>
            </FadeIn>
          ))}
        </div>

        <FadeIn delay={0.4}>
          <Card className="p-6 sm:p-8 bg-primary/5 dark:bg-primary/10 border-primary/20">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-full bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                <ForgeProofLogo size={28} />
              </div>
              <div>
                <h4 className="font-semibold text-lg mb-2">ForgeProof is the infrastructure layer that solves this.</h4>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  It creates a cryptographic record of every AI-generated file: which model, which provider, which jurisdiction, when, and who independently verified it. Tamper-evident, hash-chained, and built for regulatory compliance from day one.
                </p>
              </div>
            </div>
          </Card>
        </FadeIn>
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

function ArchitectureDiagramSection() {
  const steps = [
    {
      id: "model",
      label: "AI Model",
      desc: "GPT-4, Claude, Gemini, or any AI writes code",
      icon: Cpu,
      color: "border-blue-500/50 dark:border-blue-400/50",
      iconBg: "bg-blue-500/10 dark:bg-blue-400/20",
      iconColor: "text-blue-500 dark:text-blue-400",
    },
    {
      id: "agent",
      label: "Agent / CI",
      desc: "Developer tool or CI pipeline calls ForgeProof API",
      icon: Terminal,
      color: "border-violet-500/50 dark:border-violet-400/50",
      iconBg: "bg-violet-500/10 dark:bg-violet-400/20",
      iconColor: "text-violet-500 dark:text-violet-400",
    },
    {
      id: "artifact",
      label: "Artifact",
      desc: "Source file identified by path and content",
      icon: Code2,
      color: "border-cyan-500/50 dark:border-cyan-400/50",
      iconBg: "bg-cyan-500/10 dark:bg-cyan-400/20",
      iconColor: "text-cyan-500 dark:text-cyan-400",
    },
    {
      id: "hash",
      label: "SHA-256 Hash",
      desc: "File content hashed to create unique fingerprint",
      icon: Hash,
      color: "border-amber-500/50 dark:border-amber-400/50",
      iconBg: "bg-amber-500/10 dark:bg-amber-400/20",
      iconColor: "text-amber-500 dark:text-amber-400",
    },
    {
      id: "signature",
      label: "Ed25519 Sign",
      desc: "Receipt signed with server's private key",
      icon: Fingerprint,
      color: "border-green-500/50 dark:border-green-400/50",
      iconBg: "bg-green-500/10 dark:bg-green-400/20",
      iconColor: "text-green-500 dark:text-green-400",
    },
    {
      id: "ledger",
      label: "Hash Chain",
      desc: "Receipt linked to previous entry in tamper-evident ledger",
      icon: Layers,
      color: "border-primary/50",
      iconBg: "bg-primary/10 dark:bg-primary/20",
      iconColor: "text-primary",
    },
    {
      id: "verify",
      label: "Verification",
      desc: "Anyone can verify signatures and chain integrity",
      icon: Eye,
      color: "border-green-500/50 dark:border-green-400/50",
      iconBg: "bg-green-500/10 dark:bg-green-400/20",
      iconColor: "text-green-500 dark:text-green-400",
    },
  ];

  return (
    <section id="architecture" className="py-20 sm:py-28">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <FadeIn>
          <div className="text-center max-w-3xl mx-auto mb-16">
            <Badge variant="outline" className="mb-4">
              <Layers className="w-3 h-3 mr-1" />
              Architecture
            </Badge>
            <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              The Control Boundary
            </h2>
            <p className="text-lg text-muted-foreground">
              From AI model output to publicly verifiable proof — every step is cryptographically secured. Here's how code flows through ForgeProof's attestation pipeline.
            </p>
          </div>
        </FadeIn>

        <div className="relative mb-12">
          <div className="hidden lg:block absolute top-1/2 left-0 right-0 h-0.5 bg-gradient-to-r from-blue-500/20 via-primary/30 to-green-500/20 -translate-y-1/2" />

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-4 lg:gap-3">
            {steps.map((step, i) => (
              <FadeIn key={step.id} delay={i * 0.08}>
                <div className="relative flex flex-col items-center text-center" data-testid={`arch-step-${step.id}`}>
                  <Card className={`p-4 w-full border-2 ${step.color} relative z-10 bg-background`}>
                    <div className={`w-12 h-12 rounded-full ${step.iconBg} flex items-center justify-center mx-auto mb-3`}>
                      <step.icon className={`w-5 h-5 ${step.iconColor}`} />
                    </div>
                    <h4 className="font-semibold text-sm mb-1">{step.label}</h4>
                    <p className="text-xs text-muted-foreground leading-relaxed">{step.desc}</p>
                  </Card>
                  {i < steps.length - 1 && (
                    <ArrowRight className="hidden lg:block absolute -right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground z-20" />
                  )}
                </div>
              </FadeIn>
            ))}
          </div>
        </div>

        <FadeIn delay={0.6}>
          <div className="grid sm:grid-cols-3 gap-4">
            {[
              {
                label: "Trust Boundary",
                desc: "Everything from hashing through signing happens on your ForgeProof server. Self-host to keep the signing key under your control.",
                icon: Lock,
              },
              {
                label: "Immutable Record",
                desc: "Once a receipt is signed and chained, it cannot be modified without breaking the hash chain and invalidating the signature.",
                icon: Link2,
              },
              {
                label: "Public Verifiability",
                desc: "Verification requires only the public key. Anyone can independently confirm receipt authenticity without trusting ForgeProof.",
                icon: Eye,
              },
            ].map((item) => (
              <Card key={item.label} className="p-4" data-testid={`arch-property-${item.label.toLowerCase().replace(/\s+/g, "-")}`}>
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                    <item.icon className="w-4 h-4 text-primary" />
                  </div>
                  <div>
                    <h4 className="font-semibold text-sm mb-1">{item.label}</h4>
                    <p className="text-xs text-muted-foreground leading-relaxed">{item.desc}</p>
                  </div>
                </div>
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
  const useCases = [
    {
      icon: Shield,
      title: "Defense Contractors",
      audience: "CMMC Level 2+ organizations",
      desc: "Defense contractors using AI-assisted development need to demonstrate NIST SP 800-171 compliance for all code — including AI-generated output. ForgeProof provides the audit trail, traceability, and configuration management records that CMMC assessors require.",
      bullets: [
        "CMMC AU (Audit) family control evidence",
        "Traceability from AI model to deployed artifact",
        "US-only model jurisdiction enforcement",
        "Exportable compliance documentation",
      ],
    },
    {
      icon: Building2,
      title: "Government Procurement",
      audience: "Federal agencies & system integrators",
      desc: "Federal agencies are increasingly required to understand the AI tools used in software they procure. ForgeProof gives procurement officers verifiable evidence of which AI models contributed to delivered software.",
      bullets: [
        "NIST AI RMF alignment documentation",
        "Supply chain transparency for AI-generated code",
        "Geographic origin verification for data sovereignty",
        "Audit-ready provenance reports",
      ],
    },
    {
      icon: Cpu,
      title: "AI Development Teams",
      audience: "Teams using multiple AI models in production",
      desc: "Development teams using GPT-4, Claude, Copilot, and other models simultaneously need visibility into which model produced what. ForgeProof creates a permanent record across your entire AI-assisted workflow.",
      bullets: [
        "Multi-model tracking across repositories",
        "Security audit attestation with provider separation",
        "CI/CD integration for automatic attestation",
        "Analytics by model, provider, and repository",
      ],
    },
    {
      icon: Layers,
      title: "Enterprise Software Supply Chain",
      audience: "Software composition & security teams",
      desc: "Software supply chain security now extends to AI code generation. ForgeProof adds the missing layer between your AI tools and your SBOM — proving where code originated before it enters your build pipeline.",
      bullets: [
        "Complements SLSA and SBOM with AI provenance",
        "Hash-chained ledger for tamper detection",
        "Integrates before build attestation (Sigstore/cosign)",
        "Self-hostable for on-premises supply chain control",
      ],
    },
    {
      icon: Globe,
      title: "Regulated Industries",
      audience: "Finance, healthcare, critical infrastructure",
      desc: "Regulated industries face emerging requirements around AI transparency and data sovereignty. ForgeProof provides the provenance infrastructure needed before regulations become enforceable.",
      bullets: [
        "EU AI Act Article 12 traceability compliance",
        "Cyber Resilience Act supply chain documentation",
        "Geographic compliance for data residency laws",
        "Immutable audit trail for regulatory inspections",
      ],
    },
    {
      icon: Code2,
      title: "Open Source Maintainers",
      audience: "Projects with AI-assisted contributions",
      desc: "Open source projects increasingly receive AI-generated contributions. ForgeProof lets maintainers and consumers see which models contributed to a project, building trust and transparency.",
      bullets: [
        "Badge embeds showing attestation status",
        "Public verification — no login required",
        "Apache 2.0 licensed, self-hostable",
        "Community-driven attestation standards",
      ],
    },
  ];

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
              Who Needs Code Provenance
            </h2>
            <p className="text-lg text-muted-foreground">
              From defense contractors to open source maintainers, any organization using AI to generate code needs verifiable provenance infrastructure.
            </p>
          </div>
        </FadeIn>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {useCases.map((item, i) => (
            <FadeIn key={item.title} delay={i * 0.08}>
              <Card className="p-6 h-full" data-testid={`card-usecase-${i}`}>
                <div className="flex items-start gap-3 mb-4">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                    <item.icon className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <h4 className="font-semibold">{item.title}</h4>
                    <p className="text-xs text-muted-foreground">{item.audience}</p>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed mb-4">{item.desc}</p>
                <ul className="space-y-1.5">
                  {item.bullets.map((b) => (
                    <li key={b} className="flex items-start gap-2 text-xs text-muted-foreground">
                      <CheckCircle2 className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
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

function PolicyEnforcementSection() {
  const policies = [
    {
      icon: Globe,
      title: "Jurisdiction Enforcement",
      desc: "Restrict attestations to code generated by models operating within approved jurisdictions. Enforce US-only, EU-only, or custom geographic policies per repository or organization.",
      example: "Policy: Only accept attestations where country_of_origin is 'US' for defense-classified repositories.",
    },
    {
      icon: Cpu,
      title: "Approved Model Lists",
      desc: "Define which AI models are authorized to generate code for specific projects. Reject attestations from unapproved models before they enter your provenance chain.",
      example: "Policy: Only GPT-4-turbo and Claude Sonnet are approved for production code in the payments repository.",
    },
    {
      icon: Shield,
      title: "Provider Separation",
      desc: "Enforce that security audit attestations come from a different AI provider than the origin attestation. The model that writes code cannot certify its own security.",
      example: "Enforcement: OpenAI generates code → Anthropic audits. API rejects same-provider audit attempts.",
    },
    {
      icon: FileCheck,
      title: "Compliance Evidence",
      desc: "Generate exportable compliance reports showing policy adherence across your attestation history. Printable certificates, JSON exports, and audit-ready documentation.",
      example: "Export: HTML certificate showing all attestations in Q1 2026 came from US-based models with independent audits.",
    },
  ];

  return (
    <section id="policy" className="py-20 sm:py-28">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <FadeIn>
          <div className="text-center max-w-3xl mx-auto mb-16">
            <Badge variant="outline" className="mb-4">
              <Lock className="w-3 h-3 mr-1" />
              Policy Enforcement
            </Badge>
            <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Define Rules. Enforce Them Cryptographically.
            </h2>
            <p className="text-lg text-muted-foreground">
              ForgeProof doesn't just record provenance — it enforces organizational policy at the attestation layer. Define which models, providers, and jurisdictions are approved, and ForgeProof rejects non-compliant attestations before they enter the chain.
            </p>
          </div>
        </FadeIn>

        <div className="grid md:grid-cols-2 gap-6 mb-12">
          {policies.map((policy, i) => (
            <FadeIn key={policy.title} delay={i * 0.1}>
              <Card className="p-6 h-full" data-testid={`card-policy-${i}`}>
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                    <policy.icon className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1">
                    <h4 className="font-semibold mb-2">{policy.title}</h4>
                    <p className="text-sm text-muted-foreground leading-relaxed mb-3">{policy.desc}</p>
                    <div className="bg-muted/50 rounded-md p-3 border border-border/50">
                      <p className="text-xs font-mono text-muted-foreground">{policy.example}</p>
                    </div>
                  </div>
                </div>
              </Card>
            </FadeIn>
          ))}
        </div>

        <FadeIn delay={0.5}>
          <Card className="p-6 sm:p-8 bg-primary/5 dark:bg-primary/10 border-primary/20">
            <div className="text-center max-w-2xl mx-auto">
              <h4 className="font-display text-lg font-semibold mb-3">Why This Matters</h4>
              <p className="text-sm text-muted-foreground leading-relaxed">
                When regulators ask "can you prove your AI-generated code came from approved models operating in approved jurisdictions?" — policy enforcement gives you a cryptographically verifiable answer, not a spreadsheet.
              </p>
            </div>
          </Card>
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

function WhyForgeProofSection() {
  const competitors = [
    {
      name: "Sigstore / cosign / SLSA",
      focus: "Build Artifact Signing & Attestation",
      desc: "Proves a binary was built from specific source code in a trusted CI/CD environment. Cosign signs container images; SLSA defines provenance predicates for build processes. Industry standard for supply chain integrity.",
      gap: "Attests the build process, not the code generation process. Cannot answer: which AI model wrote the source code, where the model operates, or whether a different AI independently audited the output. ForgeProof sits upstream of Sigstore — it attests code origin before the build even starts.",
      icon: Boxes,
      color: "text-orange-500 dark:text-orange-400",
      bgColor: "bg-orange-500/10 dark:bg-orange-400/20",
    },
    {
      name: "SBOM (SPDX / CycloneDX)",
      focus: "Software Composition & Dependency Tracking",
      desc: "Software Bills of Materials list every component, library, and dependency in a software product. Required by executive order for federal suppliers. Critical for vulnerability management.",
      gap: "SBOMs track what components are in the software, not how they were created. An SBOM tells you the code uses express@4.18 — but not that GPT-4 wrote the authentication module or that Claude audited it. ForgeProof adds the AI provenance layer that SBOMs lack.",
      icon: Layers,
      color: "text-emerald-500 dark:text-emerald-400",
      bgColor: "bg-emerald-500/10 dark:bg-emerald-400/20",
    },
    {
      name: "C2PA / Content Credentials",
      focus: "Media Provenance",
      desc: "Attaches provenance metadata to images, video, and audio. Backed by Adobe, Google, Microsoft. Exploring text/code extensions.",
      gap: "Designed for media files, not code. Code can be trivially refactored to remove embedded watermarks, making watermarking-based approaches impractical. ForgeProof uses external attestation receipts that survive code modification and refactoring.",
      icon: Eye,
      color: "text-cyan-500 dark:text-cyan-400",
      bgColor: "bg-cyan-500/10 dark:bg-cyan-400/20",
    },
    {
      name: "Enterprise Tools (Cycode, Legit Security)",
      focus: "Pipeline Hardening",
      desc: "Commercial platforms for build pipeline security, SBOM generation, and artifact signing. Provide CI/CD security posture management and policy enforcement.",
      gap: "Closed-source, vendor-locked, and focused on build pipeline security rather than AI code generation provenance. No multi-model separation of concerns, no hash-chained attestation ledger, no public verification. ForgeProof is open source and purpose-built for AI code origin.",
      icon: Building2,
      color: "text-violet-500 dark:text-violet-400",
      bgColor: "bg-violet-500/10 dark:bg-violet-400/20",
    },
  ];

  return (
    <section id="why-forgeproof" className="py-20 sm:py-28">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <FadeIn>
          <div className="text-center max-w-3xl mx-auto mb-16">
            <Badge variant="outline" className="mb-4">
              <Scale className="w-3 h-3 mr-1" />
              Competitive Landscape
            </Badge>
            <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Why ForgeProof?
            </h2>
            <p className="text-lg text-muted-foreground">
              Existing tools answer "was this binary built from this source?" ForgeProof answers the question they can't:{" "}
              <span className="text-foreground font-medium">"Which AI wrote this code, from where, and who independently verified it?"</span>
            </p>
          </div>
        </FadeIn>

        <div className="space-y-6 mb-12">
          {competitors.map((comp, i) => (
            <FadeIn key={comp.name} delay={i * 0.1}>
              <Card className="p-6 sm:p-8" data-testid={`card-competitor-${i}`}>
                <div className="grid md:grid-cols-[1fr_auto_1fr] gap-6 items-start">
                  <div>
                    <div className="flex items-center gap-3 mb-3">
                      <div className={`w-10 h-10 rounded-lg ${comp.bgColor} flex items-center justify-center`}>
                        <comp.icon className={`w-5 h-5 ${comp.color}`} />
                      </div>
                      <div>
                        <h4 className="font-semibold">{comp.name}</h4>
                        <p className="text-xs text-muted-foreground">{comp.focus}</p>
                      </div>
                    </div>
                    <p className="text-sm text-muted-foreground leading-relaxed">{comp.desc}</p>
                  </div>
                  <div className="hidden md:flex items-center self-center">
                    <ArrowRight className="w-5 h-5 text-muted-foreground" />
                  </div>
                  <div className="md:border-l md:border-border md:pl-6">
                    <div className="flex items-center gap-2 mb-2">
                      <AlertTriangle className="w-4 h-4 text-amber-500" />
                      <span className="text-sm font-medium text-amber-600 dark:text-amber-400">The Gap</span>
                    </div>
                    <p className="text-sm text-muted-foreground leading-relaxed">{comp.gap}</p>
                  </div>
                </div>
              </Card>
            </FadeIn>
          ))}
        </div>

        <FadeIn delay={0.4}>
          <Card className="p-6 sm:p-8 bg-primary/5 dark:bg-primary/10 border-primary/20">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-full bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                <ForgeProofLogo size={28} />
              </div>
              <div>
                <h4 className="font-semibold mb-2 text-lg">ForgeProof Fills the Gap</h4>
                <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                  ForgeProof is purpose-built for the AI code generation era. It sits above build attestation tools, answering questions that Sigstore, SLSA, and C2PA were never designed to address.
                </p>
                <div className="grid sm:grid-cols-2 gap-3">
                  {[
                    "Which AI model generated each file",
                    "Which country/jurisdiction the model operates in",
                    "Independent security audit by a different AI provider",
                    "Cryptographic chain linking origin to audit to remediation",
                    "Open source and self-hostable - no vendor lock-in",
                    "Designed for CMMC, EU AI Act, and emerging regulations",
                  ].map((point) => (
                    <div key={point} className="flex items-start gap-2 text-sm">
                      <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                      <span>{point}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Card>
        </FadeIn>
      </div>
    </section>
  );
}

function RegulatorySection() {
  const regulations = [
    {
      name: "CMMC 2.0",
      fullName: "Cybersecurity Maturity Model Certification",
      status: "Effective Nov 2025",
      statusColor: "text-red-500 dark:text-red-400",
      jurisdiction: "United States (DoD)",
      relevance: "Level 2 requires 110 NIST SP 800-171 controls including audit logging, configuration management, and traceability for all code in defense systems. AI-generated code must meet the same controls.",
      icon: Shield,
    },
    {
      name: "NDAA FY2026 AI Framework",
      fullName: "National Defense Authorization Act - AI Security Extension",
      status: "In development",
      statusColor: "text-amber-500 dark:text-amber-400",
      jurisdiction: "United States (DoD)",
      relevance: "Directs DoD to develop an AI security framework as a CMMC extension covering AI source code, model weights, and training data. Expected to result in DFARS amendments for defense contractor compliance.",
      icon: Building2,
    },
    {
      name: "EU AI Act",
      fullName: "Regulation (EU) 2024/1689",
      status: "Full applicability Aug 2026",
      statusColor: "text-amber-500 dark:text-amber-400",
      jurisdiction: "European Union",
      relevance: "High-risk AI systems require complete technical documentation: software architecture, data provenance, training methodology, and supply chain transparency. Article 12 mandates automatic logging for traceability.",
      icon: Globe,
    },
    {
      name: "EU Cyber Resilience Act",
      fullName: "CRA - Software Supply Chain Security",
      status: "Effective 2025-2027",
      statusColor: "text-amber-500 dark:text-amber-400",
      jurisdiction: "European Union",
      relevance: "Requires SBOMs with provenance data, version-specific traceability to build processes, and vulnerability handling for all software products sold in the EU market.",
      icon: Lock,
    },
    {
      name: "NIST AI 100-4",
      fullName: "Reducing Risks Posed by Synthetic Content",
      status: "Published Nov 2024",
      statusColor: "text-green-500 dark:text-green-400",
      jurisdiction: "United States (Voluntary)",
      relevance: "Recommends digital watermarking, metadata recording, and provenance tracking for AI-generated content including code. Endorses C2PA-style manifests for code provenance.",
      icon: FileCheck,
    },
    {
      name: "US State AI Laws",
      fullName: "Emerging state-level AI transparency and accountability legislation",
      status: "Evolving 2025-2026",
      statusColor: "text-amber-500 dark:text-amber-400",
      jurisdiction: "US States",
      relevance: "Multiple US states are advancing legislation that incentivizes or requires NIST AI RMF adoption, AI-generated content disclosure, and provenance tracking for AI outputs used in regulated industries.",
      icon: Scale,
    },
  ];

  return (
    <section id="regulations" className="py-20 sm:py-28 bg-card/50 border-y border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <FadeIn>
          <div className="text-center max-w-3xl mx-auto mb-16">
            <Badge variant="outline" className="mb-4">
              <Scale className="w-3 h-3 mr-1" />
              Regulatory Landscape
            </Badge>
            <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Code Provenance Is Becoming Mandatory
            </h2>
            <p className="text-lg text-muted-foreground">
              Governments worldwide are moving from voluntary guidance to enforceable requirements for AI-generated code traceability. Organizations that build provenance infrastructure now will be ready when compliance becomes mandatory.
            </p>
          </div>
        </FadeIn>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
          {regulations.map((reg, i) => (
            <FadeIn key={reg.name} delay={i * 0.08}>
              <Card className="p-5 h-full" data-testid={`card-regulation-${i}`}>
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                    <reg.icon className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <h4 className="font-semibold">{reg.name}</h4>
                      <span className={`text-xs font-medium ${reg.statusColor}`}>{reg.status}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mb-2">{reg.fullName} &middot; {reg.jurisdiction}</p>
                    <p className="text-sm text-muted-foreground leading-relaxed">{reg.relevance}</p>
                  </div>
                </div>
              </Card>
            </FadeIn>
          ))}
        </div>

        <FadeIn delay={0.5}>
          <Card className="p-6 sm:p-8 bg-primary/5 dark:bg-primary/10 border-primary/20">
            <div className="text-center max-w-2xl mx-auto">
              <h4 className="font-display text-lg font-semibold mb-3">How ForgeProof Helps</h4>
              <p className="text-sm text-muted-foreground leading-relaxed mb-6">
                ForgeProof generates the audit trail, cryptographic proof, and provenance documentation that these regulations demand - before compliance deadlines arrive.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {[
                  { label: "Audit Logging", desc: "CMMC AU family" },
                  { label: "Traceability", desc: "EU AI Act Art. 12" },
                  { label: "Provenance Metadata", desc: "NIST AI 100-4" },
                  { label: "Supply Chain Docs", desc: "CRA/SBOM" },
                ].map((item) => (
                  <div key={item.label} className="text-center">
                    <p className="font-semibold text-sm">{item.label}</p>
                    <p className="text-xs text-muted-foreground">{item.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </FadeIn>
      </div>
    </section>
  );
}

function OpenSourceSection() {
  return (
    <section id="open-source" className="py-20 sm:py-28">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <FadeIn>
          <div className="text-center max-w-3xl mx-auto mb-16">
            <Badge variant="outline" className="mb-4">
              <Heart className="w-3 h-3 mr-1" />
              Open Source
            </Badge>
            <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Free, Open, and Yours to Deploy
            </h2>
            <p className="text-lg text-muted-foreground">
              ForgeProof is released under the Apache License 2.0. Download it, self-host it, modify it, and integrate it into your workflow. All we ask is attribution.
            </p>
          </div>
        </FadeIn>

        <div className="grid md:grid-cols-3 gap-8 mb-12">
          <FadeIn delay={0.1}>
            <Card className="p-6 h-full" data-testid="card-open-source-license">
              <div className="w-12 h-12 rounded-lg bg-primary/10 dark:bg-primary/20 flex items-center justify-center mb-5">
                <Scale className="w-6 h-6 text-primary" />
              </div>
              <h3 className="font-display text-lg font-semibold mb-3">Apache License 2.0</h3>
              <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                Use ForgeProof for any purpose - commercial or personal. Modify it freely. Distribute it. The only requirement: keep the attribution notices intact so the original creators are recognized.
              </p>
              <ul className="space-y-2">
                {[
                  "Free for commercial and personal use",
                  "Modify and distribute freely",
                  "Patent grant included",
                  "Attribution required (NOTICE file)",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </FadeIn>

          <FadeIn delay={0.2}>
            <Card className="p-6 h-full" data-testid="card-open-source-selfhost">
              <div className="w-12 h-12 rounded-lg bg-primary/10 dark:bg-primary/20 flex items-center justify-center mb-5">
                <Server className="w-6 h-6 text-primary" />
              </div>
              <h3 className="font-display text-lg font-semibold mb-3">Self-Host Anywhere</h3>
              <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                Run ForgeProof on your own infrastructure. Keep attestation data on-premises for maximum security and compliance. No external dependencies required.
              </p>
              <ul className="space-y-2">
                {[
                  "Node.js + PostgreSQL - standard stack",
                  "Docker-ready deployment",
                  "On-premises or cloud - your choice",
                  "No vendor lock-in or external calls",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </FadeIn>

          <FadeIn delay={0.3}>
            <Card className="p-6 h-full" data-testid="card-open-source-community">
              <div className="w-12 h-12 rounded-lg bg-primary/10 dark:bg-primary/20 flex items-center justify-center mb-5">
                <GitPullRequest className="w-6 h-6 text-primary" />
              </div>
              <h3 className="font-display text-lg font-semibold mb-3">Community-Driven</h3>
              <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                ForgeProof is built in the open. Contributions are welcome - from bug fixes to new attestation types to integrations with additional AI providers.
              </p>
              <ul className="space-y-2">
                {[
                  "Contribute on GitHub",
                  "Report issues and request features",
                  "Build integrations and plugins",
                  "Join the provenance community",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </FadeIn>
        </div>

        <FadeIn delay={0.4}>
          <div className="flex flex-wrap justify-center items-center gap-4">
            <a href="https://github.com/bxrist/ForgeProof" target="_blank" rel="noopener noreferrer">
              <Button size="lg" variant="outline" data-testid="button-opensource-github">
                <SiGithub className="w-4 h-4 mr-2" />
                View on GitHub
              </Button>
            </a>
            <a href="https://github.com/bxrist/ForgeProof" target="_blank" rel="noopener noreferrer">
              <Button size="lg" variant="outline" data-testid="button-opensource-download">
                <Download className="w-4 h-4 mr-2" />
                Download Latest Release
              </Button>
            </a>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}

function RoadmapSection() {
  const completed = [
    "Ed25519 cryptographic attestation receipts",
    "SHA-256 hash-chained attestation ledger",
    "Multi-model attestation with provider separation",
    "GitHub OAuth integration and webhook listener",
    "Repository sync and auto-attestation on push",
    "MCP Tool Server for AI agent integration",
    "OpenAPI spec for GPT Actions",
    "Analytics dashboard with provider/model/country breakdowns",
    "Badge embeds for repositories and attestations",
    "Certificate export (printable HTML)",
    "Team/organization support",
    "Audit logging with full activity trail",
    "Public verification and lookup endpoints",
    "SDK documentation with receipt format reference",
    "Geographic compliance tracking",
    "Threat model and security analysis documentation",
    "Terminology glossary for onboarding",
    "Architecture diagram and control boundary docs",
    "Buyer-specific use case narratives",
    "Competitive landscape (SLSA, SBOM, C2PA, cosign)",
    "Regulatory compliance positioning (CMMC, EU AI Act, NIST)",
  ];

  const planned = [
    { item: "SLSA provenance predicate integration", desc: "Generate SLSA-compatible provenance alongside ForgeProof receipts" },
    { item: "CI/CD pipeline plugins", desc: "GitHub Actions, GitLab CI, and Jenkins plugins for automatic attestation" },
    { item: "Additional AI provider integrations", desc: "First-class support for Gemini, Mistral, Llama, and more" },
    { item: "SBOM generation", desc: "Software Bill of Materials with ForgeProof provenance data" },
    { item: "Policy engine", desc: "Define and enforce attestation policies per repository or organization" },
    { item: "Attestation federation", desc: "Cross-instance attestation verification for supply chain transparency" },
    { item: "IDE plugins", desc: "VS Code and JetBrains extensions for inline attestation status" },
  ];

  return (
    <section id="roadmap" className="py-20 sm:py-28 bg-card/50 border-y border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <FadeIn>
          <div className="text-center max-w-3xl mx-auto mb-16">
            <Badge variant="outline" className="mb-4">
              <Milestone className="w-3 h-3 mr-1" />
              Roadmap
            </Badge>
            <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Built and Building
            </h2>
            <p className="text-lg text-muted-foreground">
              ForgeProof is production-ready today with a comprehensive feature set. Here's what's done and what's coming next.
            </p>
          </div>
        </FadeIn>

        <div className="grid md:grid-cols-2 gap-8 lg:gap-12">
          <FadeIn delay={0.1}>
            <div>
              <div className="flex items-center gap-2 mb-6">
                <div className="w-8 h-8 rounded-full bg-green-500/10 dark:bg-green-400/20 flex items-center justify-center">
                  <CheckCircle2 className="w-4 h-4 text-green-500 dark:text-green-400" />
                </div>
                <h3 className="font-display text-lg font-semibold">Shipped</h3>
                <Badge variant="secondary" className="ml-auto">{completed.length} features</Badge>
              </div>
              <div className="space-y-2.5">
                {completed.map((item) => (
                  <div key={item} className="flex items-start gap-2.5 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-green-500 dark:text-green-400 mt-0.5 shrink-0" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </FadeIn>

          <FadeIn delay={0.2}>
            <div>
              <div className="flex items-center gap-2 mb-6">
                <div className="w-8 h-8 rounded-full bg-blue-500/10 dark:bg-blue-400/20 flex items-center justify-center">
                  <Rocket className="w-4 h-4 text-blue-500 dark:text-blue-400" />
                </div>
                <h3 className="font-display text-lg font-semibold">Planned</h3>
                <Badge variant="secondary" className="ml-auto">{planned.length} items</Badge>
              </div>
              <div className="space-y-4">
                {planned.map((item) => (
                  <div key={item.item} className="flex items-start gap-2.5">
                    <Rocket className="w-4 h-4 text-blue-500 dark:text-blue-400 mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm font-medium">{item.item}</p>
                      <p className="text-xs text-muted-foreground">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </FadeIn>
        </div>

        <FadeIn delay={0.4}>
          <Card className="mt-12 p-6 sm:p-8 text-center bg-primary/5 dark:bg-primary/10 border-primary/20">
            <h4 className="font-semibold mb-2">Want to influence the roadmap?</h4>
            <p className="text-sm text-muted-foreground mb-4 max-w-lg mx-auto">
              ForgeProof is community-driven. Open an issue on GitHub to request features, report bugs, or propose integrations.
            </p>
            <a href="https://github.com/bxrist/ForgeProof" target="_blank" rel="noopener noreferrer">
              <Button variant="outline" data-testid="button-roadmap-github">
                <SiGithub className="w-4 h-4 mr-2" />
                Open an Issue
              </Button>
            </a>
          </Card>
        </FadeIn>
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
            <a href="https://github.com/bxrist/ForgeProof" target="_blank" rel="noopener noreferrer">
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
        <div className="grid grid-cols-2 md:grid-cols-5 gap-8">
          <div className="col-span-2 md:col-span-1 space-y-4">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <FlyingCloudLogo size={84} />
                <div className="flex flex-col leading-tight">
                  <span className="font-display font-bold tracking-tight">ForgeProof</span>
                  <span className="text-[9px] text-muted-foreground tracking-wide uppercase">by Flying Cloud Technology</span>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                Code provenance for the AI era.
              </p>
            </div>
            <div className="pt-1">
              <a href="https://www.flyingcloudtech.com" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors" data-testid="link-footer-fct">
                <ExternalLink className="w-3 h-3" />
                flyingcloudtech.com
              </a>
            </div>
            <div className="text-xs text-muted-foreground space-y-1">
              <p>&copy; 2026 Flying Cloud Technology</p>
              <p>Licensed under <a href="https://www.apache.org/licenses/LICENSE-2.0" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors underline" data-testid="link-footer-license">Apache License 2.0</a></p>
            </div>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-3">Platform</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><a href="#architecture" className="hover:text-foreground transition-colors" data-testid="link-footer-architecture">Architecture</a></li>
              <li><a href="#use-cases" className="hover:text-foreground transition-colors" data-testid="link-footer-use-cases">Use Cases</a></li>
              <li><a href="#why-forgeproof" className="hover:text-foreground transition-colors" data-testid="link-footer-why">Why ForgeProof</a></li>
              <li><a href="#regulations" className="hover:text-foreground transition-colors" data-testid="link-footer-compliance">Compliance</a></li>
              <li><a href="#policy" className="hover:text-foreground transition-colors" data-testid="link-footer-policy">Policy Enforcement</a></li>
              <li><a href="#roadmap" className="hover:text-foreground transition-colors" data-testid="link-footer-roadmap">Roadmap</a></li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-3">Resources</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><Link href="/demo" className="hover:text-foreground transition-colors" data-testid="link-footer-demo">Demo</Link></li>
              <li><Link href="/sdk" className="hover:text-foreground transition-colors" data-testid="link-footer-sdk">SDK & Receipt Format</Link></li>
              <li><Link href="/threat-model" className="hover:text-foreground transition-colors" data-testid="link-footer-threat-model">Threat Model</Link></li>
              <li><Link href="/glossary" className="hover:text-foreground transition-colors" data-testid="link-footer-glossary">Terminology</Link></li>
              <li><Link href="/verify" className="hover:text-foreground transition-colors" data-testid="link-footer-verify">Verify</Link></li>
              <li><Link href="/lookup" className="hover:text-foreground transition-colors" data-testid="link-footer-lookup">Lookup</Link></li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-3">Open Source</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><a href="#open-source" className="hover:text-foreground transition-colors" data-testid="link-footer-open-source">About</a></li>
              <li>
                <a href="https://github.com/bxrist/ForgeProof" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors flex items-center gap-1.5" data-testid="link-footer-github">
                  <SiGithub className="w-3.5 h-3.5" />
                  GitHub
                </a>
              </li>
              <li><a href="https://www.apache.org/licenses/LICENSE-2.0" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors" data-testid="link-footer-apache">License (Apache 2.0)</a></li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold text-sm mb-3">Standards</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><a href="https://slsa.dev" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors" data-testid="link-footer-slsa">SLSA</a></li>
              <li><a href="https://c2pa.org" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors" data-testid="link-footer-c2pa">C2PA</a></li>
              <li><a href="https://www.nist.gov/itl/ai-risk-management-framework" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors" data-testid="link-footer-nist">NIST AI RMF</a></li>
              <li><a href="https://in-toto.io" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors" data-testid="link-footer-intoto">in-toto</a></li>
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
      <ArchitectureDiagramSection />
      <HowItWorksSection />
      <UseCasesSection />
      <MultiModelSection />
      <PolicyEnforcementSection />
      <PlatformFeaturesSection />
      <WhyForgeProofSection />
      <RegulatorySection />
      <OpenSourceSection />
      <RoadmapSection />
      <ApiSection />
      <CTASection />
      <Footer />
    </div>
  );
}
