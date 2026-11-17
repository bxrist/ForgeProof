import type { Express } from "express";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { requireAuth } from "./middlewares/requireAuth";
import { currentApplicationStorage, withStoragePrincipal } from "./storageBackend";
import type { GitStorage } from "./git-store/storage";
import { lifecycleSchema } from "./lifeosLifecycle";
import { parseLifeosRequestIdentity, requireLifeosRequestId } from "./lifeosRequestIdentity.mjs";
import { getKeyPair, signData } from "./crypto";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const enrollment = z.object({
  repositoryId: z.number().int().positive(), active: z.literal(true),
  expiresAt: z.string().datetime(),
}).strict();
const request = z.object({
  file_path: z.string().min(1).max(4096), file_hash: z.string().regex(/^[a-f0-9]{64}$/),
  model_name: z.string().min(1).max(256), model_provider: z.string().min(1).max(256),
  country_of_origin: z.string().min(1).max(256), signedAt: z.string(),
  lifecycle: lifecycleSchema,
}).strict();
function unavailable(): never { throw Object.assign(new Error("Unavailable"), {status:503}); }
function denied(): never { throw Object.assign(new Error("Denied"), {status:403}); }
function git(): GitStorage {
  const store = currentApplicationStorage() as GitStorage | undefined;
  if (!store) unavailable(); // Never fall back to SQL or the LifeOS credential.
  return store;
}
function fail(res: any, error: any) {
  const status = [400,403,409,402].includes(error?.status) ? error.status : 503;
  res.status(status).json({message:status === 403 ? "Project authorization denied" :
    status === 400 ? "Invalid request" : status === 409 ? "Request identity conflict" : "Project operation unavailable"});
}

/** Provider failure is not ownership approval. Only the authenticated owner's connection is used. */
export async function verifyRepositoryAdministration(token: string, project: string, githubId: number) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project)) denied();
  const response = await fetch(`https://api.github.com/repos/${project}`, {
    headers:{Authorization:`Bearer ${token}`,Accept:"application/vnd.github+json"},
    signal:AbortSignal.timeout(10000), redirect:"error",
  });
  if (response.status === 401 || response.status === 403 || response.status === 404) denied();
  if (!response.ok) unavailable();
  const repository = await response.json();
  if (repository.id !== githubId || repository.full_name !== project ||
      repository.permissions?.admin !== true || repository.archived || repository.disabled) denied();
}

export function registerProjectServiceRoutes(app: Express, limiter: any) {
  app.get("/api/project-enrollments", requireAuth, async (_req,res) => {
    res.setHeader("Cache-Control","no-store");
    try { res.json({projects:await git().listProjectServices()}); } catch(e) { fail(res,e); }
  });
  app.post("/api/project-enrollments", limiter, requireAuth, async (req,res) => {
    res.setHeader("Cache-Control","no-store");
    try {
      const parsed=enrollment.safeParse(req.body);
      if (!parsed.success || Date.parse(parsed.data.expiresAt)<=Date.now() ||
          Date.parse(parsed.data.expiresAt)>Date.now()+90*86400000)
        return res.status(400).json({message:"Explicit activation and future expiry within 90 days required"});
      const store=git(), owner=req.dbUser!.id;
      const repository=(await store.getRepositories(owner)).find(r=>r.id===parsed.data.repositoryId && r.userId===owner);
      if (!repository) denied();
      const user=await store.getUser(owner);
      if (!user?.githubToken) denied();
      await verifyRepositoryAdministration(user.githubToken,repository.fullName,repository.githubId);
      const id=randomUUID(), credential=`fp_project_${id}.${randomBytes(32).toString("hex")}`;
      const binding=await store.enrollProjectService({
        id,repositoryId:repository.id,project:repository.fullName,expiresAt:parsed.data.expiresAt,
        verifier:hash(credential),prefix:randomBytes(6).toString("hex"),
      });
      res.status(201).json({...binding,credential});
    } catch(e) { fail(res,e); }
  });
  app.delete("/api/project-enrollments/:id", requireAuth, async (req,res) => {
    try { await git().revokeProjectService(String(req.params.id)); res.json({revoked:true}); }
    catch(e) { fail(res,e); }
  });
  async function authenticated(req: any, action: (store:GitStorage, binding:any, verifier:string)=>Promise<any>) {
    const match=/^Bearer (fp_project_([0-9a-f-]{36})\.[0-9a-f]{64})$/.exec(req.headers.authorization ?? "");
    if (!match || match[2]!==req.params.id) denied();
    const verifier=hash(match[1]);
    // Candidate ID only selects signed state; no principal is trusted before custody proof.
    const binding=await git().authenticateProjectService(match[2],verifier);
    return withStoragePrincipal(String(binding.serviceIdentity),()=>action(git(),binding,verifier));
  }
  app.get("/api/project-services/:id/authorization", limiter, async (req,res) => {
    res.setHeader("Cache-Control","no-store");
    try { res.json(await authenticated(req,async (_store,binding)=>({authorized:true,...binding}))); }
    catch(e) { fail(res,e); }
  });
  app.post("/api/project-services/:id/attest", limiter, async (req,res) => {
    res.setHeader("Cache-Control","no-store");
    try {
      const receipt=await authenticated(req,async (store,binding,verifier)=>{
        const parsed=request.safeParse(req.body);
        if (!parsed.success) throw Object.assign(new Error("Invalid request"),{status:400});
        const identity=parseLifeosRequestIdentity(req.headers["idempotency-key"],parsed.data.signedAt);
        if (!identity) throw Object.assign(new Error("Idempotency required"),{status:400});
        const data=parsed.data;
        if (data.lifecycle.project!==binding.project) denied();
        if (data.lifecycle.model && (data.lifecycle.model.name!==data.model_name ||
            data.lifecycle.model.provider!==data.model_provider))
          throw Object.assign(new Error("Model mismatch"),{status:400});
        const publicKey=getKeyPair().publicKey;
        return store.issueAttestationWithSigner({
          userId:binding.serviceIdentity,fileName:path.basename(data.file_path),filePath:data.file_path,
          fileHash:data.file_hash,modelName:data.model_name,modelProvider:data.model_provider,
          countryOfOrigin:data.country_of_origin,detectedCountry:null,complianceStatus:"unverified",
          receiptVersion:"v1",signedAt:identity.signedAt,attestationType:"origin",
        },{publicKey,sign:async bytes=>signData(bytes.toString("utf8"))},
        identity.requestId,undefined,data.lifecycle,{id:binding.id,verifier});
      });
      res.status(201).json(receipt);
    } catch(e) { fail(res,e); }
  });
  app.get("/api/project-services/:id/attest/status/:requestId", limiter, async (req,res) => {
    res.setHeader("Cache-Control","no-store");
    try {
      const receipt=await authenticated(req,async (store,binding,verifier)=>{
        const id=requireLifeosRequestId(req.params.requestId);
        const result=await store.getAttestationByRequestId(id,
          state=>store.verifyProjectService(state,binding.id,verifier,binding.project));
        if (result && (result as any).lifecycleEvidence?.payload.project!==binding.project) denied();
        return result;
      });
      if (!receipt) return res.status(404).json({message:"Not found or unverified"});
      res.json(receipt);
    } catch(e) { fail(res,e); }
  });
}
