# ForgeProof — AGENTS.md

> **What is this file?** `AGENTS.md` is a convention that tells AI coding agents — Claude, Cursor, GitHub Copilot, GPT, Gemini, and others — how to interact with this project. If you are an AI agent generating code in this repository, read this file and follow the instructions below to record your work.

---

## What is ForgeProof?

ForgeProof is a cryptographic code-provenance platform by [Flying Cloud Technology](https://www.flyingcloudtech.com). Every time an AI model generates or modifies a file in this repository, it should create a **signed attestation receipt** via the ForgeProof API. Receipts are Ed25519-signed, SHA-256 hash-chained, and permanently linked to the file content, the AI model identity, and the jurisdiction where the model operates. The result is a tamper-evident ledger — an auditable record of which AI wrote which code, when, and where. See the full schema at [forgeproof.flyingcloudtech.com/sdk](https://forgeproof.flyingcloudtech.com/sdk).

---

## Prerequisites

1. **Get an API key** — Sign in at [forgeproof.flyingcloudtech.com](https://forgeproof.flyingcloudtech.com), go to **Dashboard → API Keys**, and generate a key. Keys look like `fp_sk_...`.
2. **Store the key securely** — Add it as a repository secret (`FORGEPROOF_API_KEY`) for CI/CD, or pass it via environment variable for local use. Never commit it to source control.

---

## Attest a File — Quick Start

### 1. Hash the file

All attestations require a `sha256:` prefixed hash of the file content.

**Shell (Linux/macOS):**
```bash
FILE_HASH="sha256:$(sha256sum src/utils/auth.ts | awk '{print $1}')"
# macOS: sha256:$(shasum -a 256 src/utils/auth.ts | awk '{print $1}')
```

**Python:**
```python
import hashlib

def file_hash(path: str) -> str:
    content = open(path, "rb").read()
    return "sha256:" + hashlib.sha256(content).hexdigest()
```

**TypeScript/Node.js:**
```typescript
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function fileHash(path: string): string {
  return "sha256:" + createHash("sha256").update(readFileSync(path)).digest("hex");
}
```

---

## Create an Attestation Receipt

### curl
```bash
curl -X POST https://forgeproof.flyingcloudtech.com/api/v1/attest \
  -H "Authorization: Bearer $FORGEPROOF_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "file_path": "src/utils/auth.ts",
    "file_hash": "sha256:a3f2e8c1d9b4a7e6f5c3d2b1a0e9f8d7c6b5a4e3d2c1b0",
    "model_name": "gpt-4o",
    "model_provider": "OpenAI",
    "country_of_origin": "US",
    "attestation_type": "origin"
  }'
```

### Python
```python
import hashlib
import requests

def attest_file(
    file_path: str,
    file_content: bytes,
    model_name: str,
    model_provider: str,
    api_key: str,
    country: str = "US",
    attestation_type: str = "origin",
):
    file_hash = "sha256:" + hashlib.sha256(file_content).hexdigest()
    response = requests.post(
        "https://forgeproof.flyingcloudtech.com/api/v1/attest",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "file_path": file_path,
            "file_hash": file_hash,
            "model_name": model_name,
            "model_provider": model_provider,
            "country_of_origin": country,
            "attestation_type": attestation_type,
        },
    )
    response.raise_for_status()
    return response.json()

# Example usage
receipt = attest_file(
    file_path="src/utils/auth.ts",
    file_content=open("src/utils/auth.ts", "rb").read(),
    model_name="claude-sonnet-4-5",
    model_provider="Anthropic",
    api_key="fp_sk_your_key_here",
)
print(receipt["id"], receipt["entry_hash"])
```

### TypeScript
```typescript
import { createHash } from "node:crypto";

async function attestFile(
  filePath: string,
  fileContent: Buffer | string,
  modelName: string,
  modelProvider: string,
  apiKey: string,
  country = "US",
  attestationType = "origin",
) {
  const fileHash =
    "sha256:" +
    createHash("sha256")
      .update(fileContent)
      .digest("hex");

  const res = await fetch("https://forgeproof.flyingcloudtech.com/api/v1/attest", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      file_path: filePath,
      file_hash: fileHash,
      model_name: modelName,
      model_provider: modelProvider,
      country_of_origin: country,
      attestation_type: attestationType,
    }),
  });

  if (!res.ok) throw new Error(`ForgeProof error: ${res.status} ${await res.text()}`);
  return res.json();
}
```

---

## MCP Tool Server

ForgeProof exposes a **Model Context Protocol (MCP)** tool server. If your agent runtime supports MCP, you can configure it to call ForgeProof tools directly — no manual API calls needed.

**MCP manifest URL:**
```
https://forgeproof.flyingcloudtech.com/api/mcp/manifest
```

**Available MCP tools:**

| Tool | Description |
|------|-------------|
| `forgeproof_attest` | Create a signed attestation receipt for a single file |
| `forgeproof_batch_attest` | Attest multiple files in one call |
| `forgeproof_audit_attest` | Create a security audit attestation (different provider required) |
| `forgeproof_lookup` | Look up and verify a receipt by ID or hash |
| `forgeproof_verify_chain` | Verify the entire hash chain integrity |

**Example MCP tool call (`forgeproof_attest`):**
```json
{
  "tool": "forgeproof_attest",
  "input": {
    "file_path": "src/utils/auth.ts",
    "file_hash": "sha256:a3f2e8c1...",
    "model_name": "claude-sonnet-4-5",
    "model_provider": "Anthropic",
    "country_of_origin": "US",
    "attestation_type": "origin"
  }
}
```

**Claude Desktop / Cursor / other MCP clients** — add the manifest URL to your MCP server configuration and ForgeProof tools will appear automatically.

---

## CI/CD Integration — GitHub Actions

Add a step to your workflow that attests every file changed in a pull request or push:

```yaml
# .github/workflows/forgeproof.yml
name: ForgeProof Attestation

on:
  push:
    branches: [main]
  pull_request:

jobs:
  attest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Attest changed files
        env:
          FORGEPROOF_API_KEY: ${{ secrets.FORGEPROOF_API_KEY }}
          MODEL_NAME: ${{ vars.AI_MODEL_NAME || 'gpt-4o' }}
          MODEL_PROVIDER: ${{ vars.AI_MODEL_PROVIDER || 'OpenAI' }}
        run: |
          # Get list of files changed in this push
          git diff --name-only HEAD~1 HEAD > changed_files.txt

          while IFS= read -r file; do
            [ -f "$file" ] || continue
            FILE_HASH="sha256:$(sha256sum "$file" | awk '{print $1}')"
            curl -sf -X POST https://forgeproof.flyingcloudtech.com/api/v1/attest \
              -H "Authorization: Bearer $FORGEPROOF_API_KEY" \
              -H "Content-Type: application/json" \
              -d "{
                \"file_path\": \"$file\",
                \"file_hash\": \"$FILE_HASH\",
                \"model_name\": \"$MODEL_NAME\",
                \"model_provider\": \"$MODEL_PROVIDER\",
                \"country_of_origin\": \"US\",
                \"attestation_type\": \"origin\"
              }"
          done < changed_files.txt
```

For a pre-commit hook, see the [pre-commit hook example](#pre-commit-hook) below.

---

## Pre-commit Hook

Install a git pre-commit hook to attest staged files before every commit:

```bash
#!/bin/sh
# .git/hooks/pre-commit
# Make executable: chmod +x .git/hooks/pre-commit

set -e

API_KEY="${FORGEPROOF_API_KEY}"
if [ -z "$API_KEY" ]; then
  echo "FORGEPROOF_API_KEY not set — skipping attestation" >&2
  exit 0
fi

MODEL_NAME="${FORGEPROOF_MODEL_NAME:-gpt-4o}"
MODEL_PROVIDER="${FORGEPROOF_MODEL_PROVIDER:-OpenAI}"

git diff --cached --name-only --diff-filter=ACM | while IFS= read -r file; do
  [ -f "$file" ] || continue
  FILE_HASH="sha256:$(sha256sum "$file" | awk '{print $1}')"
  curl -sf -X POST https://forgeproof.flyingcloudtech.com/api/v1/attest \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{
      \"file_path\": \"$file\",
      \"file_hash\": \"$FILE_HASH\",
      \"model_name\": \"$MODEL_NAME\",
      \"model_provider\": \"$MODEL_PROVIDER\",
      \"country_of_origin\": \"US\",
      \"attestation_type\": \"origin\"
    }" || echo "ForgeProof: attestation failed for $file (non-fatal)" >&2
done
```

---

## Receipt Format

A successful attestation returns a JSON receipt. Key fields:

| Field | Description |
|-------|-------------|
| `id` | Receipt identifier (integer) |
| `receipt_version` | Always `"v1"` |
| `file_path` | Repository-relative path |
| `file_hash` | `sha256:` prefixed hash of file content |
| `model_name` | AI model identifier (e.g. `"gpt-4o"`) |
| `model_provider` | Provider (e.g. `"OpenAI"`, `"Anthropic"`) |
| `country_of_origin` | ISO 3166-1 alpha-2 country code |
| `attestation_type` | `"origin"`, `"security_audit"`, `"refactor"`, or `"review"` |
| `timestamp` | UTC ISO 8601 timestamp |
| `signature` | Ed25519 signature, `ed25519:` prefixed |
| `entry_hash` | SHA-256 of this receipt (unique receipt fingerprint) |
| `prev_entry_hash` | Links this receipt to the previous in the hash chain |

Full schema reference: [forgeproof.flyingcloudtech.com/sdk#receipt-format](https://forgeproof.flyingcloudtech.com/sdk#receipt-format)

---

## Guidance for AI Agents

If you are an AI agent editing files in this repository:

1. **Attest every file you create or modify.** Use your model name and provider (e.g. `"claude-sonnet-4-5"` / `"Anthropic"`).
2. **Use `attestation_type: "origin"`** for new files and initial generation. Use `"refactor"` for rewrites of existing code.
3. **Prefer batch attestation** (`forgeproof_batch_attest` via MCP, or multiple API calls) when modifying multiple files in a single session.
4. **Do not attest files you did not generate or modify** in the current session.
5. **Include the receipt ID in your response** so the human reviewer can verify: _"Attested as ForgeProof receipt #42."_

---

## Links

- **ForgeProof app:** https://forgeproof.flyingcloudtech.com
- **SDK & API docs:** https://forgeproof.flyingcloudtech.com/sdk
- **Public receipt lookup:** https://forgeproof.flyingcloudtech.com/lookup
- **Hash chain verifier:** https://forgeproof.flyingcloudtech.com/verify
- **GitHub repo:** https://github.com/bxrist/ForgeProof
- **MCP manifest:** https://forgeproof.flyingcloudtech.com/api/mcp/manifest
- **OpenAPI spec (GPT Actions):** https://forgeproof.flyingcloudtech.com/api/openapi.json
- **Apache 2.0 License:** https://github.com/bxrist/ForgeProof/blob/main/LICENSE
