/** Non-settling billing primitives. This module never contacts a payment provider. */
export type BillingMode = "legacy" | "per_attestation_test";
export type UsageEntitlement = "legacy_free" | "delegated_entitlement" | "prepaid_credit" | "agent_mpp";
export type UsageChannel = "http" | "mcp";

export interface BillingConfig {
  mode: BillingMode;
  unitPriceCents: number | null;
}

export interface UsageQuote {
  units: number;
  unitPriceCents: number;
  totalCents: number;
  currency: "USD";
}

export function parseBillingConfig(env: NodeJS.ProcessEnv): BillingConfig {
  const mode = env.FORGEPROOF_BILLING_MODE ?? "legacy";
  if (mode !== "legacy" && mode !== "per_attestation_test") {
    throw new Error("FORGEPROOF_BILLING_MODE must be legacy or per_attestation_test");
  }
  if (mode === "legacy") return { mode, unitPriceCents: null };
  const raw = env.FORGEPROOF_ATTESTATION_PRICE_CENTS;
  if (!raw || !/^\d+$/.test(raw)) throw new Error("Per-attestation test mode requires FORGEPROOF_ATTESTATION_PRICE_CENTS as a positive integer USD-cent amount");
  const cents = Number(raw);
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error("Attestation price must be a positive safe integer number of USD cents");
  return { mode, unitPriceCents: cents };
}

export function quoteUsage(config: BillingConfig, units: number): UsageQuote {
  if (config.mode !== "per_attestation_test" || config.unitPriceCents === null) throw new Error("Per-attestation price is not configured");
  if (!Number.isSafeInteger(units) || units <= 0) throw new Error("Usage units must be a positive integer");
  const totalCents = config.unitPriceCents * units;
  if (!Number.isSafeInteger(totalCents)) throw new Error("Usage quote exceeds safe integer range");
  return { units, unitPriceCents: config.unitPriceCents, totalCents, currency: "USD" };
}

/** Current deployments preserve existing plan behavior. Test mode is intentionally issuance-disabled. */
export function assertIssuanceMode(config: BillingConfig, channel: UsageChannel): void {
  if (config.mode === "per_attestation_test") {
    throw new Error(`Per-attestation test mode is quote-only; ${channel.toUpperCase()} issuance is disabled until funded entitlement settlement is implemented`);
  }
}

/** Gate a receipt writer before it can begin database work. Injectable for boundary tests. */
export async function withIssuanceMode<T>(
  env: NodeJS.ProcessEnv,
  channel: UsageChannel,
  issue: () => Promise<T>,
): Promise<T> {
  assertIssuanceMode(parseBillingConfig(env), channel);
  return issue();
}
