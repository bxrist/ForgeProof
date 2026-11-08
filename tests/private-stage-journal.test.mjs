import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHmac} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {openPrivateStageJournal} from '../server/git-store/private-stage-journal.mjs';
import {canonical} from '../server/git-store/schema.mjs';

const ERROR='Private stage journal verification failed';
function fixture(t,kind='email',empty=false) {
 const root=fs.mkdtempSync(join(tmpdir(),'fp-journal-'));fs.chmodSync(root,0o700);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const worktree=join(root,'worktree'),directory=join(root,'journal');
 fs.mkdirSync(worktree,{mode:0o700});fs.mkdirSync(directory,{mode:0o700});
 const sourceCommitment=randomBytes(32).toString('hex');
 const scope={tenantId:'synthetic',repositoryId:'fixture'};
 const tx={idempotencyKey:'synthetic',operations:[{record:{private:'SYNTHETIC_PRIVATE_CONTENT'}}]};
 const stage=kind==='core'?{version:1,transaction:empty?null:tx,
  summary:{sourceCommitment,productionGoAllowed:false}}:
  {version:1,...(kind==='evidence'?{}:{scope,sourceCommitment}),transactions:empty?[]:[tx]};
 const bytes=Buffer.from(JSON.stringify(stage));
 const options={directory,worktree,binding:{...scope,authenticated:true},journalKey:randomBytes(32),proofKey:randomBytes(32)};
 const expected={id:'synthetic-stage',kind,sourceCommitment,stageDigest:'hmac-sha256:'+createHmac('sha256',options.proofKey)
  .update(kind==='api-key'?canonical(stage):bytes).digest('hex')};
 const journal=openPrivateStageJournal(options);t.after(()=>journal.close());
 return {root,options,journal,expected,bytes,file:join(directory,expected.id+'.stage')};
}
const fails=fn=>assert.throws(fn,e=>e.message===ERROR && e.cause===undefined);

test('all four synthetic stage contracts, including empty stages, survive restart exactly',t=>{
 for(const kind of ['core','evidence','email','api-key']) for(const empty of [false,true]) {
  const f=fixture(t,kind,empty);const summary=f.journal.persist(f.expected,f.bytes);
  assert.deepEqual(f.journal.verify(f.expected),summary);
  assert.equal(summary.operationCount,empty?0:1);assert.equal(summary.productionGoAllowed,false);
  assert.equal(summary.fullApplicationMigrationComplete,false);
  assert.deepEqual(Object.keys(summary).sort(),['commitment','fullApplicationMigrationComplete','operationCount','productionGoAllowed','transactionCount']);
  assert.equal(fs.statSync(f.file).mode&0o777,0o600);
  const encrypted=fs.readFileSync(f.file);assert.equal(encrypted.includes('SYNTHETIC_PRIVATE_CONTENT'),false);
  assert.equal(encrypted.includes(f.expected.sourceCommitment),false);
  f.journal.close();const restarted=openPrivateStageJournal(f.options);
  try {
   assert.deepEqual(restarted.read(f.expected).bytes,f.bytes);
   assert.deepEqual(restarted.persist(f.expected,f.bytes),summary);
   assert.deepEqual(fs.readFileSync(f.file),encrypted);
  } finally {restarted.close();}
 }
});

test('missing, wrong key, proof key, scope, source, kind and digest reject with generic errors',t=>{
 const f=fixture(t);fails(()=>f.journal.read(f.expected));f.journal.persist(f.expected,f.bytes);
 for(const patch of [{journalKey:randomBytes(32)},{proofKey:randomBytes(32)},
  {binding:{...f.options.binding,tenantId:'other'}},{binding:{...f.options.binding,repositoryId:'other'}}]) {
  const journal=openPrivateStageJournal({...f.options,...patch});
  try {fails(()=>journal.read(f.expected));fails(()=>journal.persist(f.expected,f.bytes));}finally{journal.close();}
 }
 for(const patch of [{sourceCommitment:'a'.repeat(64)},{kind:'evidence'},{stageDigest:'hmac-sha256:'+'b'.repeat(64)},{id:'../escape'}])
  fails(()=>f.journal.read({...f.expected,...patch}));
 fails(()=>openPrivateStageJournal({...f.options,binding:{...f.options.binding,authenticated:false}}));
 fails(()=>openPrivateStageJournal({...f.options,journalKey:f.options.proofKey}));
});

test('tamper, truncation, plaintext and permissive entry modes fail closed without repair',t=>{
 const f=fixture(t);f.journal.persist(f.expected,f.bytes);const encrypted=fs.readFileSync(f.file);
 const tampered=Buffer.from(encrypted);tampered[tampered.length-1]^=1;
 for(const bad of [tampered,encrypted.subarray(0,10),encrypted.subarray(0,-1),f.bytes,Buffer.alloc(0)]) {
  fs.writeFileSync(f.file,bad);fails(()=>f.journal.read(f.expected));fails(()=>f.journal.persist(f.expected,f.bytes));
  assert.deepEqual(fs.readFileSync(f.file),bad);
 }
 fs.writeFileSync(f.file,encrypted);fs.chmodSync(f.file,0o644);fails(()=>f.journal.read(f.expected));
});

test('same ID with changed bytes or independently valid changed proof conflicts',t=>{
 const f=fixture(t);f.journal.persist(f.expected,f.bytes);const original=fs.readFileSync(f.file);
 const changed=Buffer.concat([f.bytes,Buffer.from(' ')]);
 fails(()=>f.journal.persist(f.expected,changed));
 const expected={...f.expected,stageDigest:'hmac-sha256:'+createHmac('sha256',f.options.proofKey).update(changed).digest('hex')};
 fails(()=>f.journal.persist(expected,changed));assert.deepEqual(fs.readFileSync(f.file),original);
});

test('symlinks, nonfiles, worktree destinations and directory replacement reject',t=>{
 const f=fixture(t);const other=join(f.root,'other');fs.mkdirSync(other,{mode:0o700});
 fs.symlinkSync(join(other,'missing'),f.file);fails(()=>f.journal.persist(f.expected,f.bytes));fs.unlinkSync(f.file);
 fs.mkdirSync(f.file,{mode:0o700});fails(()=>f.journal.read(f.expected));fs.rmdirSync(f.file);
 f.journal.persist(f.expected,f.bytes);
 fs.renameSync(f.options.directory,join(f.root,'moved'));fs.mkdirSync(f.options.directory,{mode:0o700});
 fails(()=>f.journal.read(f.expected));fails(()=>f.journal.persist(f.expected,f.bytes));
 assert.deepEqual(fs.readdirSync(f.options.directory),[]);
 fs.rmdirSync(f.options.directory);fs.symlinkSync(join(f.root,'moved'),f.options.directory);
 fails(()=>openPrivateStageJournal(f.options));
 fails(()=>openPrivateStageJournal({...f.options,directory:f.options.worktree}));
 fs.chmodSync(other,0o755);fails(()=>openPrivateStageJournal({...f.options,directory:other}));
 fs.chmodSync(other,0o700);fs.mkdirSync(join(other,'.git'));fs.writeFileSync(join(other,'.git','HEAD'),'synthetic');
 fails(()=>openPrivateStageJournal({...f.options,directory:other}));
});

test('process death after atomic publication leaves exact recoverable entry and encrypted orphan',t=>{
 const f=fixture(t);f.journal.close();
 const script=`import fs from 'node:fs';
 import {openPrivateStageJournal} from ${JSON.stringify(new URL('../server/git-store/private-stage-journal.mjs',import.meta.url).href)};
 const config=JSON.parse(process.argv[1]);
 config.options.journalKey=Buffer.from(config.options.journalKey,'hex');
 config.options.proofKey=Buffer.from(config.options.proofKey,'hex');
 const journal=openPrivateStageJournal(config.options);
 const original=fs.linkSync;
 fs.linkSync=(...args)=>{original(...args);process.exit(73);};
 journal.persist(config.expected,Buffer.from(config.bytes,'base64'));`;
 const config={options:{...f.options,journalKey:f.options.journalKey.toString('hex'),proofKey:f.options.proofKey.toString('hex')},
  expected:f.expected,bytes:f.bytes.toString('base64')};
 const child=spawnSync(process.execPath,['--input-type=module','-e',script,JSON.stringify(config)],{encoding:'utf8'});
 assert.equal(child.status,73,child.stderr);
 const restarted=openPrivateStageJournal(f.options);
 try {
  assert.deepEqual(restarted.read(f.expected).bytes,f.bytes);
  const encrypted=fs.readFileSync(f.file);restarted.persist(f.expected,f.bytes);
  assert.deepEqual(fs.readFileSync(f.file),encrypted);
  assert.equal(fs.readdirSync(f.options.directory).filter(n=>n.startsWith('.pending-')).length,1);
 }finally{restarted.close();}
});

test('publication-time directory swap stays descriptor anchored and reports failure',t=>{
 const f=fixture(t),original=fs.linkSync;
 fs.linkSync=(...args)=>{
  fs.renameSync(f.options.directory,join(f.root,'moved'));
  fs.mkdirSync(f.options.directory,{mode:0o700});return original(...args);
 };
 try {fails(()=>f.journal.persist(f.expected,f.bytes));}finally{fs.linkSync=original;}
 assert.deepEqual(fs.readdirSync(f.options.directory),[]);
 assert.equal(fs.existsSync(join(f.root,'moved',f.expected.id+'.stage')),true);
});

test('fsync failure reports ambiguity and never replaces published bytes',t=>{
 const f=fixture(t),original=fs.fsyncSync;let calls=0;
 fs.fsyncSync=(...args)=>{if(++calls===2)throw new Error('synthetic fault');return original(...args);};
 try {fails(()=>f.journal.persist(f.expected,f.bytes));}finally{fs.fsyncSync=original;}
 const encrypted=fs.readFileSync(f.file);f.journal.persist(f.expected,f.bytes);
 assert.deepEqual(fs.readFileSync(f.file),encrypted);
});

test('authenticated malformed stage and scope/source mismatch cannot be persisted',t=>{
 const f=fixture(t);
 for(const bytes of [Buffer.from('{'),Buffer.from('null'),Buffer.from('{"version":1,"transactions":null}'),
  Buffer.from(JSON.stringify({version:1,scope:{tenantId:'other',repositoryId:'fixture'},transactions:[]})),
  Buffer.from(JSON.stringify({version:1,sourceCommitment:'b'.repeat(64),transactions:[]}))]) {
  const expected={...f.expected,stageDigest:'hmac-sha256:'+createHmac('sha256',f.options.proofKey).update(bytes).digest('hex')};
  fails(()=>f.journal.persist(expected,bytes));assert.equal(fs.existsSync(f.file),false);
 }
});

test('competing publication never overwrites the winning entry',t=>{
 const f=fixture(t),original=fs.linkSync;let winner;
 fs.linkSync=(source,target)=>{
  // Another writer wins between the absence check and the atomic link.
  winner=fs.readFileSync(source);fs.writeFileSync(target,winner,{flag:'wx',mode:0o600});
  return original(source,target);
 };
 try {f.journal.persist(f.expected,f.bytes);}finally{fs.linkSync=original;}
 assert.deepEqual(fs.readFileSync(f.file),winner);
 assert.deepEqual(f.journal.read(f.expected).bytes,f.bytes);
});

test('incomplete pre-publication write remains inert encrypted orphan, never a final stage',t=>{
 const f=fixture(t),original=fs.writeFileSync;
 fs.writeFileSync=(fd,data)=>{original(fd,data.subarray(0,10));throw new Error('synthetic interrupted write');};
 try {fails(()=>f.journal.persist(f.expected,f.bytes));}finally{fs.writeFileSync=original;}
 fails(()=>f.journal.read(f.expected));assert.equal(fs.existsSync(f.file),false);
 const names=fs.readdirSync(f.options.directory);assert.equal(names.length,1);
 assert.equal(names[0].startsWith('.pending-'),true);
 assert.equal(fs.statSync(join(f.options.directory,names[0])).mode&0o777,0o600);
 // Only retained original bytes permit a new candidate; no orphan is promoted.
 f.journal.persist(f.expected,f.bytes);assert.deepEqual(f.journal.read(f.expected).bytes,f.bytes);
});
