import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { GitAppStateService } from '../server/git-store/store.mjs';
import {GitStorage} from '../server/git-store/storage.ts';
import { hash } from '../server/git-store/schema.mjs';
import { protectLegacyReceipt, restoreProtectedReceipt, verifyProtectedReceiptCore } from '../server/git-store/protected-receipt.mjs';

test('protected historical receipts verify keylessly in signed Git replay, recover exactly, and reject tampering', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forgeproof-0b-protected-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const bare = join(root,'private.git');
  execFileSync('git',['init','--bare',bare],{stdio:'ignore'});
  const keys = generateKeyPairSync('ed25519', {
    publicKeyEncoding: {type:'spki', format:'pem'},
    privateKeyEncoding: {type:'pkcs8',format:'pem'}
  });
  const publicKey = keys.publicKey.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g,'');
  const signer = {actor:'synthetic-writer',keyId:'synthetic-event-key',sign:async data=>sign(null,data,keys.privateKey).toString('base64')};
  const trust = {eventKeys:{'synthetic-event-key':{actor:signer.actor,publicKey:keys.publicKey}},receiptKeys:[publicKey],receiptPredecessor:null};
  const scope = {directory:bare,tenant:'tenant-alpha',repository:'private-evidence',trust,checkpoint:null,signer};
  const service = new GitAppStateService(scope);
  const vaultKey=randomBytes(32);
  const timestamp='2026-11-07T21:00:00.000Z';
  const make=(id,prev,secret) => {
    const receipt={id,userId:'synthetic-user',fileName:'fictional.ts',filePath:'src/fictional.ts',
      fileHash:'sha256:'+'a'.repeat(64),modelName:'fixture-unattributed',modelProvider:'fixture-provider',
      countryOfOrigin:'unknown',prevEntryHash:prev,signedAt:timestamp,createdAt:timestamp,
      receiptVersion:'v1',publicKey,metadata:{'synthetic-private':secret},auditDetails:'audit-'+secret};
    receipt.entryHash=hash([receipt.fileHash,receipt.modelName,receipt.modelProvider,receipt.countryOfOrigin,prev||'genesis',timestamp].join('|'));
    receipt.signature=sign(null,Buffer.from([receipt.entryHash,receipt.fileHash,timestamp].join('|')),keys.privateKey).toString('base64');
    return receipt;
  };
  const r1=make(101,null,'PHASE5_SENTINEL_SECRET_A');
  const r2=make(102,r1.entryHash,'PHASE5_SENTINEL_SECRET_B');
  const original1=Buffer.from(JSON.stringify(r1,null,2)+'\n');
  const original2=Buffer.from('\n '+JSON.stringify(r2,null,2)+'\n');
  const protected1=protectLegacyReceipt(original1,scope.tenant,scope.repository,vaultKey);
  const protected2=protectLegacyReceipt(original2,scope.tenant,scope.repository,vaultKey);
  const put=record=>({kind:'receipts',id:record.id,action:'put',expectedVersion:null,record});
  const tx1={idempotencyKey:'historical-101',operations:[
    {kind:'users',id:'synthetic-user',action:'put',expectedVersion:null,record:{id:'synthetic-user',email:'synthetic@example.invalid'}},
    put(protected1)
  ]};
  const result1=await service.append(tx1);
  assert.equal((await service.append(tx1)).duplicate,true);
  const result2=await service.append({idempotencyKey:'historical-102',operations:[put(protected2)]});
  const current=await service.replay();
  assert.equal(current.events.length,2);
  assert.equal(current.receiptHead,r2.entryHash);
  const storage=new GitStorage(service,'synthetic-user',['synthetic-user'],'synthetic-user');
  const safeReceipts=await storage.getAttestations('synthetic-user');
  assert.deepEqual(safeReceipts.map(r=>r.id),[102,101]);
  assert.equal(safeReceipts[0].metadata,null);
  assert.equal(safeReceipts[0].auditDetails,null);
  assert.equal('encryption' in safeReceipts[0],false);
  assert.equal(current.records.receipts[101].original,undefined);
  assert.equal(verifyProtectedReceiptCore(current.records.receipts[102]).entryHash,r2.entryHash);
  assert.deepEqual(restoreProtectedReceipt(current.records.receipts[101],scope.tenant,scope.repository,vaultKey),original1);
  assert.deepEqual(restoreProtectedReceipt(current.records.receipts[102],scope.tenant,scope.repository,vaultKey),original2);
  for(const checkpoint of [result1.checkpoint,result2.checkpoint]){
    const event=await service.git(['show',checkpoint.commit+':event.json']);
    assert.doesNotMatch(event,/PHASE5_SENTINEL_SECRET_/);
    assert.doesNotMatch(event,/"synthetic-private"/);
  }
  const clone=join(root,'disconnected.git');
  execFileSync('git',['clone','--mirror',bare,clone],{stdio:'ignore'});
  const independent=new GitAppStateService({...scope,directory:clone,checkpoint:result2.checkpoint,signer:undefined});
  const cloned=await independent.replay();
  assert.equal(cloned.events.length,2);
  assert.equal(cloned.receiptHead,r2.entryHash);
  assert.deepEqual(restoreProtectedReceipt(cloned.records.receipts[101],scope.tenant,scope.repository,vaultKey),original1);
  assert.throws(()=>restoreProtectedReceipt(cloned.records.receipts[101],scope.tenant,scope.repository,randomBytes(32)),/Decryption failed/);
  assert.throws(()=>restoreProtectedReceipt(cloned.records.receipts[101],'another-tenant',scope.repository,vaultKey),/Decryption failed/);
  const protected3=protectLegacyReceipt(Buffer.from(JSON.stringify(make(103,r2.entryHash,'SYNTHETIC_UNCOMMITTED'))),scope.tenant,scope.repository,vaultKey);
  const changed=structuredClone(protected3);
  changed.originalCore=JSON.stringify({...JSON.parse(changed.originalCore),modelProvider:'forged-model'});
  await assert.rejects(service.append({idempotencyKey:'altered-signed',operations:[put(changed)]}),/Invalid historical receipt/);
  const changedCipher=structuredClone(protected3);
  changedCipher.encryption.ciphertext=Buffer.from('malicious-change').toString('base64');
  await assert.rejects(service.append({idempotencyKey:'altered-ciphertext',operations:[put(changedCipher)]}),/hash mismatch/);
  const badParent=make(104,'f'.repeat(64),'SYNTHETIC');
  const protectedBadParent=protectLegacyReceipt(Buffer.from(JSON.stringify(badParent)),scope.tenant,scope.repository,vaultKey);
  await assert.rejects(service.append({idempotencyKey:'altered-parent',operations:[put(protectedBadParent)]}),/predecessor mismatch/);
  assert.equal((await service.replay()).events.length,2);
});
