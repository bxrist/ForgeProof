import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {TABLE_ORDER,TABLE_COLUMNS} from '../server/git-store/full-state-inventory.mjs';
import {captureSealedFullState,openSealedFullState} from '../server/git-store/full-state-sealed.mjs';
import {assessSealedSessionContinuity} from '../server/git-store/sealed-session-continuity.mjs';
import {stageSealedCoreGitState} from '../server/git-store/sealed-core-stage.mjs';
import {GitAppStateService} from '../server/git-store/store.mjs';
import {EncryptedProviderCustodian} from '../server/git-store/custody.ts';

const scope={tenantId:'synthetic',repositoryId:'sessions'};
const now='2026-01-01T00:00:00.000Z';
const session=(sid='SYNTHETIC_PRIVATE_SID',expire='2027-01-01T00:00:00.123Z')=>({
 sid,sess:{passport:{user:{id:'untrusted_claim'}},token:'SYNTHETIC_PRIVATE_TOKEN',
 cookie:{originalMaxAge:1234},nested:[null,false,1.25,{x:'preserved'}]},expire});
async function fixture(rows=[session()]) {
 const data=Object.fromEntries(TABLE_ORDER.map(t=>[t,[]]));
 data.users=[{...Object.fromEntries(TABLE_COLUMNS.users.map(c=>[c,null])),
  id:'alice',email:'alice@example.invalid',created_at:now,updated_at:now}];
 data.sessions=rows;
 const manifest={version:1,sourceDbFingerprint:'synthetic-source',tables:
  Object.fromEntries(TABLE_ORDER.map(t=>[t,{expectedRowCount:data[t].length}]))};
 const enc=randomBytes(32),mac=randomBytes(32);
 const envelope=await captureSealedFullState({async query(sql){
  const m=sql.match(/^SELECT \* FROM "([a-z_]+)"/);return {rows:m?data[m[1]]:[]};
 }},manifest,scope,enc,mac);
 return {envelope,manifest,enc,mac,trust:{originalReceiptPublicKeys:[],expectedReceiptHeadHash:null}};
}
const args=f=>[f.envelope,scope,f.enc,f.mac,f.manifest,f.trust,now];
const assess=f=>assessSealedSessionContinuity(...args(f));
const fails=fn=>assert.throws(fn,e=>e.message==='Sealed session continuity assessment failed'&&!e.cause);

test('empty source is explicit; nonempty source always stops, including expired sessions',async()=>{
 const empty=assess(await fixture([]));
 assert.equal(empty.status,'EMPTY_SOURCE');assert.equal(empty.sessionStageComplete,true);
 assert.equal(empty.productionGoAllowed,false);
 const f=await fixture([session(),session('EXPIRED',now),session('OLDER','2020-01-01T00:00:00.999Z')]);
 const before=openSealedFullState(f.envelope,scope,f.enc,f.mac,f.manifest).sessions;
 const out=assess(f);
 assert.equal(out.status,'STOP');assert.equal(out.sessionCount,3);
 assert.equal(out.activeCount,1);assert.equal(out.expiredCount,2);
 assert.equal(out.stagedSessionCount,0);assert.equal(out.sessionStageComplete,false);
 assert.equal(out.productionGoAllowed,false);assert.equal(out.fullApplicationMigrationComplete,false);
 assert.equal(out.privateStage,undefined);assert.equal(out.transactions,undefined);
 assert.deepEqual(assess(f),out,'retry is a pure assessment');
 assert.deepEqual(openSealedFullState(f.envelope,scope,f.enc,f.mac,f.manifest).sessions,before);
 for (const secret of ['SYNTHETIC_PRIVATE_SID','SYNTHETIC_PRIVATE_TOKEN','untrusted_claim'])
  assert.equal(JSON.stringify(out).includes(secret),false);
});

test('correct, missing, revoked and forged owner maps cannot bypass the absent contract',async()=>{
 const f=await fixture();
 for (const mapping of [undefined,[],[{sid:session().sid,userId:'alice',verified:true}],
  [{sid:session().sid,userId:'alice',revoked:true}],
  [{sid:session().sid,userId:'untrusted_claim',verified:true}]]) {
  fails(()=>assessSealedSessionContinuity(...args(f),{mapping,
   authenticated:true,reviewedSidContinuity:true}));
 }
 // A claim matching a real SQL user still supplies no independent auth proof.
 const claimed=session();claimed.sess.passport.user.id='alice';
 assert.equal(assess(await fixture([claimed])).status,'STOP');
});

test('scope, trust, keys, ciphertext and invalid review times fail with redacted errors',async()=>{
 const f=await fixture();
 for (const [index,value] of [[1,{...scope,repositoryId:'other'}],[2,randomBytes(32)],
  [3,randomBytes(32)],[5,undefined],[6,'invalid'],[6,'2026-01-01']]) {
  const a=args(f);a[index]=value;fails(()=>assessSealedSessionContinuity(...a));
 }
 const envelope=structuredClone(f.envelope);
 envelope.tableRecords[0].tagBase64=Buffer.alloc(16).toString('base64');
 fails(()=>assess({...f,envelope}));
});

test('invalid session serialization and expiry fail closed; duplicate SIDs rejected at capture',async()=>{
 for (const patch of [{sess:null},{sess:'{"userId":"alice"}'},{sess:[]},
  {sess:123},{expire:null},{expire:'invalid'}]) {
  const f=await fixture([{...session(),...patch}]);fails(()=>assess(f));
 }
 await assert.rejects(fixture([session(),session()]));
 await assert.rejects(fixture([{...session(),sess:{bad:undefined}}]));
});

test('independent signed local Git replay has no historical sessions; custody remains unchanged',async t=>{
 const f=await fixture(),vault={data:new Map(),async transact(s,change){
  const {envelope,result}=change(this.data.get(s));this.data.set(s,envelope);return result;
 }};
 const custodian=new EncryptedProviderCustodian(vault,randomBytes(32));
 // Demonstrate existing custody capability without pretending it maps cookies.
 const ref=await custodian.stage('synthetic/sessions','synthetic-control',
  {kind:'oidc-session',material:'SYNTHETIC_CONTROL'});
 const snapshot=[...vault.data];
 assert.equal(await custodian.recoverSession('other/sessions',ref),undefined);
 const prior=[...vault.data];
 assess(f);assess(f);assert.deepEqual([...vault.data],prior);
 assert.equal(await custodian.recoverSession('synthetic/sessions',ref),'SYNTHETIC_CONTROL');
 assert.equal(snapshot[0][1].includes('SYNTHETIC_CONTROL'),false);
 const core=await stageSealedCoreGitState(f.envelope,scope,f.enc,f.mac,f.manifest,f.trust,custodian);
 const root=await mkdtemp(join(tmpdir(),'fp-session-stop-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=join(root,'private.git');execFileSync('git',['init','--bare',directory],{stdio:'ignore'});
 const keys=generateKeyPairSync('ed25519');
 const opts={directory,tenant:scope.tenantId,repository:scope.repositoryId,checkpoint:null,
  trust:{eventKeys:{test:{actor:'test',publicKey:keys.publicKey.export({type:'spki',format:'pem'})}},
   receiptKeys:[],receiptPredecessor:null},
  signer:{actor:'test',keyId:'test',sign:async b=>sign(null,b,keys.privateKey).toString('base64')}};
 const service=new GitAppStateService(opts);
 const appended=await service.append(core.transaction);
 assert.equal((await service.append(core.transaction)).duplicate,true);
 const mirror=join(root,'mirror.git');
 execFileSync('git',['clone','--mirror',directory,mirror],{stdio:'ignore'});
 const replay=await new GitAppStateService({...opts,directory:mirror,signer:undefined,
  checkpoint:appended.checkpoint}).replay();
 assert.deepEqual(Object.keys(replay.records.sessions),[]);
 assert.deepEqual(replay.records,(await service.replay()).records);
 for (const secret of ['SYNTHETIC_PRIVATE_SID','SYNTHETIC_PRIVATE_TOKEN','untrusted_claim'])
  assert.equal(JSON.stringify(replay.events).includes(secret),false);
});
