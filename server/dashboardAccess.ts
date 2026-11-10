import type { Express } from "express";
import { z } from "zod";
import type { PoolClient } from "pg";
import { pool } from "./legacySqlPool";
import { requireAuth } from "./middlewares/requireAuth";
import { currentApplicationStorage } from "./storageBackend";
import type { GitStorage } from "./git-store/storage";

const grantInput = z.object({ bindingId: z.number().int().positive(), receiptId: z.number().int().positive() }).strict();

// Row locks serialize authority checks with membership removal/demotion and
// organization deletion. Missing organizations never fall back to personal access.
async function isAdmin(client: PoolClient, binding: any, subject: string) {
  if (!binding) return false;
  if (binding.org_id != null) {
    const org = await client.query("SELECT owner_id FROM organizations WHERE id = $1 FOR UPDATE", [binding.org_id]);
    if (!org.rows.length) return false;
    const member = await client.query("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2 FOR UPDATE", [binding.org_id, subject]);
    return org.rows[0].owner_id === subject || member.rows.some(m => m.role === "admin");
  }
  return binding.owner_id === subject;
}

// Lock the binding and local organization authority through grant mutation.
// Clerk authenticates the local subject; caller-supplied org claims confer no rights.
export function registerDashboardAccessRoutes(app: Express) {
  app.post("/api/dashboard-access/grants", requireAuth, async (req, res, next) => {
    const input = grantInput.safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: "Invalid grant" });
    const git=currentApplicationStorage() as GitStorage | undefined;
    if (git) {
      try { return res.status(201).json(await git.grantDashboardReceipt(input.data.bindingId,input.data.receiptId)); }
      catch(error) { return next(error); }
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(`SELECT b.* FROM service_dashboard_bindings b
        WHERE b.id = $1 AND b.revoked_at IS NULL FOR UPDATE`, [input.data.bindingId]);
      const binding = rows[0];
      const admin = await isAdmin(client, binding, req.dbUser!.id);
      if (!binding || !admin) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "Forbidden" });
      }
      if (binding.scope !== "selected") {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "Full-service scope uses binding revocation, not individual grants" });
      }
      const result = await client.query(`INSERT INTO service_dashboard_grants(binding_id, receipt_id, granted_by)
        SELECT $1, id, $3 FROM attestation_receipts WHERE id = $2 AND user_id = $4
        ON CONFLICT (binding_id, receipt_id) WHERE revoked_at IS NULL DO NOTHING RETURNING id`,
        [binding.id, input.data.receiptId, req.dbUser!.id, binding.issuer_id]);
      if (!result.rows.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "Receipt unavailable or already granted" });
      }
      await client.query("COMMIT");
      res.status(201).json(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK"); next(error);
    } finally { client.release(); }
  });

  for (const resource of ["grants", "bindings"] as const) {
    app.delete(`/api/dashboard-access/${resource}/:id`, requireAuth, async (req, res, next) => {
      const id = z.coerce.number().int().positive().safeParse(req.params.id);
      if (!id.success) return res.status(400).json({ message: "Invalid access record" });
      const git=currentApplicationStorage() as GitStorage | undefined;
      if (git) {
        try { await git.revokeDashboardAccess(resource,id.data); return res.sendStatus(204); }
        catch(error) { return next(error); }
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(resource === "bindings"
          ? `SELECT b.* FROM service_dashboard_bindings b WHERE b.id=$1 AND b.revoked_at IS NULL FOR UPDATE OF b`
          : `SELECT b.* FROM service_dashboard_bindings b JOIN service_dashboard_grants g ON g.binding_id=b.id
             WHERE g.id=$1 AND g.revoked_at IS NULL AND b.revoked_at IS NULL FOR UPDATE OF b`, [id.data]);
        if (!await isAdmin(client, rows[0], req.dbUser!.id)) {
          await client.query("ROLLBACK");
          return res.status(403).json({ message: "Forbidden" });
        }
        // Resource is an internal constant; no caller-controlled SQL identifiers.
        await client.query(`UPDATE service_dashboard_${resource} SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL`, [id.data]);
        await client.query("COMMIT");
        res.sendStatus(204);
      } catch (error) {
        await client.query("ROLLBACK"); next(error);
      } finally { client.release(); }
    });
  }
}
