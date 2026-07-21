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
  Shield,
  Layers,
  Bot,
} from "lucide-react";

const pythonCode = `import requests
import hashlib

class ForgeProofClient:
    def __init__(self, api_key: str, base_url: str = "https://forgeproof.flyingcloudtech.com"):
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

  constructor(apiKey: string, baseUrl: string = "https://forgeproof.flyingcloudtech.com") {
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
curl -X POST https://forgeproof.flyingcloudtech.com/api/v1/attest \\
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
curl "https://forgeproof.flyingcloudtech.com/api/lookup?q=1"

# Verify the hash chain
curl "https://forgeproof.flyingcloudtech.com/api/verify/chain"

# Get the OpenAPI spec (for GPT Actions)
curl "https://forgeproof.flyingcloudtech.com/api/openapi.json"`;

const badgeMarkdown = `![ForgeProof](https://forgeproof.flyingcloudtech.com/api/badge/1.svg)`;

const multiModelPythonCode = `import requests

# Step 1: Create origin attestation (code was written by GPT-4)
origin = requests.post(
    "https://your-app.replit.app/api/v1/attest",
    headers={"Authorization": "Bearer fp_your_api_key"},
    json={
        "file_hash": "sha256:a3f2e8d1...",
        "file_name": "auth.py",
        "file_path": "src/auth.py",
        "model_name": "gpt-4-turbo",
        "model_provider": "OpenAI",
        "country_of_origin": "US",
        "attestation_type": "origin"
    }
)
origin_id = origin.json()["id"]

# Step 2: Security audit by a DIFFERENT provider
audit = requests.post(
    "https://your-app.replit.app/api/v1/attest",
    headers={"Authorization": "Bearer fp_your_api_key"},
    json={
        "file_hash": "sha256:a3f2e8d1...",
        "file_name": "auth.py",
        "file_path": "src/auth.py",
        "model_name": "claude-3.5-sonnet",
        "model_provider": "Anthropic",
        "country_of_origin": "US",
        "attestation_type": "security_audit",
        "parent_attestation_id": origin_id,
        "audit_verdict": "secure",
        "audit_details": "No vulnerabilities detected."
    }
)`;

const multiModelTsCode = `// Step 1: Origin attestation
const origin = await fetch("/api/v1/attest", {
  method: "POST",
  headers: {
    "Authorization": "Bearer fp_your_api_key",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    file_hash: "sha256:a3f2e8d1...",
    file_name: "auth.ts",
    file_path: "src/auth.ts",
    model_name: "gpt-4-turbo",
    model_provider: "OpenAI",
    country_of_origin: "US",
    attestation_type: "origin"
  })
});
const { id: originId } = await origin.json();

// Step 2: Security audit by different provider
const audit = await fetch("/api/v1/attest", {
  method: "POST",
  headers: {
    "Authorization": "Bearer fp_your_api_key",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    file_hash: "sha256:a3f2e8d1...",
    file_name: "auth.ts",
    file_path: "src/auth.ts",
    model_name: "claude-3.5-sonnet",
    model_provider: "Anthropic",
    country_of_origin: "US",
    attestation_type: "security_audit",
    parent_attestation_id: originId,
    audit_verdict: "secure",
    audit_details: "No vulnerabilities detected."
  })
});`;

const multiModelCurlCode = `# Create security audit attestation
curl -X POST https://your-app.replit.app/api/v1/attest \\
  -H "Authorization: Bearer fp_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "file_hash": "sha256:a3f2e8d1...",
    "file_name": "auth.py",
    "file_path": "src/auth.py",
    "model_name": "claude-3.5-sonnet",
    "model_provider": "Anthropic",
    "country_of_origin": "US",
    "attestation_type": "security_audit",
    "parent_attestation_id": 42,
    "audit_verdict": "secure",
    "audit_details": "No vulnerabilities detected."
  }'`;

const multiModelWorkflow = `Step 1: Origin Attestation (GPT-4 writes code)
Step 2: Security Audit (Claude reviews code, different provider)
Step 3: Remediation (if issues found, Claude fixes and re-attests)`;

const mcpAuditToolCode = `Tool: forgeproof_audit_attest
Input: {
  "parentAttestationId": 42,
  "modelName": "claude-3.5-sonnet",
  "modelProvider": "Anthropic",
  "auditVerdict": "secure",
  "countryOfOrigin": "US",
  "auditDetails": "No vulnerabilities found."
}`;

const agentsPythonCode = `import hashlib
import requests

def attest_file(file_path, file_content, model_name, model_provider,
                api_key, country="US", attestation_type="origin"):
    file_hash = "sha256:" + hashlib.sha256(file_content).hexdigest()
    resp = requests.post(
        "https://forgeproof.flyingcloudtech.com/api/v1/attest",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "file_path": file_path,
            "file_hash": file_hash,
            "model_name": model_name,
            "model_provider": model_provider,
            "country_of_origin": country,
            "attestation_type": attestation_type,
        },
    )
    resp.raise_for_status()
    return resp.json()

receipt = attest_file(
    file_path="src/utils/auth.ts",
    file_content=open("src/utils/auth.ts", "rb").read(),
    model_name="claude-sonnet-4-5",
    model_provider="Anthropic",
    api_key="fp_sk_your_key_here",
)
print(receipt["id"], receipt["entry_hash"])`;

const agentsTypescriptCode = `import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

async function attestFile(
  filePath: string, modelName: string, modelProvider: string,
  apiKey: string, country = "US", attestationType = "origin",
) {
  const fileHash = "sha256:" + createHash("sha256")
    .update(readFileSync(filePath)).digest("hex");

  const res = await fetch("https://forgeproof.flyingcloudtech.com/api/v1/attest", {
    method: "POST",
    headers: { Authorization: \`Bearer \${apiKey}\`, "Content-Type": "application/json" },
    body: JSON.stringify({
      file_path: filePath, file_hash: fileHash,
      model_name: modelName, model_provider: modelProvider,
      country_of_origin: country, attestation_type: attestationType,
    }),
  });
  if (!res.ok) throw new Error(\`ForgeProof error: \${res.status}\`);
  return res.json();
}

const receipt = await attestFile(
  "src/utils/auth.ts", "gpt-4o", "OpenAI", "fp_sk_your_key_here"
);
console.log(receipt.id, receipt.entry_hash);`;

const agentsMcpCode = `{
  "tool": "forgeproof_attest",
  "input": {
    "file_path": "src/utils/auth.ts",
    "file_hash": "sha256:a3f2e8c1...",
    "model_name": "claude-sonnet-4-5",
    "model_provider": "Anthropic",
    "country_of_origin": "US",
    "attestation_type": "origin"
  }
}`;

const agentsCurlCode = `curl -X POST https://forgeproof.flyingcloudtech.com/api/v1/attest \\
  -H "Authorization: Bearer $FORGEPROOF_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "file_path": "src/utils/auth.ts",
    "file_hash": "sha256:a3f2e8c1...",
    "model_name": "gpt-4o",
    "model_provider": "OpenAI",
    "country_of_origin": "US",
    "attestation_type": "origin"
  }'`;

const agentsGitHubActionsCode = `# .github/workflows/forgeproof.yml
name: ForgeProof Attestation
on:
  push:
    branches: [main]
jobs:
  attest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Attest changed files
        env:
          FORGEPROOF_API_KEY: \${{ secrets.FORGEPROOF_API_KEY }}
          MODEL_NAME: \${{ vars.AI_MODEL_NAME || 'gpt-4o' }}
          MODEL_PROVIDER: \${{ vars.AI_MODEL_PROVIDER || 'OpenAI' }}
        run: |
          git diff --name-only HEAD~1 HEAD > changed_files.txt
          while IFS= read -r file; do
            [ -f "$file" ] || continue
            FILE_HASH="sha256:$(sha256sum "$file" | awk '{print $1}')"
            curl -sf -X POST https://forgeproof.flyingcloudtech.com/api/v1/attest \\
              -H "Authorization: Bearer $FORGEPROOF_API_KEY" \\
              -H "Content-Type: application/json" \\
              -d "{\\"file_path\\":\\"$file\\",\\"file_hash\\":\\"$FILE_HASH\\",\\"model_name\\":\\"$MODEL_NAME\\",\\"model_provider\\":\\"$MODEL_PROVIDER\\",\\"country_of_origin\\":\\"US\\",\\"attestation_type\\":\\"origin\\"}"
          done < changed_files.txt`;

const agentsPreCommitCode = `#!/bin/sh
# .git/hooks/pre-commit  (chmod +x .git/hooks/pre-commit)
API_KEY="\${FORGEPROOF_API_KEY}"
MODEL_NAME="\${FORGEPROOF_MODEL_NAME:-gpt-4o}"
MODEL_PROVIDER="\${FORGEPROOF_MODEL_PROVIDER:-OpenAI}"

git diff --cached --name-only --diff-filter=ACM | while IFS= read -r file; do
  [ -f "$file" ] || continue
  FILE_HASH="sha256:$(sha256sum "$file" | awk '{print $1}')"
  curl -sf -X POST https://forgeproof.flyingcloudtech.com/api/v1/attest \\
    -H "Authorization: Bearer $API_KEY" \\
    -H "Content-Type: application/json" \\
    -d "{\\"file_path\\":\\"$file\\",\\"file_hash\\":\\"$FILE_HASH\\",\\"model_name\\":\\"$MODEL_NAME\\",\\"model_provider\\":\\"$MODEL_PROVIDER\\",\\"country_of_origin\\":\\"US\\",\\"attestation_type\\":\\"origin\\"}" \\
    || echo "ForgeProof: attestation failed for $file (non-fatal)" >&2
done`;

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
  const [multiModelTab, setMultiModelTab] = useState<Tab>("python");

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

  const multiModelCodeMap: Record<Tab, { code: string; label: string }> = {
    python: { code: multiModelPythonCode, label: "multi_model_audit.py" },
    typescript: { code: multiModelTsCode, label: "multi-model-audit.ts" },
    curl: { code: multiModelCurlCode, label: "terminal" },
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

        <div className="mt-16 mb-12" id="receipt-format">
          <Badge variant="outline" className="mb-4">
            <Layers className="w-3 h-3 mr-1" />
            Receipt Format
          </Badge>
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight mb-3" data-testid="heading-receipt-format">
            Attestation Receipt Schema
          </h2>
          <p className="text-base text-muted-foreground max-w-2xl mb-8">
            Every attestation produces a signed JSON receipt. This is the canonical format — every field is part of the cryptographic commitment.
          </p>

          <div className="space-y-6">
            <Card className="p-6 sm:p-8" data-testid="card-receipt-example">
              <h3 className="font-display text-lg font-semibold mb-4">Example Receipt</h3>
              <CodeBlock code={`{
  "receipt_version": "v1",
  "id": 42,
  "file_path": "src/utils/auth.ts",
  "file_hash": "sha256:a3f2e8c1d9b4a7e6f5c3d2b1a0e9f8d7c6b5a4e3d2c1b0",
  "model_name": "gpt-4-turbo",
  "model_provider": "OpenAI",
  "country_of_origin": "US",
  "attestation_type": "origin",
  "timestamp": "2026-02-21T08:30:00.000Z",
  "signature": "ed25519:7Bf3kQ9xYz...<base64-encoded 64-byte signature>",
  "entry_hash": "sha256:9c1d4e3f2a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a",
  "prev_entry_hash": "sha256:8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e",
  "repository_id": 15,
  "user_id": 3,
  "parent_attestation_id": null,
  "audit_verdict": null,
  "audit_details": null
}`} label="attestation-receipt.json" />
            </Card>

            <Card className="p-6 sm:p-8" data-testid="card-receipt-fields">
              <h3 className="font-display text-lg font-semibold mb-4">Field Reference</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-receipt-fields">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left p-3 font-semibold">Field</th>
                      <th className="text-left p-3 font-semibold">Type</th>
                      <th className="text-left p-3 font-semibold">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { field: "receipt_version", type: "string", desc: "Schema version. Always \"v1\" for current receipts." },
                      { field: "id", type: "integer", desc: "Auto-incrementing receipt identifier." },
                      { field: "file_path", type: "string", desc: "Repository-relative path to the attested file." },
                      { field: "file_hash", type: "string", desc: "SHA-256 hash of the file content, prefixed with \"sha256:\"." },
                      { field: "model_name", type: "string", desc: "Specific AI model identifier (e.g., \"gpt-4-turbo\", \"claude-sonnet-4\")." },
                      { field: "model_provider", type: "string", desc: "AI provider organization (e.g., \"OpenAI\", \"Anthropic\", \"Replit\")." },
                      { field: "country_of_origin", type: "string", desc: "ISO 3166-1 alpha-2 country code where the model operates." },
                      { field: "attestation_type", type: "string | null", desc: "Type of attestation: \"origin\", \"security_audit\", \"refactor\", or \"review\"." },
                      { field: "timestamp", type: "ISO 8601", desc: "UTC timestamp when the attestation was created." },
                      { field: "signature", type: "string", desc: "Ed25519 signature over the receipt content, prefixed with \"ed25519:\"." },
                      { field: "entry_hash", type: "string", desc: "SHA-256 hash of this receipt (excluding entry_hash itself). Unique identifier." },
                      { field: "prev_entry_hash", type: "string | null", desc: "entry_hash of the previous receipt in the hash chain. Null for the first entry." },
                      { field: "repository_id", type: "integer | null", desc: "ID of the associated repository, if any." },
                      { field: "user_id", type: "integer | null", desc: "ID of the user who created the attestation." },
                      { field: "parent_attestation_id", type: "integer | null", desc: "ID of the parent receipt for multi-model chains (e.g., audit references origin)." },
                      { field: "audit_verdict", type: "string | null", desc: "For security_audit type: \"secure\", \"flagged\", \"remediated\", or \"needs_review\"." },
                      { field: "audit_details", type: "string | null", desc: "Free-text details from the security audit (findings, recommendations)." },
                    ].map((row) => (
                      <tr key={row.field} className="border-b border-border last:border-0">
                        <td className="p-3"><code className="text-xs bg-muted px-1.5 py-0.5 rounded">{row.field}</code></td>
                        <td className="p-3 text-muted-foreground text-xs">{row.type}</td>
                        <td className="p-3 text-muted-foreground">{row.desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card className="p-6 sm:p-8" data-testid="card-verification-process">
              <h3 className="font-display text-lg font-semibold mb-4">Verification Process</h3>
              <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                To independently verify an attestation receipt, follow these steps:
              </p>
              <div className="space-y-4">
                {[
                  {
                    step: "1",
                    title: "Verify the signature",
                    desc: "Extract the Ed25519 signature from the receipt. Reconstruct the signed payload (all fields except signature and entry_hash). Verify the signature against the ForgeProof server's public key.",
                  },
                  {
                    step: "2",
                    title: "Verify the entry hash",
                    desc: "Compute the SHA-256 hash of the canonical JSON representation of the receipt (excluding entry_hash). Compare against the stored entry_hash. Any mismatch indicates tampering.",
                  },
                  {
                    step: "3",
                    title: "Verify the hash chain",
                    desc: "Check that this receipt's prev_entry_hash matches the entry_hash of the preceding receipt. Walk the chain from the first entry to confirm no entries have been inserted, removed, or reordered.",
                  },
                  {
                    step: "4",
                    title: "Verify the file hash",
                    desc: "Compute the SHA-256 hash of the current file content. Compare against file_hash in the receipt. A mismatch means the file has been modified since attestation.",
                  },
                ].map((item) => (
                  <div key={item.step} className="flex items-start gap-3">
                    <div className="w-7 h-7 rounded-full bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0 text-xs font-bold text-primary">
                      {item.step}
                    </div>
                    <div>
                      <h4 className="font-semibold text-sm mb-1">{item.title}</h4>
                      <p className="text-sm text-muted-foreground leading-relaxed">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
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
                    code="https://forgeproof.flyingcloudtech.com/api/openapi.json"
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

        <div className="mt-16 mb-12 text-center" data-testid="section-multi-model-attestation">
          <Badge variant="outline" className="mb-4">
            <Shield className="w-3 h-3 mr-1" />
            Multi-Model
          </Badge>
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight mb-3" data-testid="heading-multi-model">
            Multi-Model Attestation
          </h2>
          <p className="text-base text-muted-foreground max-w-2xl mx-auto">
            ForgeProof supports multi-model attestation chains where the model that writes code is separate from the model that audits it for security. This enforces separation of concerns in AI-generated code.
          </p>
        </div>

        <div className="space-y-8">
          <Card className="p-6 sm:p-8" data-testid="card-workflow-diagram">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                <Layers className="w-5 h-5 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="font-display text-lg font-semibold mb-2" data-testid="heading-workflow">Attestation Workflow</h3>
                <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                  A typical multi-model attestation chain follows these steps, ensuring that code generation and security review are performed by independent models from different providers.
                </p>
                <CodeBlock code={multiModelWorkflow} label="workflow" />
              </div>
            </div>
          </Card>

          <Card className="p-6 sm:p-8" data-testid="card-multi-model-examples">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                <Code2 className="w-5 h-5 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="font-display text-lg font-semibold mb-2" data-testid="heading-multi-model-code">Code Examples</h3>
                <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                  Create an origin attestation first, then submit a security audit attestation referencing the original via <code className="text-xs bg-muted px-1.5 py-0.5 rounded">parent_attestation_id</code>.
                </p>
                <div className="mb-4">
                  <div className="flex items-center gap-1 border-b border-border mb-4">
                    {tabs.map((tab) => (
                      <button
                        key={tab.id}
                        onClick={() => setMultiModelTab(tab.id)}
                        className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                          multiModelTab === tab.id
                            ? "border-primary text-foreground"
                            : "border-transparent text-muted-foreground hover:text-foreground"
                        }`}
                        data-testid={`tab-multi-model-${tab.id}`}
                      >
                        <tab.icon className="w-4 h-4" />
                        {tab.label}
                      </button>
                    ))}
                  </div>
                  <CodeBlock
                    code={multiModelCodeMap[multiModelTab].code}
                    label={multiModelCodeMap[multiModelTab].label}
                  />
                </div>
              </div>
            </div>
          </Card>

          <Card className="p-6 sm:p-8" data-testid="card-attestation-types">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                <Shield className="w-5 h-5 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="font-display text-lg font-semibold mb-2" data-testid="heading-attestation-types">Attestation Types</h3>
                <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                  Every attestation must specify a type that describes its role in the chain.
                </p>
                <div className="space-y-3">
                  <div className="flex items-start gap-3 text-sm">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded shrink-0 mt-0.5">origin</code>
                    <span className="text-muted-foreground">Initial code generation attestation</span>
                  </div>
                  <div className="flex items-start gap-3 text-sm">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded shrink-0 mt-0.5">security_audit</code>
                    <span className="text-muted-foreground">Security review by a different model (requires different provider)</span>
                  </div>
                  <div className="flex items-start gap-3 text-sm">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded shrink-0 mt-0.5">refactor</code>
                    <span className="text-muted-foreground">Code refactoring attestation</span>
                  </div>
                  <div className="flex items-start gap-3 text-sm">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded shrink-0 mt-0.5">review</code>
                    <span className="text-muted-foreground">General code review attestation</span>
                  </div>
                </div>
              </div>
            </div>
          </Card>

          <Card className="p-6 sm:p-8" data-testid="card-audit-verdicts">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                <CheckCircle2 className="w-5 h-5 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="font-display text-lg font-semibold mb-2" data-testid="heading-audit-verdicts">Audit Verdicts</h3>
                <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                  When creating a <code className="text-xs bg-muted px-1.5 py-0.5 rounded">security_audit</code> attestation, include an <code className="text-xs bg-muted px-1.5 py-0.5 rounded">audit_verdict</code> field with one of the following values.
                </p>
                <div className="space-y-3">
                  <div className="flex items-start gap-3 text-sm">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded shrink-0 mt-0.5">secure</code>
                    <span className="text-muted-foreground">Code passed security audit</span>
                  </div>
                  <div className="flex items-start gap-3 text-sm">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded shrink-0 mt-0.5">flagged</code>
                    <span className="text-muted-foreground">Security issues found</span>
                  </div>
                  <div className="flex items-start gap-3 text-sm">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded shrink-0 mt-0.5">remediated</code>
                    <span className="text-muted-foreground">Issues were found and fixed</span>
                  </div>
                  <div className="flex items-start gap-3 text-sm">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded shrink-0 mt-0.5">needs_review</code>
                    <span className="text-muted-foreground">Requires further human review</span>
                  </div>
                </div>
              </div>
            </div>
          </Card>

          <Card className="p-6 sm:p-8" data-testid="card-mcp-audit-tool">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                <Bot className="w-5 h-5 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="font-display text-lg font-semibold mb-2" data-testid="heading-mcp-audit-tool">MCP Audit Tool</h3>
                <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                  AI agents using the MCP integration can submit audit attestations directly via the <code className="text-xs bg-muted px-1.5 py-0.5 rounded">forgeproof_audit_attest</code> tool.
                </p>
                <CodeBlock code={mcpAuditToolCode} label="mcp-tool" />
              </div>
            </div>
          </Card>
        </div>

        <div className="mt-20 mb-12" id="agents-md" data-testid="section-agents-md">
          <Badge variant="outline" className="mb-4">
            <Bot className="w-3 h-3 mr-1" />
            Agent Integration
          </Badge>
          <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight mb-3" data-testid="heading-agents-md">
            AGENTS.md — Agent-Ready by Default
          </h2>
          <p className="text-base text-muted-foreground max-w-2xl mb-2">
            ForgeProof ships an <code className="text-xs bg-muted px-1.5 py-0.5 rounded">AGENTS.md</code> file in the repository root. This is an emerging convention that tells AI coding agents — Claude, Cursor, Copilot, GPT, Gemini, and others — how to record their code-generation activity in ForgeProof automatically, without any manual setup.
          </p>
          <a
            href="https://github.com/bxrist/ForgeProof/blob/main/AGENTS.md"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline mb-8"
            data-testid="link-agents-md-github"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            View AGENTS.md on GitHub
          </a>

          <div className="space-y-6 mt-6">
            <Card className="p-6 sm:p-8" data-testid="card-agents-attest">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                  <Terminal className="w-5 h-5 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-display text-lg font-semibold mb-2">Attest a File — Quick Start</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                    After generating or modifying a file, compute its SHA-256 hash and call <code className="text-xs bg-muted px-1.5 py-0.5 rounded">POST /api/v1/attest</code> with your model identity and API key. Examples in curl, Python, and TypeScript:
                  </p>
                  <div className="space-y-4">
                    <CodeBlock code={agentsCurlCode} label="terminal" />
                    <CodeBlock code={agentsPythonCode} label="attest_file.py" />
                    <CodeBlock code={agentsTypescriptCode} label="attestFile.ts" />
                  </div>
                </div>
              </div>
            </Card>

            <Card className="p-6 sm:p-8" data-testid="card-agents-mcp">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                  <Bot className="w-5 h-5 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-display text-lg font-semibold mb-2">MCP Tool Server</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-3">
                    If your agent runtime supports MCP, add the ForgeProof manifest URL and attestation tools appear automatically — no manual API calls needed.
                  </p>
                  <div className="mb-4 p-3 rounded-md bg-muted/50 text-sm font-mono break-all">
                    https://forgeproof.flyingcloudtech.com/api/mcp/manifest
                  </div>
                  <p className="text-sm text-muted-foreground mb-3">Example <code className="text-xs bg-muted px-1.5 py-0.5 rounded">forgeproof_attest</code> tool call:</p>
                  <CodeBlock code={agentsMcpCode} label="mcp-tool-call.json" />
                  <div className="mt-4 space-y-1.5">
                    {[
                      ["forgeproof_attest", "Attest a single file with Ed25519 signing"],
                      ["forgeproof_batch_attest", "Attest multiple files in one call"],
                      ["forgeproof_audit_attest", "Security audit by a different provider"],
                      ["forgeproof_lookup", "Look up a receipt by ID or hash"],
                      ["forgeproof_verify_chain", "Verify the entire hash chain"],
                    ].map(([tool, desc]) => (
                      <div key={tool} className="flex items-start gap-2.5 text-sm">
                        <code className="text-xs bg-muted px-1.5 py-0.5 rounded shrink-0 mt-0.5">{tool}</code>
                        <span className="text-muted-foreground">{desc}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Card>

            <Card className="p-6 sm:p-8" data-testid="card-agents-ci">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                  <Shield className="w-5 h-5 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-display text-lg font-semibold mb-2">GitHub Actions CI Step</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                    Add a workflow step that attests every changed file on each push. Store your API key as the repository secret <code className="text-xs bg-muted px-1.5 py-0.5 rounded">FORGEPROOF_API_KEY</code> and set <code className="text-xs bg-muted px-1.5 py-0.5 rounded">AI_MODEL_NAME</code> / <code className="text-xs bg-muted px-1.5 py-0.5 rounded">AI_MODEL_PROVIDER</code> as repository variables.
                  </p>
                  <CodeBlock code={agentsGitHubActionsCode} label="forgeproof.yml" />
                </div>
              </div>
            </Card>

            <Card className="p-6 sm:p-8" data-testid="card-agents-precommit">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                  <Layers className="w-5 h-5 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-display text-lg font-semibold mb-2">Pre-commit Hook</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                    Install a git pre-commit hook to attest staged files locally before every commit. Set <code className="text-xs bg-muted px-1.5 py-0.5 rounded">FORGEPROOF_API_KEY</code>, <code className="text-xs bg-muted px-1.5 py-0.5 rounded">FORGEPROOF_MODEL_NAME</code>, and <code className="text-xs bg-muted px-1.5 py-0.5 rounded">FORGEPROOF_MODEL_PROVIDER</code> in your shell environment.
                  </p>
                  <CodeBlock code={agentsPreCommitCode} label=".git/hooks/pre-commit" />
                </div>
              </div>
            </Card>

            <Card className="p-6 sm:p-8" data-testid="card-agents-receipt">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                  <Layers className="w-5 h-5 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-display text-lg font-semibold mb-2">Receipt Format & Hash Chain</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                    Every attestation returns a signed JSON receipt. Key fields agents should record and surface to reviewers:
                  </p>
                  <div className="space-y-2">
                    {[
                      { field: "id", desc: "Numeric receipt identifier — include this in your response" },
                      { field: "file_hash", desc: "sha256: prefixed hash of the file at attestation time" },
                      { field: "entry_hash", desc: "SHA-256 fingerprint of this receipt — unique, tamper-evident" },
                      { field: "prev_entry_hash", desc: "Links this receipt to the previous one in the hash chain" },
                      { field: "signature", desc: "ed25519: prefixed cryptographic signature over the receipt" },
                    ].map(({ field, desc }) => (
                      <div key={field} className="flex items-start gap-2.5 text-sm">
                        <code className="text-xs bg-muted px-1.5 py-0.5 rounded shrink-0 mt-0.5">{field}</code>
                        <span className="text-muted-foreground">{desc}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-sm text-muted-foreground mt-4">
                    Full schema reference:{" "}
                    <a href="/sdk#receipt-format" className="text-primary hover:underline">
                      SDK Docs → Receipt Format
                    </a>
                    . Verify any receipt at{" "}
                    <a href="/lookup" className="text-primary hover:underline">/lookup</a>
                    {" "}or verify chain integrity at{" "}
                    <a href="/verify" className="text-primary hover:underline">/verify</a>.
                  </p>
                </div>
              </div>
            </Card>

            <Card className="p-6 sm:p-8" data-testid="card-agents-guidance">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center shrink-0">
                  <Bot className="w-5 h-5 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-display text-lg font-semibold mb-3">Guidance for AI Agents</h3>
                  <div className="space-y-2.5">
                    {[
                      "Attest every file you create or modify using your model name and provider.",
                      "Use attestation_type: \"origin\" for new files. Use \"refactor\" for rewrites of existing code.",
                      "Prefer batch attestation (forgeproof_batch_attest via MCP) when modifying multiple files.",
                      "Do not attest files you did not generate or modify in the current session.",
                      "Include the receipt ID in your response so the human reviewer can verify.",
                    ].map((rule, i) => (
                      <div key={i} className="flex items-start gap-2.5 text-sm">
                        <CheckCircle2 className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                        <span className="text-muted-foreground">{rule}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
