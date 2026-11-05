import test from "node:test";
import assert from "node:assert/strict";
import { parseBillingConfig, quoteUsage, assertIssuanceMode, withIssuanceMode } from "../server/billing/attestation-meter.ts";

test("legacy mode is default and has no invented price", () => {
  const config = parseBillingConfig({});
  assert.deepEqual(config, { mode: "legacy", unitPriceCents: null });
  assert.throws(() => quoteUsage(config, 1), /not configured/);
  assert.doesNotThrow(() => assertIssuanceMode(config, "http"));
});

test("test mode requires explicit positive integer cents and quotes explicit units", () => {
  assert.throws(() => parseBillingConfig({ FORGEPROOF_BILLING_MODE: "per_attestation_test" }), /requires/);
  assert.throws(() => parseBillingConfig({ FORGEPROOF_BILLING_MODE: "per_attestation_test", FORGEPROOF_ATTESTATION_PRICE_CENTS: "1.25" }), /positive integer/);
  const config = parseBillingConfig({ FORGEPROOF_BILLING_MODE: "per_attestation_test", FORGEPROOF_ATTESTATION_PRICE_CENTS: "17" });
  assert.deepEqual(quoteUsage(config, 3), { units: 3, unitPriceCents: 17, totalCents: 51, currency: "USD" });
  for (const units of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) assert.throws(() => quoteUsage(config, units));
});

test("quote-only mode fails closed for both issuance channels", () => {
  const config = parseBillingConfig({ FORGEPROOF_BILLING_MODE: "per_attestation_test", FORGEPROOF_ATTESTATION_PRICE_CENTS: "25" });
  assert.throws(() => assertIssuanceMode(config, "http"), /quote-only/);
  assert.throws(() => assertIssuanceMode(config, "mcp"), /quote-only/);
});

test("shared receipt writer boundary rejects before transaction work in quote-only mode", async () => {
  const env = { FORGEPROOF_BILLING_MODE: "per_attestation_test", FORGEPROOF_ATTESTATION_PRICE_CENTS: "25" };
  for (const channel of ["mcp", "http"]) {
    let transactionStarted = false;
    await assert.rejects(withIssuanceMode(env, channel, async () => {
      transactionStarted = true;
      return "receipt";
    }), /quote-only/);
    assert.equal(transactionStarted, false, `${channel} must be rejected before transaction work`);
  }
});

test("shared receipt writer boundary preserves issuance result in legacy mode", async () => {
  let transactionStarted = false;
  const result = await withIssuanceMode({}, "http", async () => {
    transactionStarted = true;
    return { id: 42, entry_hash: "unchanged" };
  });
  assert.equal(transactionStarted, true);
  assert.deepEqual(result, { id: 42, entry_hash: "unchanged" });
});

test("client data cannot control unit price or quantity in issuance inputs", async () => {
  const { readFileSync } = await import("node:fs");
  const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  assert.match(routes, /'http',\$4,1,NULL,'USD','unsettled'/);
  assert.match(routes, /ON CONFLICT \(receipt_id\) DO NOTHING/);
});
