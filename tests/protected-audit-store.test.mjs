import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {GitAppStateService} from '../server/git-store/store.mjs';
import {GitStorage} from '../server/git-store/storage.ts';
import {canonical} from '../server/git-store/schema.mjs';
import {protectLegacyAuditLog,restoreProtectedAuditLog,verifyProtectedAuditCore} from '../server/git-store/protected-audit.mjs';

test('private historical audit metadata survives signed Git replay, authorized restore and redacted IStorage view', async t=>{
 const root=await mkdtemp(join(tmpdir(),'forgeproof-audit-private-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const dir=join(root,'private.git');
 execFileSync('git',['init','--bare',dir],{stdio:'ignore'});
 const keys=generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 const signer={actor:'test-audit',keyId:'test-audit-signer',sign:async bytes=>sign(null,bytes,keys.privateKey).toString('base64')};
 const opts={directory:dir,tenant:'tenant-audit',repository:'evidence',trust:{eventKeys:{'test-audit-signer':{actor:signer.actor,publicKey:keys.publicKey}},receiptKeys:[],receiptPredecessor:null},checkpoint:null,signer};
 const service=new GitAppStateService(opts), key=randomBytes(32);
 const original=Buffer.from('\n '+JSON.stringify({id:14,userId:'synthetic-owner',action:'view',resourceType:'fixture',resourceId:'synthetic-14',metadata:{payload:'PRIVATE_AUDIT_SENTINEL_RECORD'},ipAddress:null,createdAt:'2026-11-07T21:00:00.000Z'},null,2)+'\n');
 const sealed=protectLegacyAuditLog(original,opts.tenant,opts.repository,key);
 assert.equal(verifyProtectedAuditCore(sealed).id,14);
 const tx={idempotencyKey:'private-audit-14',operations:[
  {kind:'users',id:'synthetic-owner',action:'put',expectedVersion:null,record:{id:'synthetic-owner',email:'fixture@example.invalid'}},
  {kind:'auditLogs',id:14,action:'put',expectedVersion:null,record:sealed}
 ]};
 const proof=await service.append(tx);
 assert.equal((await service.append(tx)).duplicate,true);
 const state=await service.replay();
 assert.equal(state.events.length,1);
 assert.deepEqual(restoreProtectedAuditLog(state.records.auditLogs[14],opts.tenant,opts.repository,key),original);
 const raw=await service.git(['show',proof.checkpoint.commit+':event.json']);
 assert.doesNotMatch(raw,/PRIVATE_AUDIT_SENTINEL_RECORD/);
 const storage=new GitStorage(service,'synthetic-owner',['synthetic-owner'],'synthetic-owner');
 const rows=await storage.getAuditLogs('synthetic-owner');
 assert.equal(rows.length,1);
 assert.equal(rows[0].metadata,null);
 const authorized=new GitStorage(service,'synthetic-owner',['synthetic-owner'],'synthetic-owner',undefined,'',undefined,key);
 assert.deepEqual((await authorized.getAuthorizedAuditLogs('synthetic-owner'))[0].metadata,{payload:'PRIVATE_AUDIT_SENTINEL_RECORD'});
 await assert.rejects(authorized.getAuthorizedAuditLogs('other-user'),/access denied/);
 assert.equal((await storage.getAuthorizedAuditLogs('synthetic-owner'))[0].metadataVisibility,'protected_unavailable');
 assert.equal(rows[0].action,'view');
 assert.equal(rows[0].resourceId,'synthetic-14');
 assert.equal('encryption' in rows[0],false);
 assert.equal((await storage.getAuditLogsByResource('fixture','synthetic-14')).length,1);
 const clone=join(root,'clone.git');
 execFileSync('git',['clone','--mirror',dir,clone],{stdio:'ignore'});
 const read=new GitAppStateService({...opts,directory:clone,checkpoint:proof.checkpoint,signer:undefined});
 const replay=await read.replay();
 assert.equal(replay.events.length,1);
 assert.deepEqual(restoreProtectedAuditLog(replay.records.auditLogs[14],opts.tenant,opts.repository,key),original);
 assert.throws(()=>restoreProtectedAuditLog(replay.records.auditLogs[14],'wrong-tenant',opts.repository,key),/Decryption failed/);
 const newOriginal=Buffer.from(JSON.stringify({id:15,userId:'synthetic-owner',action:'view',resourceType:'fixture',resourceId:'synthetic-15',metadata:{payload:'NEXT'},ipAddress:null,createdAt:'2026-11-07T21:00:00.000Z'}));
 const changed=protectLegacyAuditLog(newOriginal,opts.tenant,opts.repository,key);
 changed.encryption.ciphertext=Buffer.from('INVALID').toString('base64');
 await assert.rejects(service.append({idempotencyKey:'tampered-audit',operations:[{kind:'auditLogs',id:15,action:'put',expectedVersion:null,record:changed}]}),/ciphertext hash mismatch/);
 assert.equal((await service.replay()).events.length,1);
 // A tampered auditCore is rejected by signed replay BEFORE the IStorage read
 // model would parse it. Use a disposable clone; never mutate original evidence.
 const maliciousDir=join(root,'malicious.git');
 execFileSync('git',['clone','--mirror',dir,maliciousDir],{stdio:'ignore'});
 const attacker=new GitAppStateService({...opts,directory:maliciousDir,checkpoint:null,signer:undefined});
 const rawEvent=await attacker.git(['show',proof.checkpoint.commit+':event.json']);
 const forged=JSON.parse(rawEvent);
 forged.body.operations.find(o=>o.kind==='auditLogs').record.auditCore='{broken_json';
 const blob=await attacker.git(['hash-object','-w','--stdin'],canonical(forged));
 const tree=await attacker.git(['mktree'],'100644 blob '+blob+'\tevent.json\n');
 const fakeCommit=await attacker.git(['commit-tree',tree],'forged history');
 await attacker.git(['update-ref',attacker.ref,fakeCommit,proof.checkpoint.commit]);
 const denied=new GitStorage(new GitAppStateService({...opts,directory:maliciousDir,checkpoint:proof.checkpoint,signer:undefined}),
   'synthetic-owner',['synthetic-owner'],'synthetic-owner');
 await assert.rejects(denied.getAuditLogs('synthetic-owner'),/checkpoint|signature|rollback|history/i);
});
