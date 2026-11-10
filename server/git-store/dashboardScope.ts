import type { Replay } from "./store.mjs";

export function validateDashboardRelations(state: Replay): void {
  const r = state.records;
  const principals = r.serviceDashboardPrincipals ?? {};
  const bindings = r.serviceDashboardBindings ?? {};
  const active = new Set<string>();
  for (const p of Object.values(principals)) {
    if (!r.users[String(p.issuerId)]) throw new Error("Missing dashboard issuer");
  }
  for (const b of Object.values(bindings)) {
    const p = principals[String(b.issuerId)];
    if (!p || p.tenantKey !== b.tenantKey) throw new Error("Dashboard principal mismatch");
    if (b.ownerId != null && !r.users[String(b.ownerId)]) throw new Error("Missing dashboard owner");
    if (b.orgId != null && !r.organizations[String(b.orgId)]) throw new Error("Missing dashboard organization");
    if (b.revokedAt == null) {
      if (active.has(String(b.issuerId))) throw new Error("Duplicate active dashboard binding");
      active.add(String(b.issuerId));
    }
  }
  const grants = new Set<string>();
  for (const g of Object.values(r.serviceDashboardGrants ?? {})) {
    if (!bindings[String(g.bindingId)] || !r.receipts[String(g.receiptId)])
      throw new Error("Missing dashboard grant relation");
    if (g.revokedAt == null) {
      const key = `${g.bindingId}:${g.receiptId}`;
      if (grants.has(key)) throw new Error("Duplicate active dashboard grant");
      grants.add(key);
    }
  }
}

/** Mirrors dashboardReceiptScope; caller must first authenticate the viewer. */
export function dashboardAllows(state: Replay, viewer: string, receipt: {id: number; userId: string}): boolean {
  if (receipt.userId === viewer || receipt.userId === "forgeproof-system") return true;
  const r = state.records;
  return Object.values(r.serviceDashboardBindings ?? {}).some(b => {
    if (b.issuerId !== receipt.userId || b.revokedAt != null) return false;
    const principal = r.serviceDashboardPrincipals?.[String(b.issuerId)];
    if (!principal || principal.tenantKey !== b.tenantKey) return false;
    if (b.scope !== "full-service" && !(b.scope === "selected" &&
      Object.values(r.serviceDashboardGrants ?? {}).some(g =>
        g.bindingId === b.id && g.receiptId === receipt.id && g.revokedAt == null))) return false;
    if (b.ownerId === viewer) return true;
    const org = b.orgId == null ? undefined : r.organizations[String(b.orgId)];
    return !!org && (org.ownerId === viewer || Object.values(r.orgMembers).some(m =>
      m.orgId === b.orgId && m.userId === viewer && ["owner", "admin", "member"].includes(String(m.role))));
  });
}
