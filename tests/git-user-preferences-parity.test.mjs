import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync,sign} from 'node:crypto';
import {GitAppStateService} from '../server/git-store/store.mjs';
import {GitStorage} from '../server/git-store/storage.ts';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'fp-0b-safe-user-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const bare=join(root,'private.git');
  execFileSync('git',['init','--bare',bare],{stdio:'ignore'});
  const keys=generateKeyPairSync('ed25519');
  const trust={
    eventKeys:{synthetic:{actor:'synthetic',publicKey:keys.publicKey.export({type:'spki',format:'pem'})}},
    receiptKeys:[],receiptPredecessor:null
  };
  const opts={directory:bare,tenant:'synthetic-tenant',repository:'synthetic-repository',
    trust,checkpoint:null,
    signer:{actor:'synthetic',keyId:'synthetic',
      sign:async bytes=>sign(null,bytes,keys.privateKey).toString('base64')}};
  const service=new GitAppStateService(opts);
  const alice='user_synthetic_alice',bob='user_synthetic_bob';
  await service.append({idempotencyKey:'bootstrap-users',operations:[alice,bob].map(id=>({
    kind:'users',id,action:'put',expectedVersion:null,record:{id}
  }))});
  return {root,bare,opts,service,alice,bob,
    aliceStore:new GitStorage(service,alice,[alice,bob],alice),
    bobStore:new GitStorage(service,bob,[alice,bob],alice)};
}

test('legacy preference defaults, false boolean, names and tabs round-trip across an independent Git clone',async t=>{
  const f=await fixture(t);
  const initial=await f.aliceStore.getUser(f.alice);
  assert.equal(initial.notifyOnGitFailure,true);
  assert.equal(initial.detailRepoId,null);
  assert.equal(initial.lastActiveTab,null);
  await f.aliceStore.updateUser(f.alice,{
    notifyOnGitFailure:false,detailRepoId:'reviewed-repo-02',lastActiveTab:'analytics'});
  await f.aliceStore.updateUser(f.alice,{firstName:'Synthetic',lastName:'Fixture'});
  const updated=await f.aliceStore.getUser(f.alice);
  assert.equal(updated.notifyOnGitFailure,false);
  assert.equal(updated.detailRepoId,'reviewed-repo-02');
  assert.equal(updated.lastActiveTab,'analytics');
  assert.equal(updated.firstName,'Synthetic');
  assert.equal(updated.lastName,'Fixture');
  const checkpoint=(await f.service.replay()).checkpoint;
  const clone=join(f.root,'offline-clone.git');
  execFileSync('git',['clone','--mirror',f.bare,clone],{stdio:'ignore'});
  const independent=new GitAppStateService({...f.opts,directory:clone,
    signer:undefined,checkpoint});
  const restored=new GitStorage(independent,f.alice,[f.alice,f.bob],f.alice);
  const recovered=await restored.getUser(f.alice);
  assert.equal(recovered.notifyOnGitFailure,false);
  assert.equal(recovered.detailRepoId,'reviewed-repo-02');
  assert.equal(recovered.lastActiveTab,'analytics');
  assert.equal(recovered.githubToken,null);
  assert.equal('githubTokenRef' in recovered,false);
  assert.equal((await independent.replay()).checkpoint.commit,checkpoint.commit);
});

test('invalid preference values and cross-owner user updates fail closed',async t=>{
  const f=await fixture(t);
  for(const value of ['false',0,{},[]]){
    await assert.rejects(f.aliceStore.updateUser(f.alice,{notifyOnGitFailure:value}),
      /Invalid boolean/);
  }
  for(const field of ['detailRepoId','lastActiveTab']){
    for(const value of [{malformed:true},[],55,true]){
      await assert.rejects(f.aliceStore.updateUser(f.alice,{[field]:value}),/Invalid text/);
    }
  }
  await assert.rejects(f.aliceStore.updateUser(f.alice,{secretUnsupportedField:'x'}),
    /Unsupported user update field/);
  await assert.rejects(f.bobStore.updateUser(f.alice,{notifyOnGitFailure:false}),
    /owner denied/i);
  const snapshot=await f.service.replay();
  assert.equal(snapshot.records.users[f.alice].notifyOnGitFailure,undefined);
});

test('signed Git user event refuses raw GitHub secret and malformed flag',async t=>{
  const f=await fixture(t);
  const snap=await f.service.replay();
  for(const [key,value,pattern] of [
    ['githubToken','gho_synthetic_forbidden_never_real',/Unknown fields/],
    ['notifyOnGitFailure','false',/Invalid boolean/]
  ]){
    await assert.rejects(f.service.append({idempotencyKey:'forged-user-'+key,operations:[{
      kind:'users',id:f.alice,action:'put',
      expectedVersion:snap.versions['users/'+f.alice],
      record:{id:f.alice,[key]:value}
    }]}),pattern);
  }
});
