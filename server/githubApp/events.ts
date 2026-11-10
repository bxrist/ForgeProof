import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError, AppStore, record, sha, unpack } from "./store";
import { GitHubAppClient } from "./client";

export function verifyWebhook(raw: unknown, signature: unknown, secret: string) {
  if (!Buffer.isBuffer(raw) || !secret || typeof signature !== "string" || !/^sha256=[a-f0-9]{64}$/.test(signature))
    throw new AppError(401, "Invalid GitHub App webhook signature");
  const expected = createHmac("sha256", secret).update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex")))
    throw new AppError(401, "Invalid GitHub App webhook signature");
}
export function positiveId(value: unknown): number {
  const n = typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) throw new AppError(400, "Invalid GitHub identifier");
  return n;
}
export const installKey = (appId: number, id: number) => `installation-${appId}-${id}`;
export const purchaseKey = (appId: number, id: number) => `purchase-${appId}-${id}`;

export async function processEvent(store: AppStore, client: GitHubAppClient, event: string, delivery: string, raw: Buffer) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(delivery)) throw new AppError(400, "Missing or invalid delivery ID");
  const payloadHash = sha(Buffer.concat([Buffer.from(event + "\0"), raw]));
  const deliveryKey = `delivery-${client.cfg.id}-${sha(delivery)}`;
  const before = await store.read();
  const prior = unpack(before.records.githubApp[deliveryKey]);
  if (prior) {
    if (prior.payloadHash !== payloadHash) throw new AppError(409, "Delivery ID conflict");
    return { status: "duplicate", billingActivated: false };
  }
  let payload: any;
  try { payload = JSON.parse(raw.toString("utf8")); } catch { throw new AppError(400, "Invalid webhook JSON"); }
  await client.verifyApp();
  let key: string | undefined, category = "", data: any;
  if (event === "installation" || event === "installation_repositories") {
    const id = positiveId(payload.installation?.id);
    if (payload.installation?.app_id !== client.cfg.id) throw new AppError(403, "Webhook belongs to another App");
    const actions = event === "installation" ? ["created", "deleted", "suspend", "unsuspend", "new_permissions_accepted"] : ["added", "removed"];
    if (!actions.includes(payload.action)) return { status: "ignored", billingActivated: false };
    key = installKey(client.cfg.id, id); category = "installation";
    try { data = await client.snapshot(id); }
    catch (e) {
      if (!(e instanceof AppError) || e.status !== 404) throw e;
      // A current GitHub 404, not a delayed payload, revokes local access.
      const old = unpack(before.records.githubApp[key]);
      data = { appId: client.cfg.id, id, accountId: old?.accountId ?? positiveId(payload.installation.account?.id),
        accountLogin: old?.accountLogin ?? String(payload.installation.account?.login ?? ""),
        status: "deleted", repositorySelection: "selected", repositories: [] };
    }
  } else if (event === "marketplace_purchase") {
    if (!["purchased", "cancelled", "changed", "pending_change", "pending_change_cancelled"].includes(payload.action))
      return { status: "ignored", billingActivated: false };
    const accountId = positiveId(payload.marketplace_purchase?.account?.id);
    key = purchaseKey(client.cfg.id, accountId); category = "purchase";
    try {
      const account = await client.request(`/marketplace_listing/accounts/${accountId}`, client.jwt());
      if (account.id !== accountId) throw new AppError(403, "Marketplace account mismatch");
      const purchase = account.marketplace_purchase;
      if (!purchase?.plan?.id) throw new AppError(502, "Marketplace response could not be verified");
      data = { appId: client.cfg.id, accountId, status: "active", planId: positiveId(purchase.plan.id),
        billingCycle: purchase.billing_cycle ?? null, pendingPlanId: account.marketplace_pending_change?.plan?.id ?? null,
        pendingEffectiveAt: account.marketplace_pending_change?.effective_date ?? null,
        verifiedAt: new Date().toISOString(), billingActivated: false };
    } catch (e) {
      if (!(e instanceof AppError) || e.status !== 404) throw e;
      data = { appId: client.cfg.id, accountId, status: payload.action === "cancelled" ? "cancelled" : "not_subscribed",
        planId: null, verifiedAt: new Date().toISOString(), billingActivated: false };
    }
  } else return { status: "ignored", billingActivated: false };

  const targetKey = key!;
  return store.transact(s => {
    const duplicate = unpack(s.records.githubApp[deliveryKey]);
    if (duplicate) {
      if (duplicate.payloadHash !== payloadHash) throw new AppError(409, "Delivery ID conflict");
      return { rows: [], result: { status: "duplicate", billingActivated: false } };
    }
    // An intervening refresh/link/event invalidates this external snapshot.
    // Request redelivery rather than overwriting a newer authorization state.
    if (s.versions[`githubApp/${targetKey}`] !== before.versions[`githubApp/${targetKey}`])
      throw new AppError(503, "Concurrent GitHub update; redeliver event");
    const existing = s.records.githubApp[targetKey];
    return { rows: [
      record(targetKey, category, existing?.ownerId as string ?? null, data),
      record(deliveryKey, "delivery", null, { event, action: payload.action, payloadHash, targetKey }),
    ], result: { status: "processed", billingActivated: false } };
  });
}
