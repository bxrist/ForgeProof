import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Trusted deployment configuration. Missing, malformed, or partial data disables LifeOS. */
export interface LifeosApproval {
  service: "lifeos";
  userId: "lifeos-service-0a";
  apiKeyId: number;
  apiKeyHash: string;
  dedicated: true;
  approvedBySubject: string;
  approvedAt: string;
  approvalReference: string;
}

export function validateLifeosApproval(value: unknown, now = Date.now()): Readonly<LifeosApproval> | null {
  try {
    if (!value || typeof value !== "object") return null;
    const approval = value as Partial<LifeosApproval>;
    if (approval.service !== "lifeos" || approval.userId !== "lifeos-service-0a" ||
        approval.dedicated !== true || !Number.isSafeInteger(approval.apiKeyId) || (approval.apiKeyId as number) <= 0 ||
        typeof approval.apiKeyHash !== "string" || !/^[a-f0-9]{64}$/.test(approval.apiKeyHash) ||
        typeof approval.approvedBySubject !== "string" || !approval.approvedBySubject.trim() ||
        approval.approvedBySubject === approval.userId || typeof approval.approvedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(approval.approvedAt) ||
        !Number.isFinite(Date.parse(approval.approvedAt)) || Date.parse(approval.approvedAt) > now ||
        typeof approval.approvalReference !== "string" || !approval.approvalReference.trim()) return null;
    return Object.freeze(approval as LifeosApproval);
  } catch {
    return null;
  }
}

function loadApproval(): Readonly<LifeosApproval> | null {
  if (process.env.NODE_ENV !== "production") return null;
  try {
    if (process.env.LIFEOS_OWNER_APPROVAL_JSON && process.env.LIFEOS_OWNER_APPROVAL_FILE) return null;
    const raw = process.env.LIFEOS_OWNER_APPROVAL_JSON ?? (process.env.LIFEOS_OWNER_APPROVAL_FILE
      ? (isAbsolute(process.env.LIFEOS_OWNER_APPROVAL_FILE)
          ? readFileSync(process.env.LIFEOS_OWNER_APPROVAL_FILE, "utf8")
          : "")
      : "");
    if (!raw) return null;
    return validateLifeosApproval(JSON.parse(raw));
  } catch {
    return null;
  }
}

export const lifeosApproval: Readonly<LifeosApproval> | null = loadApproval();
