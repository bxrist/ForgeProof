import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync,randomBytes,sign,createHash} from 'node:crypto';
import {GitAppStateService} from '../server/git-store/store.mjs';
import {GitStorage} from '../server/git-store/storage.ts';
import {EncryptedProviderCustodian,UnavailableCustodian} from '../server/git-store/custody.ts';

class MemoryVault {
  data=new Map();
  async transact(scope,change) {
    const {envelope,result}=change(this.data.get(scope));
    this.data.set(scope,envelope);
    return result;
  }
}
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'fp-oauth-git-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const bare=join(root,'private.git');
  execFileSync('git',['init','--bare',bare],{stdio:'ignore'});
  const keys=generateKeyPairSync('ed25519');
  const opts={directory:bare,tenant:'tenant-a',repository:'app',checkpoint:null,
    trust:{eventKeys:{test:{actor:'test',publicKey:keys.publicKey.export({type:'spki',format:'pem'})}},
      receiptKeys:[],receiptPredecessor:null},
    signer:{actor:'test',keyId:'test',sign:async bytes=>sign(null,bytes,keys.privateKey).toString('base64')}};
  const service=new GitAppStateService(opts);
  await service.append({idempotencyKey:'bootstrap-user-owners',operations:['alice','bob'].map(id=>({
    kind:'users',id,action:'put',expectedVersion:null,record:{id}
  }))});
  const vault=new MemoryVault();
  const key=randomBytes(32),custody=new EncryptedProviderCustodian(vault,key);
  const owner=new GitStorage(service,'alice',['alice','bob'],'alice',custody,'tenant-a/app');
  const bob=new GitStorage(service,'bob',['alice','bob'],'alice',custody,'tenant-a/app');
  return {root,bare,opts,service,vault,key,custody,owner,bob};
}
const inspect = async f => await f.service.replay();
test('GitHub OAuth remains in encrypted external custody, never in signed Git, and is owner-only',async t=>{
  const f=await fixture(t);
  const sentinel='gho_synthetic_PRIVATE_TOKEN_SENTINEL_0B_ABC123';
  const next='ghu_synthetic_PRIVATE_TOKEN_REPLACEMENT_0B_XYZ987';
  assert.equal((await f.owner.getUser('alice')).githubToken,null);
  await f.owner.updateUser('alice',{githubToken:sentinel,githubUsername:'fixture-login'});
  const first=await inspect(f);
  const ptr=first.records.users.alice.githubTokenRef;
  assert.match(ptr,/^custodian:[0-9a-f-]{36}$/);
  assert.equal('githubToken' in first.records.users.alice,false);
  const user=await f.owner.getUser('alice');
  assert.equal(user.githubToken,sentinel);
  assert.equal(user.githubUsername,'fixture-login');
  assert.equal('githubTokenRef' in user,false);
  const other=await f.bob.getUser('alice');
  assert.equal(other.githubToken,null);
  assert.equal('githubTokenRef' in other,false);
  const ownerScope='tenant-a/app:github:'+createHash('sha256').update('alice').digest('hex');
  assert.equal(await f.custody.recoverGithubToken(ownerScope,ptr),sentinel);
  assert.equal(await f.custody.recoverGithubToken('tenant-b/app:github:'+createHash('sha256').update('alice').digest('hex'),ptr),undefined);

  const all=JSON.stringify(first.events);
  for(const secret of [sentinel,next,createHash('sha256').update(sentinel).digest('hex')])
    assert.ok(!all.includes(secret),'Secret or deterministic token digest in Git');
  for(const v of f.vault.data.values()){
    assert.ok(!v.includes(sentinel),'Plaintext in provider ciphertext');
    assert.ok(!v.includes(next),'Plaintext in provider ciphertext');
  }
  const cloned=join(f.root,'disconnected.git');
  execFileSync('git',['clone','--mirror',f.bare,cloned],{stdio:'ignore'});
  const disconnected=new GitAppStateService({...f.opts,directory:cloned,
    signer:undefined,checkpoint:first.checkpoint});
  const replayOwner=new GitStorage(disconnected,'alice',['alice','bob'],'alice',f.custody,'tenant-a/app');
  assert.equal((await replayOwner.getUser('alice')).githubToken,sentinel);
  const wrongKey=new EncryptedProviderCustodian(f.vault,randomBytes(32));
  const wrongOwner=new GitStorage(f.service,'alice',['alice','bob'],'alice',wrongKey,'tenant-a/app');
  await assert.rejects(wrongOwner.getUser('alice'));
  const wrongScope=new GitStorage(f.service,'alice',['alice','bob'],'alice',f.custody,'other/app');
  await assert.rejects(wrongScope.getUser('alice'),/recovery unavailable/);
  const disconnectedCustodian=new GitStorage(f.service,'alice',['alice','bob'],'alice',
    new UnavailableCustodian(),'tenant-a/app');
  await assert.rejects(disconnectedCustodian.getUser('alice'),/custody unavailable/);
  const noCustodyScope=new GitStorage(f.service,'alice',['alice','bob'],'alice',f.custody);
  await assert.rejects(noCustodyScope.getUser('alice'),/custody binding unavailable/);

  await f.owner.updateUser('alice',{githubToken:next,githubUsername:'fixture-login-2'});
  const rotated=await inspect(f);
  const newRef=rotated.records.users.alice.githubTokenRef;
  assert.notEqual(newRef,ptr);
  assert.equal(await f.custody.recoverGithubToken(ownerScope,ptr),undefined);
  assert.equal((await f.owner.getUser('alice')).githubToken,next);
  assert.equal((await f.owner.getUser('alice')).githubUsername,'fixture-login-2');
  assert.ok(!JSON.stringify(rotated.events).includes(next));
  await f.owner.updateUser('alice',{githubToken:null});
  const revoked=await inspect(f);
  assert.equal(revoked.records.users.alice.githubTokenRef,null);
  assert.equal((await f.owner.getUser('alice')).githubToken,null);
  assert.equal(await f.custody.recoverGithubToken(ownerScope,newRef),undefined);
  assert.deepEqual(Object.keys(revoked.records.users).sort(),['alice','bob']);
});
test('Invalid OAuth inputs, cross-owner writes and raw Git token insertion fail closed',async t=>{
  const f=await fixture(t);
  for(const bad of ['', 'abc\nsecret', 'abc\rsecret', 'abc\u0000secret', 'a'.repeat(16385)]) {
    await assert.rejects(f.owner.updateUser('alice',{githubToken:bad}),/Invalid GitHub credential input/);
  }
  await assert.rejects(f.bob.updateUser('alice',{githubToken:'gho_synthetic_owner_denied'}),/owner denied/);
  await assert.rejects(f.owner.updateUser('alice',{githubTokenRef:'custodian:fake'}),/Unsupported user update field/);
  const pre=await inspect(f);
  await assert.rejects(f.service.append({idempotencyKey:'forged-raw-token-record',operations:[{
    kind:'users',id:'alice',action:'put',expectedVersion:pre.versions['users/alice'],
    record:{id:'alice',githubToken:'gho_forbidden_plaintext'}
  }]}),/Unknown fields/);
  await assert.rejects(f.service.append({idempotencyKey:'forged-unsafe-custody-ref',operations:[{
    kind:'users',id:'alice',action:'put',expectedVersion:pre.versions['users/alice'],
    record:{id:'alice',githubTokenRef:'custodian:unsafe-secret'}
  }]}),/Invalid GitHub custody reference/);
  assert.equal((await inspect(f)).events.length,1);
});
test('Credential cleanup errors do not erase accepted Git pointer or expose source secret',async t=>{
  const f=await fixture(t);
  await f.owner.updateUser('alice',{githubToken:'gho_synthetic_before_cleanup'});
  const initial=(await inspect(f)).records.users.alice.githubTokenRef;
  const broken={
    stage:(...args)=>f.custody.stage(...args),
    recoverGithubToken:(...args)=>f.custody.recoverGithubToken(...args),
    matches:(...args)=>f.custody.matches(...args),
    destroy:async()=>{throw new Error('synthetic cleanup unavailable');},
    recoverSession:(...args)=>f.custody.recoverSession(...args),
  };
  const owner=new GitStorage(f.service,'alice',['alice','bob'],'alice',broken,'tenant-a/app');
  await assert.rejects(owner.updateUser('alice',{githubToken:'gho_synthetic_after_cleanup'}),/cleanup unavailable/);
  const state=await inspect(f);
  assert.notEqual(state.records.users.alice.githubTokenRef,initial);
  assert.equal((await f.owner.getUser('alice')).githubToken,'gho_synthetic_after_cleanup');
  assert.ok(!JSON.stringify(state.events).includes('gho_synthetic_after_cleanup'));
});

test('Signed but misbound credential reference cannot cross owner-scoped vault namespaces',async t=>{
  const f=await fixture(t);
  const secret='gho_synthetic_NOT_FOR_BOB';
  await f.owner.updateUser('alice',{githubToken:secret});
  const state=await f.service.replay();
  const ref=state.records.users.alice.githubTokenRef;
  assert.ok(ref);
  // A buggy or compromised signer copying a valid opaque pointer to another
  // user cannot make the recipient's distinct external vault namespace unlock.
  await f.service.append({idempotencyKey:'simulated-cross-owner-pointer',operations:[{
    kind:'users',id:'bob',action:'put',expectedVersion:state.versions['users/bob'],
    record:{id:'bob',githubTokenRef:ref}
  }]});
  await assert.rejects(f.bob.getUser('bob'),/GitHub credential recovery unavailable/);
  assert.equal((await f.owner.getUser('alice')).githubToken,secret);
  assert.ok(!JSON.stringify((await f.service.replay()).events).includes(secret));
});
