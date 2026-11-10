import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync,sign} from 'node:crypto';
import {GitAppStateService} from '../server/git-store/store.mjs';
import {GitStorage} from '../server/git-store/storage.ts';
import {storage} from '../server/storage.ts';
import {installApplicationStorage,withStoragePrincipal} from '../server/storageBackend.ts';

test('current application storage facade routes concurrent principals to durable Git without DATABASE_URL',async t=>{
  assert.equal(process.env.DATABASE_URL,undefined);
  const root=await mkdtemp(join(tmpdir(),'forgeproof-app-facade-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'state.git');
  execFileSync('git',['init','--bare',directory],{stdio:'ignore'});
  const keys=generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  const signer={actor:'fixture',keyId:'fixture',sign:async b=>sign(null,b,keys.privateKey).toString('base64')};
  const service=new GitAppStateService({directory,tenant:'fixture',repository:'application',checkpoint:null,signer,
    trust:{eventKeys:{fixture:{actor:'fixture',publicKey:keys.publicKey}},receiptKeys:[],receiptPredecessor:null}});
  await service.append({idempotencyKey:'fixture-users',operations:['alice','bob'].map(id=>({
    kind:'users',id,action:'put',expectedVersion:null,record:{id}
  }))});
  installApplicationStorage(principal=>new GitStorage(service,principal??'alice',['alice','bob'],'alice'));
  await Promise.all(['alice','bob'].map(id=>withStoragePrincipal(id,async()=>{
    await new Promise(resolve=>setTimeout(resolve,id==='alice'?10:1));
    await storage.updateUser(id,{lastActiveTab:`${id}-tab`});
    assert.equal((await storage.getUser(id)).lastActiveTab,`${id}-tab`);
    await assert.rejects(storage.updateUser(id==='alice'?'bob':'alice',{lastActiveTab:'denied'}),/owner denied/);
  })));
  const state=await service.replay();
  assert.equal(state.records.users.alice.lastActiveTab,'alice-tab');
  assert.equal(state.records.users.bob.lastActiveTab,'bob-tab');
});
