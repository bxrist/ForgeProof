import {it,expect,vi} from "vitest";
import express from "express";
import request from "supertest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {generateKeyPairSync,sign} from "node:crypto";
// The provider boundary is mocked; the application middleware and Git
// transactions are real. This is not an external Clerk sign-up acceptance run.
vi.mock("@clerk/express",()=>({getAuth:(req:any)=>({
  userId:req.headers["x-fixture-verified-subject"] ?? null,
  sessionClaims:{},
})}));
vi.mock("../server/db",()=>{throw new Error("Git registration must not import SQL");});
import {GitAppStateService} from "../server/git-store/store.mjs";
import {GitStorage} from "../server/git-store/storage";
import {installApplicationStorage,requestStorageScope} from "../server/storageBackend";
import {requireAuth} from "../server/middlewares/requireAuth";
import {storage} from "../server/storage";
import {PLAN_LIMITS} from "../shared/schema";

it("registers only verified subjects, persists free entitlements and isolates concurrent accounts in Git",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"forgeproof-registration-"));
  try {
    const bare=join(directory,"state.git");
    execFileSync("git",["init","--bare",bare],{stdio:"ignore"});
    const keys=generateKeyPairSync("ed25519",{publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
    const options={directory:bare,tenant:"fixture",repository:"registration",checkpoint:null,
      signer:{actor:"fixture",keyId:"fixture",sign:async(b:Buffer)=>sign(null,b,keys.privateKey).toString("base64")},
      trust:{eventKeys:{fixture:{actor:"fixture",publicKey:keys.publicKey}},receiptKeys:[],receiptPredecessor:null}};
    const service=new GitAppStateService(options);
    await service.append({idempotencyKey:"bootstrap",operations:[{kind:"users",id:"operator",action:"put",expectedVersion:null,record:{id:"operator"}}]});
    const members=["operator"];
    installApplicationStorage(subject=>{
      if(subject&&!members.includes(subject)) members.push(subject);
      return new GitStorage(service,subject??"operator",members,"operator",undefined,"",undefined,undefined,undefined,true);
    });
    const app=express();
    app.use(express.json(),(_req,_res,next)=>requestStorageScope(next));
    app.post("/account",requireAuth,async(req,res,next)=>{
      try {res.json({id:req.dbUser!.id,subscription:await storage.getOrCreateFreeSubscription(req.dbUser!.id)});}
      catch(error){next(error);}
    });
    app.use((error:Error,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{res.status(500).json({error:error.message});});
    expect((await request(app).post("/account").send({userId:"forged"})).status).toBe(401);
    const responses=await Promise.all(["alice","bob"].map(id=>request(app).post("/account")
      .set("x-fixture-verified-subject",id).send({userId:"forged"}).timeout({deadline:60000})));
    for(const [index,response] of responses.entries()){
      expect(response.status,response.text).toBe(200);
      expect(response.body.id).toBe(["alice","bob"][index]);
      expect(response.body.subscription.userId).toBe(response.body.id);
      expect(response.body.subscription.plan).toBe("free");
      expect(response.body.subscription.attestationLimit).toBe(PLAN_LIMITS.free.attestationLimit);
      expect(response.body.subscription.apiKeyLimit).toBe(PLAN_LIMITS.free.apiKeyLimit);
    }
    const state=await service.replay();
    const restored=await new GitAppStateService({...options,checkpoint:state.checkpoint}).replay();
    expect(Object.keys(restored.records.users).sort()).toEqual(["alice","bob","operator"]);
    expect(Object.values(restored.records.subscriptions)).toHaveLength(2);
  } finally {await rm(directory,{recursive:true,force:true});}
},90000);
