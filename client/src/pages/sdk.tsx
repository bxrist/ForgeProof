import { useState } from "react";
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
  Terminal,
  Code2,
  Copy,
  CheckCircle2,
  ExternalLink,
} from "lucide-react";

const pythonCode = `import requests
import hashlib

class ForgeProofClient:
    def __init__(self, api_key: str, base_url: str = "https://your-forgeproof.replit.app"):
        self.api_key = api_key
        self.base_url = base_url
        self.headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }

    def attest(self, file_path: str, file_content: str, model_name: str, 
               model_provider: str, country: str = "US"):
        file_hash = "sha256:" + hashlib.sha256(file_content.encode()).hexdigest()
        response = requests.post(
            f"{self.base_url}/api/v1/attest",
            headers=self.headers,
            json={
                "file_path": file_path,
                "file_hash": file_hash,
                "model_name": model_name,
                "model_provider": model_provider,
                "country_of_origin": country,
            }
        )
        return response.json()

    def attest_openai(self, files: list, model_name: str, session_id: str = None, country: str = "US"):
        response = requests.post(
            f"{self.base_url}/api/v1/agents/openai",
            headers=self.headers,
            json={
                "files": files,
                "model_name": model_name,
                "model_provider": "OpenAI",
                "country_of_origin": country,
                "session_id": session_id,
            }
        )
        return response.json()

    def attest_claude(self, files: list, model_name: str, session_id: str = None, country: str = "US"):
        response = requests.post(
            f"{self.base_url}/api/v1/agents/claude",
            headers=self.headers,
            json={
                "files": files,
                "model_name": model_name,
                "model_provider": "Anthropic",
                "country_of_origin": country,
                "session_id": session_id,
            }
        )
        return response.json()

    def lookup(self, query: str):
        response = requests.get(
            f"{self.base_url}/api/lookup",
            headers=self.headers,
            params={"q": query}
        )
        return response.json()

    def verify_chain(self):
        response = requests.get(f"{self.base_url}/api/verify/chain", headers=self.headers)
        return response.json()

# Usage
client = ForgeProofClient("fp_sk_your_key_here")
receipt = client.attest(
    file_path="src/utils/auth.ts",
    file_content="export function authenticate() { ... }",
    model_name="gpt-4-turbo",
    model_provider="OpenAI"
)
print(receipt)`;

const typescriptCode = `class ForgeProofClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl: string = "https://your-forgeproof.replit.app") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  private async request(path: string, options: RequestInit = {}) {
    const res = await fetch(\`\${this.baseUrl}\${path}\`, {
      ...options,
      headers: {
        "Authorization": \`Bearer \${this.apiKey}\`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    return res.json();
  }

  async attest(filePath: string, fileHash: string, modelName: string, 
               modelProvider: string, country: string = "US") {
    return this.request("/api/v1/attest", {
      method: "POST",
      body: JSON.stringify({
        file_path: filePath,
        file_hash: fileHash,
        model_name: modelName,
        model_provider: modelProvider,
        country_of_origin: country,
      }),
    });
  }

  async attestOpenAI(files: Array<{file_path: string; file_hash: string}>, 
                     modelName: string, sessionId?: string, country: string = "US") {
    return this.request("/api/v1/agents/openai", {
      method: "POST",
      body: JSON.stringify({
        files, model_name: modelName, model_provider: "OpenAI",
        country_of_origin: country, session_id: sessionId,
      }),
    });
  }

  async attestClaude(files: Array<{file_path: string; file_hash: string}>,
                     modelName: string, sessionId?: string, country: string = "US") {
    return this.request("/api/v1/agents/claude", {
      method: "POST",
      body: JSON.stringify({
        files, model_name: modelName, model_provider: "Anthropic",
        country_of_origin: country, session_id: sessionId,
      }),
    });
  }

  async lookup(query: string) {
    return this.request(\`/api/lookup?q=\${encodeURIComponent(query)}\`);
  }

  async verifyChain() {
    return this.request("/api/verify/chain");
  }
}

// Usage
const client = new ForgeProofClient("fp_sk_your_key_here");
const receipt = await client.attest(
  "src/utils/auth.ts",
  "sha256:a3f2e8c1...",
  "gpt-4-turbo",
  "OpenAI"
);
console.log(receipt);`;

const curlCode = `# Create an attestation
curl -X POST https://your-forgeproof.replit.app/api/v1/attest \\
  -H "Authorization: Bearer fp_sk_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{
    "file_path": "src/utils/auth.ts",
    "file_hash": "sha256:a3f2e8c1...",
    "model_name": "gpt-4-turbo",
    "model_provider": "OpenAI",
    "country_of_origin": "US"
  }'

# Look up a receipt
curl "https://your-forgeproof.replit.app/api/lookup?q=1"

# Verify the hash chain
curl "https://your-forgeproof.replit.app/api/verify/chain"

# Get the OpenAPI spec (for GPT Actions)
curl "https://your-forgeproof.replit.app/api/openapi.json"`;

const badgeMarkdown = `![ForgeProof](https://your-forgeproof.replit.app/api/badge/1.svg)`;

type Tab = "python" | "typescript" | "curl";

function CodeBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative bg-[#0d1117] rounded-lg border border-[#30363d] overflow-hidden font-mono text-sm">
      <div className="flex items-center justify-between gap-4 px-4 py-2.5 border-b border-[#30363d] bg-[#161b22]">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-[#ff5f57]" />
          <div className="w-3 h-3 rounded-full bg-[#febc2e]" />
          <div className="w-3 h-3 rounded-full bg-[#28c840]" />
          <span className="ml-2 text-xs text-[#8b949e]">{label}</span>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 text-xs text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
          data-testid={`button-copy-${label}`}
        >
          {copied ? (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
              <span className="text-green-400">Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto">
        <code className="text-[#c9d1d9] text-xs sm:text-sm leading-relaxed">{code}</code>
      </pre>
    </div>
  );
}

export default function SdkPage() {
  const { theme, toggleTheme } = useTheme();
  const [activeTab, setActiveTab] = useState<Tab>("python");

  const tabs: { id: Tab; label: string; icon: typeof Terminal }[] = [
    { id: "python", label: "Python", icon: Code2 },
    { id: "typescript", label: "TypeScript", icon: Code2 },
    { id: "curl", label: "curl", icon: Terminal },
  ];

  const codeMap: Record<Tab, { code: string; label: string }> = {
    python: { code: pythonCode, label: "forgeproof_client.py" },
    typescript: { code: typescriptCode, label: "forgeproof-client.ts" },
    curl: { code: curlCode, label: "terminal" },
  };

  return (
    <div className="min-h-screen bg-background">
      <SEO title="SDK Documentation" description="Python, TypeScript, and curl code examples for integrating with the ForgeProof attestation API." path="/sdk" />
      <header className="sticky top-0 z-[999] bg-background/80 backdrop-blur-xl border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-4 h-16">
            <Link href="/" className="flex items-center gap-2">
              <ForgeProofLogo size={44} />
              <span className="font-display font-bold text-xl tracking-tight" data-testid="sdk-logo-text">ForgeProof</span>
            </Link>

            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleTheme}
                data-testid="button-sdk-theme-toggle"
              >
                {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </Button>
              <Link href="/">
                <Button variant="ghost" size="sm" data-testid="button-back-home">
                  <ArrowLeft className="w-3.5 h-3.5 mr-1.5" />
                  Home
                </Button>
              </Link>
              <Link href="/demo">
                <Button variant="ghost" size="sm" data-testid="button-back-demo">
                  <ArrowLeft className="w-3.5 h-3.5 mr-1.5" />
                  Demo
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="mb-12 text-center">
          <Badge variant="outline" className="mb-4">
            <Terminal className="w-3 h-3 mr-1" />
            Developer Docs
          </Badge>
          <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mb-3" data-testid="sdk-heading">
            SDK & Integration Guide
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Integrate ForgeProof into your AI agent pipelines with ready-to-use clients for Python, TypeScript, and raw HTTP.
          </p>
        </div>

        <div className="mb-8">
          <div className="flex items-center gap-1 border-b border-border mb-6">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  activeTab === tab.id
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
                data-testid={`tab-${tab.id}`}
              >
                <tab.icon className="w-4 h-4" />
                {tab.label}
              </button>
            ))}
          </div>

          <CodeBlock
            code={codeMap[activeTab].code}
            label={codeMap[activeTab].label}
          />
        </div>

        <div className="space-y-8 mt-12">
          <Card className="p-6 sm:p-8">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                <ExternalLink className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h3 className="font-display text-lg font-semibold mb-2" data-testid="section-gpt-actions">GPT Actions Setup</h3>
                <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                  ForgeProof exposes an OpenAPI specification that can be imported directly into ChatGPT as a custom action. This allows GPT to create attestations, look up receipts, and verify the hash chain on your behalf.
                </p>
                <div className="space-y-3">
                  <div className="flex items-start gap-2.5 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    <span>Navigate to <strong>ChatGPT &rarr; Explore GPTs &rarr; Create</strong> and open the <strong>Configure</strong> tab.</span>
                  </div>
                  <div className="flex items-start gap-2.5 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    <span>Under <strong>Actions</strong>, click <strong>Import from URL</strong>.</span>
                  </div>
                  <div className="flex items-start gap-2.5 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    <span>Paste your ForgeProof OpenAPI endpoint:</span>
                  </div>
                </div>
                <div className="mt-4">
                  <CodeBlock
                    code="https://your-forgeproof.replit.app/api/openapi.json"
                    label="openapi-url"
                  />
                </div>
                <p className="text-sm text-muted-foreground mt-4 leading-relaxed">
                  Once imported, ChatGPT will be able to call your ForgeProof instance directly, creating attestations for every file it generates during a conversation.
                </p>
              </div>
            </div>
          </Card>

          <Card className="p-6 sm:p-8">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                <Code2 className="w-5 h-5 text-primary" />
              </div>
              <div>
                <div className="flex items-center gap-3 mb-2 flex-wrap">
                  <h3 className="font-display text-lg font-semibold" data-testid="section-mcp-integration">MCP Integration</h3>
                  <Badge variant="secondary" className="text-xs">Coming Soon</Badge>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  ForgeProof can be used as an MCP (Model Context Protocol) tool, allowing any MCP-compatible AI agent to create and verify attestations as part of its tool-use workflow. The MCP server exposes the same attestation, lookup, and verification capabilities as the REST API, enabling seamless integration with Claude Desktop, Cursor, and other MCP-enabled environments.
                </p>
              </div>
            </div>
          </Card>

          <Card className="p-6 sm:p-8">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                <CheckCircle2 className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h3 className="font-display text-lg font-semibold mb-2" data-testid="section-badge-embeds">Badge Embeds</h3>
                <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                  Embed a ForgeProof verification badge in your README or documentation to show that your repository uses cryptographic attestation. The badge dynamically reflects the verification status of a specific attestation.
                </p>
                <p className="text-sm text-muted-foreground mb-3">Add this to your Markdown:</p>
                <CodeBlock code={badgeMarkdown} label="README.md" />
              </div>
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
}
