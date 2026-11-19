# Provider-supported processing geography (no precise geolocation)

ForgeProof can retain a **reported provider-documented country or regional processing guarantee** as part of the existing signed lifecycle evidence for a source-write. It does not infer where a model ran from the developer's IP address, client request IP, runner country, or a random regional hostname.

## Submission

Use the existing authenticated project-service `POST /api/project-services/:id/attest` with the normal signed receipt fields. Optionally include `lifecycle.providerResidencyGuarantee` in a **source-write** event with `lifecycle.model` present:

```json
{
  "model_name": "eligible-model-name",
  "model_provider": "OpenAI",
  "country_of_origin": "UNSPECIFIED",
  "lifecycle": {
    "project": "owner/repository",
    "stage": "source-write",
    "parents": [],
    "observedAt": "2026-11-18T20:00:00Z",
    "model": { "name": "eligible-model-name", "provider": "OpenAI" },
    "providerResidencyGuarantee": {
      "servingPlatform": "openai-api",
      "geographyType": "country",
      "geography": "US",
      "routingProfile": "us.api.openai.com",
      "providerPolicyUrl": "https://developers.openai.com/api/docs/guides/data-residency",
      "configurationSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "invocationSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "invokedAt": "2026-11-18T20:00:00Z"
    }
  }
}
```

This is an **illustrative partial body**, not an actual signed request; normal `file_path`, `file_hash`, `signedAt`, and idempotency headers also remain required. Never reuse the sample configuration hash or claim a policy applies without original request/configuration evidence.

* `servingPlatform`: `openai-api`, `aws-bedrock`, or `google-vertex-ai` (AWS Bedrock may serve third-party models). The policy URL must use that platform's official documentation domain.
* `geographyType` and `geography`: only the provider's supported country or regional guarantee. Regional area (e.g., EU) is **not** an exact data-center region.
* `routingProfile`: the actually used regional hostname, inference profile or equivalent identifier. Global routing is not accepted as a regional guarantee.
* `configurationSha256`: SHA-256 of the **non-secret** captured provider configuration covering that invocation; the protected original evidence must be retained for audit.
* `invocationSha256` and `invokedAt`: SHA-256 of the original provider invocation/request ID and actual timestamp. Retain the original reference privately; never insert tokens or personal identifiers into the public signed envelope.
* `providerPolicyUrl`: relevant, current official provider commitment **for this model/endpoint and customer eligibility**. A generic document alone does not prove coverage.

The lifecycle envelope signs this claim with the existing ForgeProof Ed25519 signer; receipt project and parent-graph constraints are unchanged. The receipt-details page displays it **only after verified lifecycle readback**, labeled a **reported provider-backed guarantee**, not independently verified physical location. If any required provenance is missing, omit the entire field; the physical processing location remains `UNKNOWN`.

No automatic provider geolocation or per-request provider signature verification is implied. Neither `country_of_origin` nor verified processing-region status is overwritten. Existing receipts and unrelated projects remain unchanged.
