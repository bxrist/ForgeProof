import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { pool } from "./legacySqlPool";
import { getStripeSync, getStripeCredentials, getUncachableStripeClient } from "./stripeClient";
import { hasApplicationStorage } from "./storageBackend";
import {
  EXPECTED_STRIPE_ACCOUNT_ID,
  EXPECTED_STRIPE_CATALOG,
  STRIPE_LIVE_MODE,
} from "./stripeConfig";

/**
 * These are deliberately pinned.  A reconciliation is allowed to repair the
 * database and webhook configuration, but it is never allowed to silently
 * select a different Stripe account or replace the billing catalog.
 */
export { EXPECTED_STRIPE_ACCOUNT_ID, EXPECTED_STRIPE_CATALOG } from "./stripeConfig";

const WEBHOOK_PATH = "/api/stripe/webhook";
const RECONCILIATION_LOCK_ID = 8_741_923;
const KNOWN_PRODUCTION_URL = "https://forgeproof.replit.app";
const WEBHOOK_INTENT_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

// This fallback is only used when the library is not available to provide its
// supported event list.  It is intentionally narrow and contains every event
// consumed by this application.
const FALLBACK_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "product.created",
  "product.updated",
  "product.deleted",
  "price.created",
  "price.updated",
  "price.deleted",
];

export type ReadinessStatus = "ok" | "warning" | "error";

export type ReadinessCheck = {
  key: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
};

export type StripeAccountReadiness = {
  id: string;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
};

export type StripeReadinessReport = {
  billingMode?: "live" | "sandbox";
  expectedAccountId: string;
  account: StripeAccountReadiness | null;
  localReady: boolean;
  remoteStatus: "verified" | "unverified" | "missing" | "not_applicable";
  ready: boolean;
  checks: ReadinessCheck[];
  canReconcile: boolean;
};

export type ReconciliationOperation = {
  key: string;
  status: "ok" | "warning" | "error" | "blocked";
  detail: string;
};

export type StripeReconciliationReport = StripeReadinessReport & {
  success: boolean;
  reconciliation: {
    status: "ok" | "partial" | "blocked";
    localSuccess: boolean;
    remoteStatus: "verified" | "unverified" | "missing" | "not_applicable";
    operations: ReconciliationOperation[];
  };
};

type WebhookTarget = {
  environment: "production" | "development";
  url: string;
  origin: string;
};

type StripeEnvironment = WebhookTarget["environment"];

type UrlConfiguration = {
  targets: WebhookTarget[];
  currentEnvironment: StripeEnvironment;
  currentTarget: WebhookTarget | null;
  checks: ReadinessCheck[];
};

type DatabaseCatalog = {
  products: Array<Record<string, unknown>>;
  prices: Array<Record<string, unknown>>;
};

type ExpectedCatalogEntry =
  (typeof EXPECTED_STRIPE_CATALOG)[keyof typeof EXPECTED_STRIPE_CATALOG];

type ManagedWebhookRow = Record<string, unknown> & {
  id?: string;
  url?: string;
  secret?: string | null;
};

type WebhookIntent = {
  account_id: string;
  environment: StripeEnvironment;
  url: string;
  idempotency_key: string;
  request_params: Record<string, unknown>;
  status: string;
  stripe_endpoint_id?: string | null;
  secret_stored?: boolean;
  created_at: string | Date;
};

function ok(key: string, label: string, detail: string): ReadinessCheck {
  return { key, label, status: "ok", detail };
}

function warning(key: string, label: string, detail: string): ReadinessCheck {
  return { key, label, status: "warning", detail };
}

function errorCheck(key: string, label: string, detail: string): ReadinessCheck {
  return { key, label, status: "error", detail };
}

function genericProviderFailure(label: string): string {
  return `${label} could not be inspected; no changes were made.`;
}

function isHttpsUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function canonicalWebhookUrl(raw: string): { url: string; origin: string } | null {
  const parsed = isHttpsUrl(raw);
  if (!parsed || parsed.search || parsed.hash) return null;

  const pathname = parsed.pathname === "/" || parsed.pathname === ""
    ? WEBHOOK_PATH
    : parsed.pathname.replace(/\/+$/, "");
  const normalized = new URL(parsed.origin);
  normalized.pathname = pathname;
  return { url: normalized.toString(), origin: normalized.origin };
}

function fallbackReplitDomain(env: NodeJS.ProcessEnv = process.env): string | null {
  const firstDomain = env.REPLIT_DOMAINS
    ?.split(",")
    .map((value) => value.trim())
    .find(Boolean);
  if (!firstDomain || firstDomain.includes("/") || firstDomain.includes(" ")) return null;
  return `https://${firstDomain}`;
}

/**
 * Resolve both deployment URLs.  Production intentionally has no domain
 * fallback: an accidental Replit preview domain must never receive
 * production events.  The development fallback is limited to the trusted
 * REPLIT_DOMAINS value supplied by the platform.
 */
export function getConfiguredWebhookTargets(env: NodeJS.ProcessEnv = process.env): UrlConfiguration {
  const checks: ReadinessCheck[] = [];
  const targets: WebhookTarget[] = [];
  const currentEnvironment: StripeEnvironment = env.NODE_ENV === "production"
    ? "production"
    : "development";

  const productionRaw = env.FORGEPROOF_STRIPE_PRODUCTION_URL;
  if (!productionRaw) {
    checks.push(errorCheck(
      "production_webhook_url",
      "Production webhook URL",
      `Production webhook origin is not configured; set FORGEPROOF_STRIPE_PRODUCTION_URL (known deployment: ${KNOWN_PRODUCTION_URL}).`,
    ));
  } else {
    const production = canonicalWebhookUrl(productionRaw);
    if (!production) {
      checks.push(errorCheck(
        "production_webhook_url",
        "Production webhook URL",
        "Production webhook URL must be an HTTPS origin or HTTPS webhook URL.",
      ));
    } else {
      targets.push({ environment: "production", ...production });
      checks.push(ok("production_webhook_url", "Production webhook URL", "Configured HTTPS webhook origin."));
    }
  }

  const developmentRaw = env.FORGEPROOF_STRIPE_DEVELOPMENT_URL || fallbackReplitDomain(env);
  if (!developmentRaw) {
    checks.push(errorCheck(
      "development_webhook_url",
      "Development webhook URL",
      "Development webhook origin is not configured; set FORGEPROOF_STRIPE_DEVELOPMENT_URL or trusted REPLIT_DOMAINS.",
    ));
  } else {
    const development = canonicalWebhookUrl(developmentRaw);
    if (!development) {
      checks.push(errorCheck(
        "development_webhook_url",
        "Development webhook URL",
        "Development webhook URL must be an HTTPS origin or HTTPS webhook URL.",
      ));
    } else {
      targets.push({ environment: "development", ...development });
      checks.push(ok("development_webhook_url", "Development webhook URL", "Configured HTTPS webhook origin."));
    }
  }

  const production = targets.find((target) => target.environment === "production");
  const development = targets.find((target) => target.environment === "development");
  if (production && development && production.origin === development.origin) {
    checks.push(errorCheck(
      "webhook_url_distinct",
      "Distinct production and development webhook origins",
      "Production and development webhook origins must be different; no reconciliation target was selected.",
    ));
  }

  return {
    targets,
    currentEnvironment,
    currentTarget: targets.find((target) => target.environment === currentEnvironment) || null,
    checks,
  };
}

function accountForResponse(account: Stripe.Account): StripeAccountReadiness {
  return {
    id: account.id,
    detailsSubmitted: account.details_submitted === true,
    chargesEnabled: account.charges_enabled === true,
    payoutsEnabled: account.payouts_enabled === true,
  };
}

function accountSetupCheck(account: StripeAccountReadiness | null): ReadinessCheck {
  if (!account) {
    return errorCheck(
      "account_setup",
      "Stripe account setup",
      "Stripe account setup flags could not be inspected.",
    );
  }
  const enabled = account.detailsSubmitted && account.chargesEnabled && account.payoutsEnabled;
  const detail = `details_submitted=${account.detailsSubmitted}, charges_enabled=${account.chargesEnabled}, payouts_enabled=${account.payoutsEnabled}.`;
  // details_submitted is reported, but is not used as proof that payments or
  // payouts are enabled (or that the Dashboard preservation step was done).
  return enabled
    ? ok("account_setup", "Stripe account setup", detail)
    : warning("account_setup", "Stripe account setup", detail);
}

async function listAll<T extends { id?: string }>(
  list: (params: Record<string, unknown>) => Promise<{ data?: T[]; has_more?: boolean } | T[]>,
): Promise<T[]> {
  const all: T[] = [];
  let startingAfter: string | undefined;

  for (;;) {
    const params: Record<string, unknown> = { limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await list(params);
    if (Array.isArray(page)) {
      all.push(...page);
      break;
    }
    const data = page.data || [];
    all.push(...data);
    if (!page.has_more || data.length === 0) break;
    const next = data[data.length - 1]?.id;
    if (!next || next === startingAfter) break;
    startingAfter = next;
  }
  return all;
}

function productMatches(product: Record<string, unknown> | undefined, expected: ExpectedCatalogEntry): boolean {
  return !!product &&
    product.id === expected.productId &&
    product.name === expected.name &&
    product.active === true;
}

function priceMatches(
  price: Record<string, unknown> | undefined,
  expected: ExpectedCatalogEntry,
): boolean {
  if (!price || price.id !== expected.priceId || price.product !== expected.productId ||
      price.active !== true || price.unit_amount !== expected.amount ||
      String(price.currency).toLowerCase() !== expected.currency) {
    return false;
  }

  const recurring = price.recurring;
  const interval = recurring && typeof recurring === "object"
    ? (recurring as Record<string, unknown>).interval
    : undefined;
  return interval === expected.interval;
}

function databaseCatalogChecks(catalog: DatabaseCatalog): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  for (const [plan, expected] of Object.entries(EXPECTED_STRIPE_CATALOG)) {
    const product = catalog.products.find((item) => item.id === expected.productId);
    const price = catalog.prices.find((item) => item.id === expected.priceId);
    const productOk = productMatches(product, expected);
    const priceOk = priceMatches(price, expected);
    checks.push(
      productOk
        ? ok(`db_catalog_${plan}_product`, `${expected.name} database product`, `Exact pinned product ${expected.productId} is present.`)
        : warning(`db_catalog_${plan}_product`, `${expected.name} database product`, `Pinned product ${expected.productId} is missing or does not exactly match; targeted sync is required.`),
    );
    checks.push(
      priceOk
        ? ok(`db_catalog_${plan}_price`, `${expected.name} database price`, `Exact pinned monthly USD price ${expected.priceId} is present.`)
        : warning(`db_catalog_${plan}_price`, `${expected.name} database price`, `Pinned price ${expected.priceId} is missing or does not exactly match; targeted sync is required.`),
    );
  }
  return checks;
}

function providerCatalogChecks(
  products: Array<Record<string, unknown>>,
  prices: Array<Record<string, unknown>>,
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  for (const [plan, expected] of Object.entries(EXPECTED_STRIPE_CATALOG)) {
    const product = products.find((item) => item.id === expected.productId);
    const price = prices.find((item) => item.id === expected.priceId);
    const productOk = productMatches(product, expected);
    const priceOk = priceMatches(price, expected);
    checks.push(
      productOk
        ? ok(`stripe_catalog_${plan}_product`, `${expected.name} Stripe product`, `Exact pinned product ${expected.productId} is present.`)
        : errorCheck(`stripe_catalog_${plan}_product`, `${expected.name} Stripe product`, `Pinned product ${expected.productId} is missing or does not exactly match; no catalog mutation is permitted.`),
    );
    checks.push(
      priceOk
        ? ok(`stripe_catalog_${plan}_price`, `${expected.name} Stripe price`, `Exact pinned monthly USD price ${expected.priceId} is present.`)
        : errorCheck(`stripe_catalog_${plan}_price`, `${expected.name} Stripe price`, `Pinned price ${expected.priceId} is missing or does not exactly match; no catalog mutation is permitted.`),
    );
  }
  return checks;
}

function endpointIsCurrent(endpoint: Stripe.WebhookEndpoint, supportedEvents: string[]): boolean {
  if (endpoint.status !== "enabled") return false;
  const events = endpoint.enabled_events || [];
  if (events.includes("*" as never)) return true;
  // The sync library may add support for more event types over time.  Treat a
  // superset as current while still identifying an endpoint that is missing a
  // billing event required by this application.
  return supportedEvents.every((event) => events.includes(event));
}

function endpointSecretAvailable(endpoint: Stripe.WebhookEndpoint, managedRows: ManagedWebhookRow[]): boolean {
  const row = managedRows.find((candidate) => candidate.id === endpoint.id);
  return typeof row?.secret === "string" && row.secret.length > 0;
}

function webhookChecks(
  targets: WebhookTarget[],
  endpoints: Stripe.WebhookEndpoint[],
  managedRows: ManagedWebhookRow[],
  supportedEvents: string[],
  currentEnvironment: StripeEnvironment,
  recoverableIntentUrls: Set<string> = new Set(),
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  for (const target of targets) {
    const isCurrent = target.environment === currentEnvironment;
    if (STRIPE_LIVE_MODE && currentEnvironment === "production" && !isCurrent) {
      checks.push({
        key: "remote_webhook_development",
        label: "Development webhook isolation",
        status: "ok",
        detail: "Development uses a separate sandbox. No development webhook is required or changed in this live account.",
      });
      continue;
    }
    const matches = endpoints.filter((endpoint) => endpoint.url === target.url);
    if (matches.length === 0) {
      const staleRow = isCurrent ? managedRows.find((row) => row.url === target.url) : undefined;
      if (isCurrent && staleRow && typeof staleRow.secret !== "string" &&
          !recoverableIntentUrls.has(target.url)) {
        checks.push(errorCheck(
          `webhook_${target.environment}_secret`,
          `${target.environment} webhook signing secret`,
          "A prior endpoint record has no stored signing secret; Dashboard/manual recovery is required. It will not be rotated or recreated.",
        ));
      }
      checks.push(isCurrent
        ? warning(
          `webhook_${target.environment}`,
          `${target.environment} Stripe webhook`,
          staleRow
            ? `The prior endpoint record is not present in Stripe; reconciliation will not recreate it or rotate its secret.`
            : `No endpoint is registered for ${target.origin}; reconciliation can create it without deleting other endpoints.`,
        )
        : errorCheck(
          `remote_webhook_${target.environment}`,
          `${target.environment} remote Stripe webhook`,
          `No endpoint is registered for ${target.origin}; run reconciliation in that environment after an approved release.`,
        ));
      continue;
    }
    if (matches.length > 1) {
      checks.push(warning(
        `${isCurrent ? "webhook" : "remote_webhook"}_${target.environment}_duplicates`,
        `${target.environment} duplicate webhook URLs`,
        `Stripe has ${matches.length} endpoints with this URL; reconciliation will not delete any endpoint.`,
      ));
    }
    const endpoint = matches[0];
    if (!isCurrent) {
      checks.push(warning(
        `remote_webhook_${target.environment}_secret`,
        `${target.environment} remote webhook signing secret`,
        "Remote signing secret and delivery ownership are not available in this environment; run reconciliation there to verify them.",
      ));
      checks.push(endpointIsCurrent(endpoint, supportedEvents)
        ? warning(`remote_webhook_${target.environment}_state`, `${target.environment} remote webhook state`, "Endpoint is enabled, but remote delivery and signing secret remain unverified.")
        : warning(`remote_webhook_${target.environment}_state`, `${target.environment} remote webhook state`, "Endpoint is disabled or has stale events; repair it in that environment after an approved release."),
      );
      continue;
    }
    if (!endpointSecretAvailable(endpoint, managedRows) && recoverableIntentUrls.has(target.url)) {
      checks.push(warning(
        `webhook_${target.environment}_secret`,
        `${target.environment} webhook signing secret`,
        "A pending local persistence intent can replay the exact Stripe request within 24 hours to recover the stored signing secret.",
      ));
    } else if (!endpointSecretAvailable(endpoint, managedRows)) {
      checks.push(errorCheck(
        `webhook_${target.environment}_secret`,
        `${target.environment} webhook signing secret`,
        "An existing endpoint has no stored signing secret; Dashboard/manual recovery is required. It will not be rotated or recreated.",
      ));
    } else {
      checks.push(ok(
        `webhook_${target.environment}_secret`,
        `${target.environment} webhook signing secret`,
        "A stored signing secret is available without exposing it.",
      ));
    }
    checks.push(endpointIsCurrent(endpoint, supportedEvents)
      ? ok(`webhook_${target.environment}_state`, `${target.environment} webhook state`, "Endpoint is enabled with the current event set.")
      : warning(`webhook_${target.environment}_state`, `${target.environment} webhook state`, "Endpoint is disabled or has stale events; reconciliation will update it in place."),
    );
  }
  return checks;
}

function hasCheck(checks: ReadinessCheck[], key: string, status: ReadinessStatus): boolean {
  return checks.some((check) => check.key === key && check.status === status);
}

function hasError(checks: ReadinessCheck[]): boolean {
  return checks.some((check) => check.status === "error");
}

function checkAccountIdentity(account: StripeAccountReadiness | null): ReadinessCheck {
  if (!account) {
    return errorCheck("account_identity", "Stripe account identity", "Stripe account identity could not be verified.");
  }
  return account.id === EXPECTED_STRIPE_ACCOUNT_ID
    ? ok("account_identity", "Stripe account identity", `Stripe account ${EXPECTED_STRIPE_ACCOUNT_ID} is selected.`)
    : errorCheck("account_identity", "Stripe account identity", "Connected Stripe account does not match the pinned account; no changes were made.");
}

/**
 * Read-only Stripe and database inspection.  In particular, this function
 * never calls a Stripe create/update/delete operation and never invokes the
 * sync library's broad backfill methods.
 */
export async function getStripeReadiness(): Promise<StripeReadinessReport> {
  const urlConfiguration = getConfiguredWebhookTargets();
  const checks = [...urlConfiguration.checks];
  let account: StripeAccountReadiness | null = null;
  let stripe: Stripe | null = null;
  let endpoints: Stripe.WebhookEndpoint[] = [];
  let products: Array<Record<string, unknown>> = [];
  let prices: Array<Record<string, unknown>> = [];
  let managedRows: ManagedWebhookRow[] = [];
  const recoverableIntentUrls = new Set<string>();

  try {
    stripe = await getUncachableStripeClient({ skipAccountGuard: true });
    const stripeAccount = await (stripe.accounts.retrieve as any)();
    account = accountForResponse(stripeAccount);
    checks.push(checkAccountIdentity(account));
    checks.push(accountSetupCheck(account));
  } catch {
    checks.push(errorCheck("stripe_credentials", "Stripe credentials", "Stripe credentials or account inspection failed."));
    checks.push(checkAccountIdentity(account));
    checks.push(accountSetupCheck(account));
  }

  if (stripe) {
    checks.push(ok("stripe_credentials", "Stripe credentials", "Stripe credentials are available for read-only inspection."));
    try {
      products = await listAll((params) => stripe!.products.list(params as Stripe.ProductListParams)) as unknown as Array<Record<string, unknown>>;
      prices = await listAll((params) => stripe!.prices.list(params as Stripe.PriceListParams)) as unknown as Array<Record<string, unknown>>;
      checks.push(...providerCatalogChecks(products, prices));
    } catch {
      checks.push(errorCheck("stripe_catalog", "Stripe catalog inspection", genericProviderFailure("Stripe catalog")));
    }
    try {
      endpoints = await listAll((params) => stripe!.webhookEndpoints.list(params as Stripe.WebhookEndpointListParams));
    } catch {
      checks.push(errorCheck("stripe_webhooks", "Stripe webhook inspection", genericProviderFailure("Stripe webhook endpoints")));
    }
  }

  if (hasApplicationStorage()) {
    // Stripe is the catalog authority. A SQL mirror is neither consulted nor
    // required. Endpoint signing material remains in external secret custody.
    let boundSecret = false;
    try {
      const credentials = await getStripeCredentials();
      boundSecret = !!credentials.webhookSecret &&
        credentials.webhookSecretAccountId === EXPECTED_STRIPE_ACCOUNT_ID &&
        credentials.webhookSecretUrl === urlConfiguration.currentTarget?.url;
    } catch {}
    const target = urlConfiguration.currentTarget;
    const matching = endpoints.filter(endpoint => endpoint.url === target?.url);
    const endpointReady = matching.length === 1 &&
      endpointIsCurrent(matching[0], FALLBACK_WEBHOOK_EVENTS);
    checks.push(boundSecret
      ? ok("git_webhook_secret", "Webhook signing custody", "Signing secret is externally bound to this account and URL.")
      : errorCheck("git_webhook_secret", "Webhook signing custody", "The existing endpoint signing secret must be available outside the legacy SQL cache, bound to this account and URL."));
    checks.push(endpointReady
      ? ok("git_webhook_endpoint", "Webhook endpoint", "Current endpoint is enabled with the required events.")
      : errorCheck("git_webhook_endpoint", "Webhook endpoint", "Exactly one enabled current endpoint with the required events is required."));
    const ready = !!target && !hasError(checks);
    return {billingMode:STRIPE_LIVE_MODE ? "live" : "sandbox",
      expectedAccountId:EXPECTED_STRIPE_ACCOUNT_ID,account,checks,
      localReady:ready,ready,remoteStatus:"not_applicable",canReconcile:ready};
  }

  try {
    const result = await pool.query(
      `SELECT id, name, active
         FROM stripe.products
        WHERE "_account_id" = $1`,
      [EXPECTED_STRIPE_ACCOUNT_ID],
    );
    const priceResult = await pool.query(
      `SELECT id, product, active, unit_amount, currency, recurring
         FROM stripe.prices
        WHERE "_account_id" = $1`,
      [EXPECTED_STRIPE_ACCOUNT_ID],
    );
    checks.push(...databaseCatalogChecks({ products: result.rows, prices: priceResult.rows }));
  } catch {
    checks.push(errorCheck("db_catalog", "Database catalog", "The synchronized Stripe catalog could not be inspected."));
  }

  try {
    const managed = await pool.query(
      `SELECT id, url, secret, enabled, enabled_events, status
         FROM stripe."_managed_webhooks"
        WHERE account_id = $1`,
      [EXPECTED_STRIPE_ACCOUNT_ID],
    );
    managedRows = managed.rows;
  } catch {
    checks.push(errorCheck("managed_webhook_secrets", "Managed webhook secrets", "Managed webhook records could not be inspected."));
  }

  try {
    const intents = await pool.query(
      `SELECT environment, url, status, request_params, created_at
         FROM stripe."_forgeproof_webhook_intents"
        WHERE account_id = $1`,
      [EXPECTED_STRIPE_ACCOUNT_ID],
    );
    for (const intent of intents.rows as WebhookIntent[]) {
      if (intent.environment === urlConfiguration.currentEnvironment &&
          intent.status === "pending" &&
          intentWithinReplayWindow(intent)) {
        recoverableIntentUrls.add(intent.url);
      }
    }
  } catch {
    checks.push(errorCheck(
      "webhook_intents",
      "Webhook recovery intents",
      "Durable webhook recovery intents could not be inspected; no endpoint mutation is permitted.",
    ));
  }

  if (stripe && !hasCheck(checks, "stripe_webhooks", "error")) {
    checks.push(...webhookChecks(
      urlConfiguration.targets,
      endpoints,
      managedRows,
      FALLBACK_WEBHOOK_EVENTS,
      urlConfiguration.currentEnvironment,
      recoverableIntentUrls,
    ));
  }

  const identityOk = hasCheck(checks, "account_identity", "ok");
  const credentialOk = hasCheck(checks, "stripe_credentials", "ok");
  const providerCatalogOk = Object.keys(EXPECTED_STRIPE_CATALOG).every((plan) =>
    hasCheck(checks, `stripe_catalog_${plan}_product`, "ok") &&
    hasCheck(checks, `stripe_catalog_${plan}_price`, "ok"),
  );
  const urlsValid = urlConfiguration.targets.length === 2 &&
    !!urlConfiguration.currentTarget &&
    !urlConfiguration.checks.some((check) => check.status === "error");
  const endpointInspectionOk = !hasCheck(checks, "stripe_webhooks", "error");
  const managedSecretBlock = checks.some((check) =>
    check.key === `webhook_${urlConfiguration.currentEnvironment}_secret` &&
    check.status === "error",
  );
  const managedSecretInspectionOk = !hasCheck(checks, "managed_webhook_secrets", "error");
  const webhookIntentInspectionOk = !hasCheck(checks, "webhook_intents", "error");
  const provisionalReport: StripeReadinessReport = {
    expectedAccountId: EXPECTED_STRIPE_ACCOUNT_ID,
    account,
    localReady: false,
    remoteStatus: "unverified",
    ready: false,
    checks,
    canReconcile: false,
  };
  const localReady = checks.length > 0 && !currentEnvironmentDrift(provisionalReport);
  const remoteStatus = remoteVerificationStatus(provisionalReport);
  const ready = localReady && (remoteStatus === "verified" || remoteStatus === "not_applicable");
  const canReconcile = credentialOk && identityOk && providerCatalogOk &&
    urlsValid && endpointInspectionOk && managedSecretInspectionOk &&
    webhookIntentInspectionOk &&
    !managedSecretBlock;

  return {
    billingMode: STRIPE_LIVE_MODE ? "live" : "sandbox",
    expectedAccountId: EXPECTED_STRIPE_ACCOUNT_ID,
    account,
    localReady,
    remoteStatus,
    ready,
    checks,
    canReconcile,
  };
}

function operationError(key: string, detail: string): ReconciliationOperation {
  return { key, status: "error", detail };
}

function currentEnvironmentDrift(report: StripeReadinessReport): boolean {
  const configuration = getConfiguredWebhookTargets();
  const remoteEnvironment: StripeEnvironment = configuration.currentEnvironment === "production"
    ? "development"
    : "production";
  const remoteUrlKey = `${remoteEnvironment}_webhook_url`;
  return report.checks.some((check) => {
    if (check.key === "account_setup") return false;
    if (check.key === remoteUrlKey || check.key.startsWith(`remote_webhook_${remoteEnvironment}`)) {
      return false;
    }
    return check.status === "error" || check.status === "warning";
  });
}

function remoteVerificationStatus(report: StripeReadinessReport): StripeReadinessReport["remoteStatus"] {
  if (STRIPE_LIVE_MODE && getConfiguredWebhookTargets().currentEnvironment === "production") {
    return "not_applicable";
  }
  if (report.checks.some((check) => check.key === "stripe_webhooks" && check.status === "error")) {
    return "unverified";
  }
  const configuration = getConfiguredWebhookTargets();
  const remoteEnvironment: StripeEnvironment = configuration.currentEnvironment === "production"
    ? "development"
    : "production";
  const remoteUrlKey = `${remoteEnvironment}_webhook_url`;
  const remoteChecks = report.checks.filter((check) =>
    check.key === remoteUrlKey ||
    check.key.startsWith(`remote_webhook_${remoteEnvironment}`),
  );
  if (remoteChecks.some((check) => check.status === "error")) return "missing";
  if (remoteChecks.some((check) => check.status === "warning")) return "unverified";
  return "verified";
}

function providerIdempotencyKey(url: string): string {
  const digest = createHash("sha256")
    .update(`${EXPECTED_STRIPE_ACCOUNT_ID}:${url}`)
    .digest("hex")
    .slice(0, 32);
  return `forgeproof-webhook-${digest}`;
}

function eventSetIsCurrent(endpoint: Stripe.WebhookEndpoint, events: string[]): boolean {
  if (endpoint.status !== "enabled") return false;
  if (endpoint.enabled_events.includes("*" as never)) return true;
  return events.every((event) => endpoint.enabled_events.includes(event));
}

function webhookCreateParams(
  target: WebhookTarget,
  supportedEvents: string[],
): Stripe.WebhookEndpointCreateParams {
  return {
    url: target.url,
    enabled_events: supportedEvents as Stripe.WebhookEndpointCreateParams.EnabledEvent[],
    metadata: { managed_by: "forgeproof", product: "forgeproof" },
  };
}

function requestParamsMatch(
  intent: WebhookIntent,
  params: Stripe.WebhookEndpointCreateParams,
): boolean {
  return JSON.stringify(intent.request_params) === JSON.stringify(params);
}

function intentWithinReplayWindow(intent: WebhookIntent): boolean {
  const createdAt = new Date(intent.created_at).getTime();
  return Number.isFinite(createdAt) &&
    Date.now() - createdAt >= 0 &&
    Date.now() - createdAt <= WEBHOOK_INTENT_REPLAY_WINDOW_MS;
}

async function markWebhookIntent(
  target: WebhookTarget,
  status: "pending" | "completed",
  endpointId?: string,
): Promise<void> {
  await pool.query(
    `UPDATE stripe."_forgeproof_webhook_intents"
        SET status = $3,
            stripe_endpoint_id = COALESCE($4, stripe_endpoint_id),
            secret_stored = CASE WHEN $3 = 'completed' THEN true ELSE secret_stored END,
            updated_at = timezone('utc'::text, now())
      WHERE account_id = $1
        AND environment = $2`,
    [EXPECTED_STRIPE_ACCOUNT_ID, target.environment, status, endpointId || null],
  );
}

async function reconcileWebhooks(
  stripe: Stripe,
  sync: { getSupportedEventTypes?: () => Stripe.WebhookEndpointCreateParams.EnabledEvent[]; upsertManagedWebhooks?: (...args: any[]) => Promise<unknown> },
  targets: WebhookTarget[],
): Promise<ReconciliationOperation[]> {
  const operations: ReconciliationOperation[] = [];
  if (typeof sync.upsertManagedWebhooks !== "function") {
    return targets.map((target) => ({
      key: `webhook_${target.environment}`,
      status: "blocked" as const,
      detail: "Webhook persistence is unavailable; no endpoint mutation was attempted.",
    }));
  }

  const supportedEvents = (sync.getSupportedEventTypes?.() || FALLBACK_WEBHOOK_EVENTS) as string[];
  const createParamsByEnvironment = new Map(
    targets.map((target) => [target.environment, webhookCreateParams(target, supportedEvents)]),
  );
  let intents: WebhookIntent[];
  try {
    const intentResult = await pool.query(
      `SELECT account_id, environment, url, idempotency_key, request_params,
              status, stripe_endpoint_id, secret_stored, created_at
         FROM stripe."_forgeproof_webhook_intents"
        WHERE account_id = $1`,
      [EXPECTED_STRIPE_ACCOUNT_ID],
    );
    intents = intentResult.rows as WebhookIntent[];
  } catch {
    return targets.map((target) => ({
      key: `webhook_${target.environment}`,
      status: "blocked" as const,
      detail: "Webhook intent persistence is unavailable; no endpoint mutation was attempted.",
    }));
  }

  const endpoints = await listAll((params) => stripe.webhookEndpoints.list(params as Stripe.WebhookEndpointListParams));
  const managedResult = await pool.query(
    `SELECT id, url, secret
       FROM stripe."_managed_webhooks"
      WHERE account_id = $1`,
    [EXPECTED_STRIPE_ACCOUNT_ID],
  );
  const managedRows = managedResult.rows as ManagedWebhookRow[];

  for (const target of targets) {
    const createParams = createParamsByEnvironment.get(target.environment)!;
    const idempotencyKey = providerIdempotencyKey(target.url);
    const intent = intents.find((candidate) =>
      candidate.environment === target.environment ||
      candidate.url === target.url,
    );
    const matches = endpoints.filter((endpoint) => endpoint.url === target.url);
    if (matches.length > 1) {
      operations.push({
        key: `webhook_${target.environment}_duplicates`,
        status: "warning",
        detail: `Found ${matches.length} existing endpoints for this URL; none were deleted.`,
      });
    }

    const existing = matches[0];
    const canReplay = !!intent &&
      intent.status === "pending" &&
      intentWithinReplayWindow(intent) &&
      requestParamsMatch(intent, createParams);
    const staleIntent = !!intent && !canReplay && intent.status !== "completed";
    if (intent && intent.request_params && !requestParamsMatch(intent, createParams) && intent.status === "pending") {
      operations.push({
        key: `webhook_${target.environment}`,
        status: "blocked",
        detail: "A pending webhook intent has different parameters; manual recovery is required instead of reusing its idempotency key.",
      });
      continue;
    }
    if (intent && intent.status !== "completed" && !canReplay) {
      operations.push({
        key: `webhook_${target.environment}`,
        status: "blocked",
        detail: "A webhook recovery intent is older than the 24-hour idempotency window; manual Dashboard recovery is required instead of creating a duplicate.",
      });
      continue;
    }

    // A successful provider create followed by a local persistence failure is
    // recoverable only by replaying the exact idempotent request while Stripe's
    // 24-hour idempotency window is still open.  This must happen before the
    // normal existing-endpoint secret check because Stripe returns the secret
    // only from the idempotent create response.
    if (canReplay && (!existing || !endpointSecretAvailable(existing, managedRows))) {
      try {
        const replayed = await stripe.webhookEndpoints.create(
          createParams,
          { idempotencyKey: intent!.idempotency_key || idempotencyKey },
        );
        if (!replayed.secret) throw new Error("replayed endpoint secret unavailable");
        await sync.upsertManagedWebhooks([replayed], EXPECTED_STRIPE_ACCOUNT_ID);
        await markWebhookIntent(target, "completed", replayed.id);
        operations.push({
          key: `webhook_${target.environment}`,
          status: "ok",
          detail: "The original endpoint was recovered by replaying its exact idempotent request; its secret was stored without output.",
        });
      } catch {
        operations.push(operationError(
          `webhook_${target.environment}`,
          "The endpoint exists but its pending idempotent recovery could not persist its signing secret.",
        ));
      }
      continue;
    }

    if (existing) {
      if (!endpointSecretAvailable(existing, managedRows)) {
        operations.push({
          key: `webhook_${target.environment}`,
          status: "blocked",
          detail: staleIntent
            ? "The endpoint's durable recovery intent is older than 24 hours or incomplete; manual Dashboard recovery is required instead of secret rotation."
            : "Existing endpoint signing secret is unavailable; manual Dashboard recovery is required. No rotation or recreation was attempted.",
        });
        continue;
      }

      if (!eventSetIsCurrent(existing, supportedEvents)) {
        try {
          const updated = await stripe.webhookEndpoints.update(existing.id, {
            disabled: false,
            enabled_events: supportedEvents as Stripe.WebhookEndpointUpdateParams.EnabledEvent[],
          });
          await sync.upsertManagedWebhooks?.([updated], EXPECTED_STRIPE_ACCOUNT_ID);
          operations.push({
            key: `webhook_${target.environment}`,
            status: "ok",
            detail: "Existing endpoint was updated in place; its signing secret was preserved.",
          });
        } catch {
          operations.push(operationError(
            `webhook_${target.environment}`,
            "Existing endpoint could not be updated; no endpoint was deleted or recreated.",
          ));
        }
      } else {
        operations.push({
          key: `webhook_${target.environment}`,
          status: "ok",
          detail: "Existing endpoint is enabled and current; no provider mutation was needed.",
        });
      }
      continue;
    }

    // If the database remembers an endpoint that is no longer returned by
    // Stripe, creating a replacement would rotate its signing secret.  Stop
    // for manual recovery instead of silently creating a new endpoint.
    const staleRow = managedRows.find((row) => row.url === target.url);
    if (staleRow) {
      operations.push({
        key: `webhook_${target.environment}`,
        status: "blocked",
        detail: "A prior endpoint record exists but the provider endpoint is missing; manual Dashboard recovery is required instead of secret rotation.",
      });
      continue;
    }

    try {
      let activeIntent = intent;
      if (!activeIntent) {
        await pool.query(
          `INSERT INTO stripe."_forgeproof_webhook_intents"
              (account_id, environment, url, idempotency_key, request_params, status)
           VALUES ($1, $2, $3, $4, $5::jsonb, 'pending')
           ON CONFLICT (account_id, environment) DO NOTHING`,
          [
            EXPECTED_STRIPE_ACCOUNT_ID,
            target.environment,
            target.url,
            idempotencyKey,
            JSON.stringify(createParams),
          ],
        );
        activeIntent = {
          account_id: EXPECTED_STRIPE_ACCOUNT_ID,
          environment: target.environment,
          url: target.url,
          idempotency_key: idempotencyKey,
          request_params: createParams as unknown as Record<string, unknown>,
          status: "pending",
          created_at: new Date(),
        };
      }
      if (activeIntent.status === "completed") {
        operations.push({
          key: `webhook_${target.environment}`,
          status: "blocked",
          detail: "A completed webhook intent has no recoverable endpoint secret; manual Dashboard recovery is required.",
        });
        continue;
      }
      const created = await stripe.webhookEndpoints.create(
        createParams,
        { idempotencyKey: activeIntent.idempotency_key || idempotencyKey },
      );
      if (!created.secret) {
        operations.push({
          key: `webhook_${target.environment}`,
          status: "blocked",
          detail: "Stripe created an endpoint without returning a signing secret; manual recovery is required and no replacement was created.",
        });
        continue;
      }
      await sync.upsertManagedWebhooks([created], EXPECTED_STRIPE_ACCOUNT_ID);
      await markWebhookIntent(target, "completed", created.id);
      operations.push({
        key: `webhook_${target.environment}`,
        status: "ok",
        detail: "A missing endpoint was created once with a stable provider idempotency key; its secret was stored without output.",
      });
    } catch {
      operations.push(operationError(
        `webhook_${target.environment}`,
        "Missing endpoint could not be created or its secret could not be persisted; a stable idempotency key makes retry safe within 24 hours.",
      ));
    }
  }
  return operations;
}

async function reconcileCatalog(
  sync: { syncSingleEntity?: (id: string) => Promise<unknown> },
): Promise<ReconciliationOperation[]> {
  const operations: ReconciliationOperation[] = [];
  const ids = Object.values(EXPECTED_STRIPE_CATALOG).flatMap((catalog) => [
    catalog.productId,
    catalog.priceId,
  ]);
  for (const id of ids) {
    try {
      if (!sync.syncSingleEntity) throw new Error("sync unavailable");
      await sync.syncSingleEntity(id);
      operations.push({
        key: `catalog_${id}`,
        status: "ok",
        detail: `Pinned catalog object ${id} was synchronized without a broad backfill.`,
      });
    } catch {
      operations.push(operationError(
        `catalog_${id}`,
        `Pinned catalog object ${id} could not be synchronized; no replacement object was created.`,
      ));
    }
  }
  return operations;
}

/**
 * Mutating reconciliation.  Authentication, Dashboard-preservation
 * confirmation, and account identity are enforced by the route.  This second
 * identity/readiness check is intentional: it protects the critical section
 * from a provider/account change between request validation and the lock.
 */
export async function reconcileStripe(): Promise<StripeReconciliationReport> {
  if (hasApplicationStorage()) {
    const report=await getStripeReadiness();
    // Git mode has no Stripe catalog cache to rebuild. In particular, never
    // replace an existing endpoint merely to obtain another signing secret.
    return {...report,success:report.ready,reconciliation:{
      status:report.ready ? "ok" : "blocked",localSuccess:report.ready,
      remoteStatus:report.remoteStatus,operations:[{
        key:"git_provider_state",status:report.ready ? "ok" : "blocked",
        detail:report.ready ? "Provider catalog and bound webhook verified; no SQL synchronization required."
          : "Provider inspection identified unresolved configuration; no endpoint, billing or application data was changed.",
      }],
    }};
  }
  let client: { query: (text: string, values?: unknown[]) => Promise<unknown>; release: () => void };
  try {
    client = await pool.connect() as typeof client;
  } catch {
    const readiness = await getStripeReadiness();
    return {
      ...readiness,
      canReconcile: false,
      success: false,
      reconciliation: {
        status: "blocked",
        localSuccess: false,
        remoteStatus: remoteVerificationStatus(readiness),
        operations: [operationError("advisory_lock", "Database reconciliation lock could not be acquired; no changes were made.")],
      },
    };
  }

  try {
    await client.query("SELECT pg_advisory_lock($1)", [RECONCILIATION_LOCK_ID]);
    const initial = await getStripeReadiness();
    if (!initial.canReconcile) {
      return {
        ...initial,
        success: false,
        reconciliation: {
          status: "blocked",
          localSuccess: false,
          remoteStatus: remoteVerificationStatus(initial),
          operations: [{
            key: "readiness",
            status: "blocked",
            detail: "Readiness gates are not satisfied; no provider mutation was attempted.",
          }],
        },
      };
    }

    const operations: ReconciliationOperation[] = [];
    let sync: any;
    try {
      sync = await getStripeSync();
      operations.push(...await reconcileCatalog(sync));
    } catch {
      operations.push(operationError("catalog_sync", "Stripe synchronization library could not be initialized; webhook work continued independently."));
    }

    try {
      const stripe = await getUncachableStripeClient();
      const webhookConfiguration = getConfiguredWebhookTargets();
      if (webhookConfiguration.currentTarget) {
        operations.push(...await reconcileWebhooks(
          stripe,
          sync || {},
          [webhookConfiguration.currentTarget],
        ));
      } else {
        operations.push(operationError(
          "webhook_current_environment",
          "Current environment has no valid webhook target; no provider mutation was attempted.",
        ));
      }
    } catch {
      operations.push(operationError("webhook_reconcile", "Webhook inspection or reconciliation failed; no other endpoints were deleted."));
    }

    const finalReadiness = await getStripeReadiness();
    const localSuccess = !operations.some((operation) =>
      operation.status === "error" || operation.status === "blocked",
    ) && !currentEnvironmentDrift(finalReadiness);
    const remoteStatus = remoteVerificationStatus(finalReadiness);
    const success = localSuccess && (remoteStatus === "verified" || remoteStatus === "not_applicable");
    return {
      ...finalReadiness,
      success,
      reconciliation: {
        status: success ? "ok" : "partial",
        localSuccess,
        remoteStatus,
        operations,
      },
    };
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [RECONCILIATION_LOCK_ID]);
    } finally {
      client.release();
    }
  }
}
