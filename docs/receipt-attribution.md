# Receipt attribution

Original `model_name`, `model_provider` and `country_of_origin` are immutable
declarations. A receipt producer or CI tool is not automatically an AI author.
Source inventories without observed attribution display UNKNOWN, while their
original signed placeholder values remain visible.

Future authorized submissions can include this existing metadata structure:

```json
{
  "attribution": {
    "version": 1,
    "producer": "attestation-producing application",
    "ciTool": "execution/orchestration tool, if known",
    "observation": {
      "model": "model actually observed",
      "provider": "observed provider",
      "observedAt": "2026-11-10T00:00:00Z",
      "evidenceUri": "https://your-authorized-evidence-reference"
    }
  }
}
```

Populate observations only from actual evidence. They are displayed as reported
observations with evidence, not independently verified authorship. V1 receipt
signatures do not bind arbitrary metadata; protected Git state retains it, but
metadata must not be described as part of the v1 signed receipt payload.
No historical observation is inferred or filled in retrospectively.

Request-origin IP geography and declared country do not establish the model
provider's processing region. The latter remains UNKNOWN.
