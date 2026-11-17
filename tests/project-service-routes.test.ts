import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
const f=vi.hoisted(()=>({
  store:{} as any, subject:"owner", session:true,
}));
vi.mock("../server/storageBackend",()=>({
  currentApplicationStorage:()=>f.store,
  withStoragePrincipal:async (subject:string, action:()=>Promise<any>)=>{
    const old=f.subject; f.subject=subject; try{return await action();}finally{f.subject=old;}
  },
}));
vi.mock("../server/middlewares/requireAuth",()=>({
  requireAuth:(req:any,res:any,next:any)=>{
    if(!f.session)return res.status(401).json({message:"Unauthorized"});
    req.dbUser={id:"owner"}; next();
  },
}));
vi.mock("../server/crypto",()=>({
  getKeyPair:()=>({publicKey:"fixture-public-key"}), signData:()=>{throw new Error("No signing in HTTP unit fixtures");},
}));
import { registerProjectServiceRoutes } from "../server/projectServices";
import { registerLifeosAttestationRoutes } from "../server/lifeosAttestationRoutes.mjs";

const id="00000000-0000-4000-8000-000000000001";
const token=`fp_project_${id}.${"a".repeat(64)}`;
const binding={id,serviceIdentity:`project-service-${id}`,ownerId:"owner",tenant:"user:owner",
  project:"fixture/ForgeProof",active:true,expiresAt:"2099-01-01T00:00:00Z"};
const body={file_path:"source.ts",file_hash:"a".repeat(64),model_name:"UNSPECIFIED",
  model_provider:"UNSPECIFIED",country_of_origin:"UNSPECIFIED",signedAt:"2026-11-17T00:00:00.000Z",
  lifecycle:{project:binding.project,stage:"source-write",parents:[],observedAt:"2026-11-17T00:00:00Z"}};
function app(){const a=express();a.set("trust proxy",1);a.use(express.json());registerProjectServiceRoutes(a);return a;}
beforeEach(()=>{
  f.subject="owner";f.session=true;
  f.store={
    getRepositories:vi.fn().mockResolvedValue([{id:1,userId:"owner",fullName:binding.project,githubId:123}]),
    getUser:vi.fn().mockResolvedValue({githubToken:"fixture-only-token"}),
    enrollProjectService:vi.fn().mockResolvedValue(binding),
    listProjectServices:vi.fn().mockResolvedValue([binding]),
    revokeProjectService:vi.fn().mockResolvedValue(undefined),
    authenticateProjectService:vi.fn().mockResolvedValue(binding),
    issueAttestationWithSigner:vi.fn().mockImplementation(async()=>{
      expect(f.subject).toBe(binding.serviceIdentity);return {id:12};
    }),
    getAttestationByRequestId:vi.fn().mockResolvedValue({id:12,lifecycleEvidence:{payload:{project:binding.project}}}),
    verifyProjectService:vi.fn(),
  };
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({
    id:123,full_name:binding.project,permissions:{admin:true},archived:false,disabled:false,
  }),{status:200})));
});
afterEach(()=>vi.unstubAllGlobals());
describe("project enrollment HTTP boundary",()=>{
  it("requires a customer session, explicit activation and finite expiry",async()=>{
    f.session=false;expect((await request(app()).get("/api/project-enrollments")).status).toBe(401);
    f.session=true;
    for(const data of [{repositoryId:1},{repositoryId:1,active:false,expiresAt:"2099-01-01T00:00:00Z"},
      {repositoryId:1,active:true,expiresAt:"2020-01-01T00:00:00Z"}])
      expect((await request(app()).post("/api/project-enrollments").send(data)).status).toBe(400);
    expect(f.store.enrollProjectService).not.toHaveBeenCalled();
  });
  it("enrolls only after provider proves repository admin, returns credential once with no-store",async()=>{
    const res=await request(app()).post("/api/project-enrollments").send({
      repositoryId:1,active:true,expiresAt:new Date(Date.now()+86400000).toISOString(),
    });
    expect(res.status).toBe(201);expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.credential).toMatch(/^fp_project_[a-f0-9-]+\.[a-f0-9]{64}$/);
    expect(f.store.enrollProjectService).toHaveBeenCalledOnce();
    expect((await request(app()).get("/api/project-enrollments")).body.projects[0].credential).toBeUndefined();
  });
  it.each([401,403,404,429,500])("never enrolls after GitHub HTTP %s",async status=>{
    vi.mocked(fetch).mockResolvedValue(new Response("private provider body",{status}));
    const res=await request(app()).post("/api/project-enrollments").send({
      repositoryId:1,active:true,expiresAt:new Date(Date.now()+86400000).toISOString(),
    });
    expect(res.status).toBe(status<429?403:503);expect(res.text).not.toContain("private provider");
    expect(f.store.enrollProjectService).not.toHaveBeenCalled();
  });
  it("denies a repository with no administrative permission",async()=>{
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({id:123,full_name:binding.project,permissions:{admin:false}})));
    const r=await request(app()).post("/api/project-enrollments").send({
      repositoryId:1,active:true,expiresAt:new Date(Date.now()+86400000).toISOString()});
    expect(r.status).toBe(403);expect(f.store.enrollProjectService).not.toHaveBeenCalled();
  });
  it("sanitizes thrown provider/custody failures and does not fall back",async()=>{
    vi.mocked(fetch).mockRejectedValue(new Error("SECRET-provider-exception"));
    const r=await request(app()).post("/api/project-enrollments").send({
      repositoryId:1,active:true,expiresAt:new Date(Date.now()+86400000).toISOString()});
    expect(r.status).toBe(503);expect(r.text).not.toContain("SECRET");
    expect(f.store.enrollProjectService).not.toHaveBeenCalled();
    f.store=null;
    expect((await request(app()).get("/api/project-enrollments")).status).toBe(503);
  });
});
describe("project service HTTP boundary",()=>{
  it("rejects absent, ordinary and wrong-selector credentials even with a session",async()=>{
    for(const credential of ["","Bearer ordinary","Bearer "+token.replace(id,"00000000-0000-4000-8000-000000000002")]){
      const r=await request(app()).get(`/api/project-services/${id}/authorization`).set("Authorization",credential);
      expect(r.status).toBe(403);
    }
    expect(f.store.authenticateProjectService).not.toHaveBeenCalled();
  });
  it("selects the service principal only after proof, requires request identity and correct project",async()=>{
    const url=`/api/project-services/${id}/attest`;
    expect((await request(app()).post(url).set("Authorization",`Bearer ${token}`).send(body)).status).toBe(400);
    const wrong={...body,lifecycle:{...body.lifecycle,project:"fixture/AgentPort"}};
    expect((await request(app()).post(url).set("Authorization",`Bearer ${token}`)
      .set("Idempotency-Key","fixture-request-001").send(wrong)).status).toBe(403);
    expect(f.store.issueAttestationWithSigner).not.toHaveBeenCalled();
    const r=await request(app()).post(url).set("Authorization",`Bearer ${token}`)
      .set("Idempotency-Key","fixture-request-001").send(body);
    expect(r.status).toBe(201);expect(f.subject).toBe("owner");
  });
  it("returns only authorized recovery and sanitizes failures",async()=>{
    const url=`/api/project-services/${id}/attest/status/fixture-request-001`;
    expect((await request(app()).get(url).set("Authorization",`Bearer ${token}`)).status).toBe(200);
    f.store.getAttestationByRequestId.mockResolvedValue(undefined);
    expect((await request(app()).get(url).set("Authorization",`Bearer ${token}`)).status).toBe(404);
    f.store.authenticateProjectService.mockRejectedValue(Object.assign(new Error("private verifier"),{status:403}));
    const r=await request(app()).get(url).set("Authorization",`Bearer ${token}`);
    expect(r.status).toBe(403);expect(r.text).not.toContain("verifier");
  });
});

describe("project-service rate limits",()=>{
  it("throttles owner enrollment, revocation and listing across changing IPs before storage work",async()=>{
    const a=app();
    for(let i=0;i<30;i++)
      expect((await request(a).get("/api/project-enrollments").set("X-Forwarded-For",`192.0.2.${i+1}`)).status).toBe(200);
    const before=f.store.listProjectServices.mock.calls.length;
    const reads=await request(a).get("/api/project-enrollments").set("X-Forwarded-For","198.51.100.1");
    const enroll=await request(a).post("/api/project-enrollments").set("X-Forwarded-For","198.51.100.2")
      .send({repositoryId:1,active:true,expiresAt:new Date(Date.now()+86400000).toISOString()});
    const revoke=await request(a).delete(`/api/project-enrollments/${id}`).set("X-Forwarded-For","198.51.100.3");
    for(const r of [reads,enroll,revoke]){
      expect(r.status).toBe(429);expect(r.headers["retry-after"]).toBeDefined();
      expect(r.headers["cache-control"]).toBe("no-store");expect(r.text).not.toContain("owner");
    }
    expect(f.store.listProjectServices).toHaveBeenCalledTimes(before);
    expect(f.store.enrollProjectService).not.toHaveBeenCalled();
    expect(f.store.revokeProjectService).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("shares a service budget across authorization, readback and signing regardless of IP or request ID",async()=>{
    const a=app();
    for(let i=0;i<60;i++)
      expect((await request(a).get(`/api/project-services/${id}/authorization`)
        .set("Authorization",`Bearer ${token}`).set("X-Forwarded-For",`192.0.2.${i+1}`)).status).toBe(200);
    const calls=f.store.authenticateProjectService.mock.calls.length;
    const auth=await request(a).get(`/api/project-services/${id}/authorization`)
      .set("Authorization",`Bearer ${token}`).set("X-Forwarded-For","198.51.100.1");
    const recovery=await request(a).get(`/api/project-services/${id}/attest/status/different-request-002`)
      .set("Authorization",`Bearer ${token}`).set("X-Forwarded-For","198.51.100.2");
    const write=await request(a).post(`/api/project-services/${id}/attest`)
      .set("Authorization",`Bearer ${token}`).set("X-Forwarded-For","198.51.100.3")
      .set("Idempotency-Key","different-request-003").send(body);
    for(const r of [auth,recovery,write]){
      expect(r.status).toBe(429);expect(r.text).not.toContain(token);expect(r.text).not.toContain(id);
    }
    expect(f.store.authenticateProjectService).toHaveBeenCalledTimes(calls);
    expect(f.store.issueAttestationWithSigner).not.toHaveBeenCalled();
    expect(f.store.getAttestationByRequestId).not.toHaveBeenCalled();
  });
  it("caps rotating invalid credentials by IP without touching custody, and leaves LifeOS routes working",async()=>{
    const a=app();
    const originalReceipt={id:78,signature:"fixture-existing-receipt"};
    registerLifeosAttestationRoutes(a,{
      limiter:(_q:any,_r:any,next:any)=>next(),
      proveControl:vi.fn().mockResolvedValue({userId:"lifeos-service-0a"}),
      getStorage:()=>({getAttestationByRequestId:async()=>originalReceipt}),
      parseBody:()=>({success:true,data:{}}),
      detectCountry:()=>null, verifyState:async()=>{},
      createReceipt:async()=>originalReceipt,
    });
    for(let i=0;i<100;i++){
      const different=`fp_project_${id}.${i.toString(16).padStart(64,"0")}`;
      // Different selector means these cannot pass bearer proof.
      expect((await request(a).get("/api/project-services/other/authorization")
        .set("Authorization",`Bearer ${different}`)).status).toBe(403);
    }
    expect((await request(a).get(`/api/project-services/${id}/authorization`)
      .set("Authorization",`Bearer ${token}`)).status).toBe(429);
    expect(f.store.authenticateProjectService).not.toHaveBeenCalled();
    const lifeos=await request(a).get("/api/lifeos/attest/status/existing-request-001")
      .set("Authorization","Bearer fixture-lifeos-token");
    expect(lifeos.status).toBe(200);expect(lifeos.body.id).toBe(78);
  });
});
