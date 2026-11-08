import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,generateKeyPairSync,createHash,sign} from 'node:crypto';
import {TABLE_ORDER,TABLE_COLUMNS} from '../server/git-store/full-state-inventory.mjs';
import {captureSealedFullState} from '../server/git-store/full-state-sealed.mjs';
import {preflightMigrationReadiness as preflight} from '../server/git-store/migration-readiness.mjs';
const stamp='2026-11-08T00:00:00.000Z';
const scope={tenantId:'synthetic',repositoryId:'preflight'};
async function fixture(change=()=>{}) {
 const empty=t=>Object.fromEntries(TABLE_COLUMNS[t].map(c=>[c,null]));
 const data=Object.fromEntries(TABLE_ORDER.map(t=>[t,[]]));
 data.users=[{...empty('users'),id:'alice',email:'PRIVATE@example.invalid',github_token:'PRIVATE_TOKEN',created_at:stamp,updated_at:stamp}];
 data.organizations=[{...empty('organizations'),id:1,name:'org',slug:'org',owner_id:'alice',created_at:stamp}];
 data.repositories=[{...empty('repositories'),id:1,user_id:'alice',org_id:1,github_id:1,name:'repo',full_name:'org/repo',url:'https://example.invalid/repo',created_at:stamp}];
 data.org_members=[{id:1,org_id:1,user_id:'alice',role:'owner',created_at:stamp}];
 data.subscriptions=[{...empty('subscriptions'),id:1,user_id:'alice',org_id:1,plan:'pro',status:'active',attestation_limit:100,attestation_count:0,api_key_limit:1,created_at:stamp}];
 data.api_keys=[{id:1,user_id:'alice',name:'test',key_hash:'a'.repeat(64),key_prefix:'TESTONLY',permissions:['attest:read'],is_active:true,last_used_at:null,expires_at:null,created_at:stamp}];
 data.pending_emails=[{id:1,to:'PRIVATE@example.invalid',subject:'PRIVATE',body_html:'PRIVATE',body_text:'PRIVATE',retry_count:0,next_retry_at:stamp,status:'pending',created_at:stamp}];
 data.audit_logs=[{id:1,user_id:'alice',action:'create',resource_type:null,resource_id:null,metadata:{private:'PRIVATE'},ip_address:null,created_at:stamp}];
 const pair=generateKeyPairSync('ed25519');
 const pk=pair.publicKey.export({type:'spki',format:'der'}).toString('base64');
 const receipt={...empty('attestation_receipts'),id:1,user_id:'alice',org_id:1,repository_id:1,file_hash:'sha256:'+'b'.repeat(64),file_path:'synthetic.txt',model_name:'synthetic',model_provider:'synthetic',country_of_origin:'unknown',public_key:pk,receipt_version:'v1',signed_at:stamp,created_at:stamp};
 receipt.entry_hash=createHash('sha256').update([receipt.file_hash,'synthetic','synthetic','unknown','genesis',stamp].join('|')).digest('hex');
 receipt.signature=sign(null,Buffer.from([receipt.entry_hash,receipt.file_hash,stamp].join('|')),pair.privateKey).toString('base64');
 data.attestation_receipts=[receipt];change(data);
 const reviewedManifest={version:1,sourceDbFingerprint:'synthetic-only',tables:Object.fromEntries(TABLE_ORDER.map(t=>[t,{expectedRowCount:data[t].length}]))};
 const encryptionKey=randomBytes(32),hmacKey=randomBytes(32);
 const envelope=await captureSealedFullState({async query(sql){const m=sql.match(/^SELECT \* FROM "([a-z_]+)"/);return {rows:m?data[m[1]]:[]};}},reviewedManifest,scope,encryptionKey,hmacKey);
 // Any attempt even to inspect adapter methods fails the test.
 const adapter=new Proxy({}, {get(){throw Error('adapter must remain opaque');}});
 return {envelope,scope,encryptionKey,hmacKey,reviewedManifest,
  trust:{originalReceiptPublicKeys:[pk],expectedReceiptHeadHash:receipt.entry_hash},
  archiveKey:randomBytes(32),mailKey:randomBytes(32),now:stamp,
  binding:{...scope,authenticated:true,durableExternalVault:true,custodyScope:'synthetic/preflight'},custodian:adapter,journal:adapter};
}
const rejects=f=>assert.throws(()=>preflight(f),e=>e.message==='Migration readiness preflight failed'&&!e.cause);
test('complete compatible synthetic source covers ten tables; adapters stay untouched and GO stays false',async()=>{
 const f=await fixture(),out=preflight(f);
 assert.equal(out.status,'SOURCE_PREFLIGHT_PASSED');
 assert.equal(Object.keys(out.tableCounts).length,10);
 assert.equal(Object.values(out.tableCounts).reduce((a,b)=>a+b),9);
 for(const k of ['productionGoAllowed','fullApplicationMigrationComplete','fullMigrationReady','stageCompatibilityProven','custodyVerified','journalVerified'])assert.equal(out[k],false);
 assert.equal(out.sourceCommitment,f.envelope.wholeStateCommitment);
 assert.equal(JSON.stringify(out).includes('PRIVATE'),false);
});
test('active and expired sessions are both retained as STOP',async()=>{
 for(const expire of ['2027-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z']) {
  const out=preflight(await fixture(d=>d.sessions=[{sid:'PRIVATE_SID',sess:{private:'PRIVATE'},expire}]));
  assert.equal(out.status,'STOP');assert.equal(out.sessionCount,1);assert.equal(out.fullMigrationReady,false);
  assert.equal(out.activeSessionCount+out.expiredSessionCount,1);
 }
});
test('missing signer trust and pinned rewound head fail without touching adapters',async()=>{
 const f=await fixture();rejects({...f,trust:undefined});
 rejects({...f,trust:{...f.trust,originalReceiptPublicKeys:[]}});
 rejects({...f,trust:{...f.trust,expectedReceiptHeadHash:'c'.repeat(64)}});
});
test('wrong source, table counts, missing table and authenticated tampering fail closed',async()=>{
 const f=await fixture();rejects({...f,scope:{...scope,repositoryId:'wrong'}});
 const m=structuredClone(f.reviewedManifest);m.tables.users.expectedRowCount++;
 rejects({...f,reviewedManifest:m});
 const missing=structuredClone(f.reviewedManifest);delete missing.tables.sessions;rejects({...f,reviewedManifest:missing});
 const envelope=structuredClone(f.envelope);envelope.tableRecords.pop();rejects({...f,envelope});
 rejects({...f,reviewedManifest:{...f.reviewedManifest,sourceDbFingerprint:'wrong'}});
});
test('incompatible email, API custody scope/material and cross-table subscription mismatch fail closed',async()=>{
 for(const patch of [{status:'queued'},{retry_count:1},{body_text:null}])rejects(await fixture(d=>Object.assign(d.pending_emails[0],patch)));
 for(const patch of [{key_hash:'unsupported'},{permissions:['read']},{key_prefix:'unsupported-prefix'}])rejects(await fixture(d=>Object.assign(d.api_keys[0],patch)));
 rejects(await fixture(d=>d.subscriptions=[]));
 const f=await fixture();rejects({...f,binding:{...f.binding,custodyScope:'wrong'}});
 rejects({...f,binding:{...f.binding,authenticated:false}});
 // Runtime verifier mismatch is deliberately unprobed, never a ready result.
 const out=preflight({...f,custodian:{matches:()=>false}});
 assert.equal(out.custodyVerified,false);assert.equal(out.fullMigrationReady,false);
});
test('duplicate identities cannot enter authenticated source',async()=>{
 await assert.rejects(()=>fixture(d=>d.users.push({...d.users[0]})));
});
