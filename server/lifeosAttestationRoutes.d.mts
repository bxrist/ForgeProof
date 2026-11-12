import type { Express, Request, RequestHandler } from 'express';
import type { GitStorage } from './git-store/storage';
import type { LifeosProof } from './lifeosEntitlement';
import type { Replay } from './git-store/store.mjs';
import type { LifecycleInput } from './lifeosLifecycle';
interface LifeosAttestationBody {
  file_path: string;
  file_hash: string;
  file_name?: string;
  model_name: string;
  model_provider: string;
  country_of_origin: string;
  metadata?: Record<string, unknown>;
  attestation_type?: string;
  parent_attestation_id?: number;
  repository?: string;
  audit_verdict?: string;
  audit_details?: string;
  lifecycle?: LifecycleInput;
}
export function registerLifeosAttestationRoutes(app: Express, deps: {
  limiter: RequestHandler;
  proveControl(header: string | undefined): Promise<LifeosProof>;
  getStorage(): GitStorage | undefined;
  parseBody(body: unknown): {success: true; data: LifeosAttestationBody} | {success: false};
  createReceipt(userId: string, data: LifeosAttestationBody, country: string | null, repositoryId: undefined,
    proof: LifeosProof, identity: {requestId: string; signedAt: string} | undefined): Promise<object>;
  detectCountry(req: Request): string | null;
  verifyState(proof: LifeosProof, userId: string, state: Replay, matches: boolean): void;
  validateLifecycle?(proof: LifeosProof, data: LifeosAttestationBody): void | Promise<void>;
  validateRecovered?(proof: LifeosProof, project: string): void | Promise<void>;
}): void;
