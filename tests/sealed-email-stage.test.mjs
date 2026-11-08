import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,generateKeyPairSync,sign,createHmac} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {TABLE_ORDER} from '../server/git-store/full-state-inventory.mjs';
import {captureSealedFullState,openSealedFullState} from '../server/git-store/full-state-sealed.mjs';
import {stageSealedPendingEmails} from '../server/git-store/sealed-email-stage.mjs';
import {restoreQueuedEmail} from '../server/git-store/protected-email.mjs';
import {GitAppStateService} from '../server/git-store/store.mjs';

const scope={tenantId:'synthetic',repositoryId:'mail'};
const stamp='2026-01-01T00:00:00.000Z';
const row=(id,status)=>({id,to:'PRIVATE_RECIPIENT@example.invalid',subject:'PRIVATE_SUBJECT',
 body_html:'<p>PRIVATE_BODY</p>',body_text:'PRIVATE_BODY',retry_count:0,
 next_retry_at:stamp,status,created_at:stamp});
async function fixture(rows=[row(1,'pending'),row(2,'pending'),row(3,'pending')]) {
 const data=Object.fromEntries(TABLE_ORDER.map(t=>[t,t==='pending_emails'?rows:[]]));
 const manifest={version:1,sourceDbFingerprint:'synthetic-only',
  tables:Object.fromEntries(TABLE_ORDER.map(t=>[t,{expectedRowCount:data[t].length}]))};
 const enc=randomBytes(32),mac=randomBytes(32),mail=randomBytes(32);
 const client={async query(sql){const match=sql.match(/^SELECT \* FROM "([a-z_]+)"/);
  return {rows:match?data[match[1]]:[]};}};
 const envelope=await captureSealedFullState(client,manifest,scope,enc,mac);
 return {envelope,manifest,enc,mac,mail,trust:{originalReceiptPublicKeys:[],expectedReceiptHeadHash:null}};
}
const stage=f=>stageSealedPendingEmails(f.envelope,scope,f.enc,f.mac,f.manifest,f.trust,f.mail);
const generic=call=>assert.throws(call,e=>e.message==='Sealed pending-email Git staging failed');

test('nonempty protected emails preserve every SQL field, schedule and keyed import proof',async()=>{
 const f=await fixture();
 const out=stage(f);
 const source=openSealedFullState(f.envelope,scope,f.enc,f.mac,f.manifest).pending_emails;
 assert.equal(out.summary.emailCount,3);
 assert.equal(out.summary.productionGoAllowed,false);
 assert.equal(out.summary.fullApplicationMigrationComplete,false);
 assert.equal(out.summary.mustPersistExactStageBeforeAnyAppend,true);
 assert.equal(out.summary.stageIsRegenerationUnsafe,true);
 assert.equal(out.summary.stageDigest,'hmac-sha256:'+createHmac('sha256',f.mail)
  .update(JSON.stringify(out.privateStage)).digest('hex'));
 for (const [i,tx] of out.privateStage.transactions.entries()) {
  const op=tx.operations[0],r=op.record;
  assert.equal(op.kind,'pendingEmails');
  assert.equal(op.expectedVersion,null);
  const restored=restoreQueuedEmail(r,scope.tenantId,scope.repositoryId,f.mail);
  assert.deepEqual({id:r.id,to:restored.to,subject:restored.subject,
   body_html:restored.bodyHtml,body_text:restored.bodyText,retry_count:r.retryCount,
   next_retry_at:r.nextRetryAt,status:r.status,created_at:r.createdAt},source[i]);
  assert.throws(()=>restoreQueuedEmail(r,scope.tenantId,scope.repositoryId,randomBytes(32)));
  assert.throws(()=>restoreQueuedEmail(r,'other',scope.repositoryId,f.mail));
  const corrupt=structuredClone(r);corrupt.encryption.tag=Buffer.alloc(16).toString('base64');
  assert.throws(()=>restoreQueuedEmail(corrupt,scope.tenantId,scope.repositoryId,f.mail));
 }
 for (const secret of ['PRIVATE_RECIPIENT','PRIVATE_SUBJECT','PRIVATE_BODY'])
  assert.equal(JSON.stringify(out).includes(secret),false);
 const again=stage(f);
 assert.deepEqual(out.privateStage.transactions.map(t=>t.idempotencyKey),again.privateStage.transactions.map(t=>t.idempotencyKey));
 assert.notEqual(out.summary.stageDigest,again.summary.stageDigest);
 assert.equal(out.summary.sourceCommitment,again.summary.sourceCommitment);
});

test('empty source produces explicit empty proof',async()=>{
 const f=await fixture([]);const out=stage(f);
 assert.deepEqual(out.privateStage.transactions,[]);
 assert.equal(out.summary.emailCount,0);
 assert.deepEqual(stage(f),out);
});

test('missing trust/material, tamper, wrong source key and scope fail closed',async()=>{
 const f=await fixture();
 generic(()=>stage({...f,trust:undefined}));
 generic(()=>stage({...f,trust:{...f.trust,expectedReceiptHeadHash:'a'.repeat(64)}}));
 for (const field of ['enc','mac','mail']) generic(()=>stage({...f,[field]:undefined}));
 generic(()=>stage({...f,enc:randomBytes(32)}));
 generic(()=>stage({...f,mac:randomBytes(32)}));
 generic(()=>stage({...f,mail:f.enc}));
 const corrupt=structuredClone(f.envelope);corrupt.tableRecords[0].tagBase64=Buffer.alloc(16).toString('base64');
 generic(()=>stage({...f,envelope:corrupt}));
 generic(()=>stageSealedPendingEmails(f.envelope,{...scope,tenantId:'other'},f.enc,f.mac,f.manifest,f.trust,f.mail));
});

test('unsupported historical schema values block entire stage without invented replacements',async()=>{
 for (const patch of [{status:'queued'},{status:'sent'},{status:'failed'},{retry_count:2},{next_retry_at:null},{created_at:null},
  {body_text:null},{body_html:null},{retry_count:null},{retry_count:-1},{subject:'bad\nheader'}]) {
  const f=await fixture([row(1,'pending'),{...row(2,'pending'),...patch}]);
  generic(()=>stage(f));
 }
});

test('saved stage appends idempotently and independent signed Git replay restores emails',async t=>{
 const f=await fixture();const out=stage(f);
 const root=await mkdtemp(join(tmpdir(),'fp-mail-stage-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=join(root,'private.git');execFileSync('git',['init','--bare',directory],{stdio:'ignore'});
 const pair=generateKeyPairSync('ed25519');
 const opts={directory,tenant:scope.tenantId,repository:scope.repositoryId,checkpoint:null,
  trust:{eventKeys:{synthetic:{actor:'synthetic',publicKey:pair.publicKey.export({type:'spki',format:'pem'})}},receiptKeys:[],receiptPredecessor:null},
  signer:{actor:'synthetic',keyId:'synthetic',sign:async bytes=>sign(null,bytes,pair.privateKey).toString('base64')}};
 const service=new GitAppStateService(opts);
 const saved=JSON.parse(JSON.stringify(out.privateStage));
 await service.preflight(saved.transactions);
 let last;
 for (const tx of saved.transactions) {
  last=await service.append(tx);assert.equal(last.duplicate,false);
  assert.equal((await service.append(tx)).duplicate,true);
 }
 const state=await service.replay();assert.equal(state.events.length,3);
 const mirror=join(root,'mirror.git');execFileSync('git',['clone','--mirror',directory,mirror],{stdio:'ignore'});
 const clone=new GitAppStateService({...opts,directory:mirror,signer:undefined,checkpoint:last.checkpoint});
 assert.deepEqual((await clone.replay()).records,state.records);
 for (const tx of saved.transactions) {
  const r=tx.operations[0].record;
  assert.deepEqual(state.records.pendingEmails[r.id],r);
  assert.equal(restoreQueuedEmail(state.records.pendingEmails[r.id],scope.tenantId,scope.repositoryId,f.mail).bodyText,'PRIVATE_BODY');
 }
 for (const secret of ['PRIVATE_RECIPIENT','PRIVATE_SUBJECT','PRIVATE_BODY'])
  assert.equal(JSON.stringify(state.events).includes(secret),false);
 await assert.rejects(()=>service.append(stage(f).privateStage.transactions[0]));
});
