import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  sign as ed25519Sign,
  generateKeyPairSync,
} from 'node:crypto';
import {
  protectLegacyReceipt,
  verifyProtectedReceiptCore,
  restoreProtectedReceipt,
} from '../server/git-store/protected-receipt.mjs';
import {
  protectLegacyAuditLog,
  verifyProtectedAuditCore,
  restoreProtectedAuditLog,
} from '../server/git-store/protected-audit.mjs';

function sha256(data) {
  return 'sha256:' + createHash('sha256').update(data).digest('hex');
}

function receiptHmac(key, bytes) {
  const subkey = hkdfSync(
    'sha256',
    key,
    Buffer.from('ForgeProof/protected-receipt/hkdf-salt/v3', 'utf8'),
    Buffer.from('ForgeProof/protected-receipt/plaintext-hmac/v3', 'utf8'),
    32,
  );
  return 'hmac-sha256:' + createHmac('sha256', subkey).update(bytes).digest('hex');
}

function auditHmac(key, bytes) {
  const subkey = hkdfSync(
    'sha256',
    key,
    Buffer.from('ForgeProof/protected-audit/hkdf-salt/v3', 'utf8'),
    Buffer.from('ForgeProof/protected-audit/plaintext-hmac/v3', 'utf8'),
    32,
  );
  return 'hmac-sha256:' + createHmac('sha256', subkey).update(bytes).digest('hex');
}

function makeSignedReceiptWithMetadata(privateMetadata = { classification: 'internal' }) {
  // Use the ACTUAL v1 ForgeProof receipt signature/hash fields and a real
  // Ed25519 signature. Fabricated sourceSignature/tenantId would bypass the
  // product's strict validateReceipt and prove nothing.
  const pair = generateKeyPairSync('ed25519');
  const t='2026-11-08T00:00:00.000Z',fh='sha256:'+'a'.repeat(64);
  const row={
    id:13,userId:'synthetic-user',orgId:null,repositoryId:null,
    fileName:'fixture.ts',filePath:'src/fixture.ts',fileHash:fh,
    modelName:'synthetic-model',modelProvider:'synthetic-provider',
    countryOfOrigin:'unknown',detectedCountry:null,complianceStatus:'unverified',
    attestationType:'origin',parentAttestationId:null,auditVerdict:null,
    auditDetails:{stage:'test'},metadata:privateMetadata,
    prevEntryHash:null,entryHash:'',signature:'',
    publicKey:pair.publicKey.export({type:'spki',format:'der'}).toString('base64'),
    receiptVersion:'v1',signedAt:t,createdAt:t,
    gitCommitUrl:null,gitCommitMessage:null
  };
  row.entryHash=createHash('sha256').update(
    [fh,row.modelName,row.modelProvider,row.countryOfOrigin,'genesis',t].join('|')
  ).digest('hex');
  row.signature=ed25519Sign(null,Buffer.from([row.entryHash,fh,t].join('|')),
    pair.privateKey).toString('base64');
  return {original:JSON.stringify(row),entryHash:row.entryHash};
}

function buildV2ReceiptFixture(originalBytes, tenant, repository, key) {
  const parsed = JSON.parse(originalBytes.toString('utf8'));
  const core = JSON.stringify({ ...parsed, metadata: null, auditDetails: null });
  const entryHash = parsed.entryHash;
  const nonce = randomBytes(12);
  const aad = Buffer.from(JSON.stringify(['ForgeProof-protected-receipt-v2', tenant, repository, parsed.id, entryHash]), 'utf8');
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(originalBytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    id: parsed.id,
    originalCore: core,
    encryption: {
      version: 2,
      algorithm: 'aes-256-gcm',
      nonce: nonce.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      ciphertextSha256: sha256(ciphertext),
      plaintextSha256: sha256(originalBytes),
    },
  };
}

function buildV2AuditFixture(originalBytes, tenant, repository, key) {
  const parsed = JSON.parse(originalBytes.toString('utf8'));
  const core = JSON.stringify({ ...parsed, metadata: null });
  const coreSha = sha256(Buffer.from(core, 'utf8'));
  const nonce = randomBytes(12);
  const aad = Buffer.from(JSON.stringify(['ForgeProof-protected-audit-v2', tenant, repository, parsed.id, coreSha]), 'utf8');
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(originalBytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    id: parsed.id,
    auditCore: core,
    encryption: {
      version: 2,
      algorithm: 'aes-256-gcm',
      nonce: nonce.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      ciphertextSha256: sha256(ciphertext),
      plaintextSha256: sha256(originalBytes),
    },
  };
}

test('v3 receipt does not leak plaintext hash and resists dictionary comparison', () => {
  const key = randomBytes(32);
  const { original } = makeSignedReceiptWithMetadata({ classification: 'private-low' });
  const originalBytes = Buffer.from(original, 'utf8');
  const protectedRecord = protectLegacyReceipt(originalBytes, 'tenant-a', 'repo-a', key);

  assert.equal(protectedRecord.encryption.version, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(protectedRecord.encryption, 'plaintextSha256'), false);
  assert.match(protectedRecord.encryption.plaintextHmac, /^hmac-sha256:[0-9a-f]{64}$/);

  const attackerGuessA = JSON.stringify({ ...JSON.parse(protectedRecord.originalCore), metadata: { classification: 'private-low' }, auditDetails: { stage: 'test' } });
  const attackerGuessB = JSON.stringify({ ...JSON.parse(protectedRecord.originalCore), metadata: { classification: 'private-high' }, auditDetails: { stage: 'test' } });
  const guessShaA = sha256(Buffer.from(attackerGuessA, 'utf8'));
  const guessShaB = sha256(Buffer.from(attackerGuessB, 'utf8'));
  assert.notEqual(guessShaA, guessShaB);
  assert.equal(protectedRecord.encryption.plaintextHmac.includes(guessShaA.slice(7, 20)), false);
  assert.equal(protectedRecord.encryption.plaintextHmac.includes(guessShaB.slice(7, 20)), false);
  assert.equal(JSON.stringify(protectedRecord).includes('private-low'), false);
  assert.equal(JSON.stringify(protectedRecord).includes('private-high'), false);

  const restored = restoreProtectedReceipt(protectedRecord, 'tenant-a', 'repo-a', key);
  assert.equal(Buffer.compare(restored, originalBytes), 0);
  assert.equal(protectedRecord.encryption.plaintextHmac, receiptHmac(key, originalBytes));
});

test('v3 audit envelope does not expose plaintext SHA and restores exact metadata', () => {
  const key = randomBytes(32);
  const original = Buffer.from(JSON.stringify({
    id: 77,
    userId: 'u1',
    action: 'classify',
    resourceType: 'doc',
    resourceId: 'd1',
    metadata: { sensitivity: 'restricted-low' },
    ipAddress: '203.0.113.7',
    createdAt: '2026-11-08T00:00:00.000Z',
  }), 'utf8');

  const protectedRecord = protectLegacyAuditLog(original, 'tenant-a', 'repo-a', key);
  assert.equal(protectedRecord.encryption.version, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(protectedRecord.encryption, 'plaintextSha256'), false);
  assert.match(protectedRecord.encryption.plaintextHmac, /^hmac-sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(protectedRecord).includes('restricted-low'), false);

  const restored = restoreProtectedAuditLog(protectedRecord, 'tenant-a', 'repo-a', key);
  assert.equal(Buffer.compare(restored, original), 0);
  assert.equal(protectedRecord.encryption.plaintextHmac, auditHmac(key, original));
});

test('legacy v2 receipt and audit fixtures still verify and restore', () => {
  const key = randomBytes(32);
  const receiptBytes = Buffer.from(makeSignedReceiptWithMetadata({ classification: 'legacy' }).original, 'utf8');
  const v2Receipt = buildV2ReceiptFixture(receiptBytes, 'tenant-a', 'repo-a', key);
  const rv = verifyProtectedReceiptCore(v2Receipt);
  assert.equal(rv.entryHash, JSON.parse(receiptBytes.toString('utf8')).entryHash);
  assert.equal(Buffer.compare(restoreProtectedReceipt(v2Receipt, 'tenant-a', 'repo-a', key), receiptBytes), 0);

  const auditBytes = Buffer.from(JSON.stringify({
    id: 9,
    userId: 'legacy-u',
    action: 'legacy_action',
    resourceType: 'legacy',
    resourceId: 'r9',
    metadata: { level: 'v2' },
    ipAddress: '203.0.113.55',
    createdAt: '2026-11-08T00:00:00.000Z',
  }), 'utf8');
  const v2Audit = buildV2AuditFixture(auditBytes, 'tenant-a', 'repo-a', key);
  const av = verifyProtectedAuditCore(v2Audit);
  assert.equal(av.id, 9);
  assert.equal(Buffer.compare(restoreProtectedAuditLog(v2Audit, 'tenant-a', 'repo-a', key), auditBytes), 0);
});

test('mixed version fields and tampering are rejected', () => {
  const key = randomBytes(32);
  const receiptBytes = Buffer.from(makeSignedReceiptWithMetadata({ classification: 'x' }).original, 'utf8');
  const record = protectLegacyReceipt(receiptBytes, 'tenant-a', 'repo-a', key);

  const mixed = {
    ...record,
    encryption: {
      ...record.encryption,
      plaintextSha256: sha256(receiptBytes),
    },
  };
  assert.throws(() => verifyProtectedReceiptCore(mixed), /Invalid encryption fields/);

  const missing = {
    ...record,
    encryption: { ...record.encryption },
  };
  delete missing.encryption.plaintextHmac;
  assert.throws(() => verifyProtectedReceiptCore(missing), /Invalid encryption fields/);

  const wrongTenant = () => restoreProtectedReceipt(record, 'tenant-b', 'repo-a', key);
  assert.throws(wrongTenant, /Decryption failed/);

  const tampered = {
    ...record,
    encryption: {
      ...record.encryption,
      ciphertext: Buffer.from(Buffer.from(record.encryption.ciphertext, 'base64').map((v, i) => (i === 0 ? (v ^ 1) : v))).toString('base64'),
    },
  };
  assert.throws(() => verifyProtectedReceiptCore(tampered), /ciphertext hash mismatch/);
});

test('signed event chain remains byte-stable for v3 protected payloads', () => {
  const key = randomBytes(32);
  const signing = generateKeyPairSync('ed25519');

  const receiptBytes = Buffer.from(makeSignedReceiptWithMetadata({ classification: 'chain-private' }).original, 'utf8');
  const record = protectLegacyReceipt(receiptBytes, 'tenant-a', 'repo-a', key);

  const eventA = { type: 'private_receipt', payload: record };
  const eventABytes = Buffer.from(JSON.stringify(eventA), 'utf8');
  const sigA = ed25519Sign(null, eventABytes, signing.privateKey).toString('base64');

  const restored = restoreProtectedReceipt(record, 'tenant-a', 'repo-a', key);
  assert.equal(Buffer.compare(restored, receiptBytes), 0);

  const eventB = { type: 'private_receipt', payload: record, previousSignature: sigA };
  const eventBBytes = Buffer.from(JSON.stringify(eventB), 'utf8');
  const sigB = ed25519Sign(null, eventBBytes, signing.privateKey).toString('base64');

  assert.notEqual(sigA, sigB);
  assert.equal(typeof sigA, 'string');
  assert.equal(typeof sigB, 'string');
});


test('actual signed private Git stream accepts historical v2 and new v3 receipts and audit records with intact trust, owner and predecessor',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {execFileSync}=await import('node:child_process');
 const {GitAppStateService}=await import('../server/git-store/store.mjs');
 const root=await mkdtemp(join(tmpdir(),'fp-v2-v3-signed-chain-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=join(root,'private.git');
 execFileSync('git',['init','--bare',directory],{stdio:'ignore'});
 const eventKeys=generateKeyPairSync('ed25519');
 const receiptKeys=generateKeyPairSync('ed25519');
 const receiptPublic=receiptKeys.publicKey.export({type:'spki',format:'der'}).toString('base64');
 const trust={eventKeys:{'synthetic-event-key':{actor:'synthetic-event-actor',
   publicKey:eventKeys.publicKey.export({type:'spki',format:'pem'})}},
   receiptKeys:[receiptPublic],receiptPredecessor:null};
 const opts={directory,tenant:'synthetic-tenant',repository:'synthetic-repo',
   trust,checkpoint:null,signer:{actor:'synthetic-event-actor',keyId:'synthetic-event-key',
     sign:async b=>ed25519Sign(null,b,eventKeys.privateKey).toString('base64')}};
 const service=new GitAppStateService(opts);
 const key=randomBytes(32);
 await service.append({idempotencyKey:'bootstrap-synthetic-user',operations:[{
   kind:'users',id:'synthetic-user',action:'put',expectedVersion:null,record:{id:'synthetic-user'}
 }]});
 function receipt(id,prev,privateValue) {
   const timestamp='2026-11-08T00:00:00.000Z',fileHash='sha256:'+'a'.repeat(64);
   const row={id,userId:'synthetic-user',orgId:null,repositoryId:null,
     fileName:'test.ts',filePath:'src/test.ts',fileHash,modelName:'fixture-model',
     modelProvider:'fixture-provider',countryOfOrigin:'unknown',
     detectedCountry:null,complianceStatus:'unverified',attestationType:'origin',
     parentAttestationId:null,auditVerdict:null,
     auditDetails:{privateSentinel:'synthetic-private-audit-only'},
     metadata:{classification:privateValue},
     signature:'',publicKey:receiptPublic,prevEntryHash:prev,entryHash:'',
     receiptVersion:'v1',signedAt:timestamp,createdAt:timestamp,gitCommitUrl:null,gitCommitMessage:null};
   row.entryHash=createHash('sha256').update([row.fileHash,row.modelName,row.modelProvider,
     row.countryOfOrigin,prev??'genesis',timestamp].join('|')).digest('hex');
   row.signature=ed25519Sign(null,Buffer.from([row.entryHash,row.fileHash,timestamp].join('|')),
     receiptKeys.privateKey).toString('base64');
   return row;
 }
 const r2=receipt(13,null,'version2-private-low');
 const r3=receipt(14,r2.entryHash,'version3-private-high');
 const v2=buildV2ReceiptFixture(Buffer.from(JSON.stringify(r2)),
   opts.tenant,opts.repository,key);
 const v3=protectLegacyReceipt(Buffer.from(JSON.stringify(r3)),
   opts.tenant,opts.repository,key);
 assert.equal(v2.encryption.version,2);
 assert.equal(v3.encryption.version,3);
 for (const [i,protectedReceipt] of [v2,v3].entries()) {
   const current=await service.replay();
   await service.append({idempotencyKey:'receipt-mixed-'+i,operations:[{
     kind:'receipts',id:protectedReceipt.id,action:'put',
     expectedVersion:null,record:protectedReceipt
   }]});
   assert.equal((await service.replay()).receiptHead,(i===0?r2:r3).entryHash);
 }
 function audit(id,version) {
   return {id,userId:'synthetic-user',action:'classify',resourceType:'test-doc',
     resourceId:'synthetic-test',metadata:{classification:'PRIVATE_AUDIT_'+version},
     ipAddress:null,createdAt:'2026-11-08T00:00:00.000Z'};
 }
 const a2=buildV2AuditFixture(Buffer.from(JSON.stringify(audit(1,'V2'))),
   opts.tenant,opts.repository,key);
 const a3=protectLegacyAuditLog(Buffer.from(JSON.stringify(audit(2,'V3'))),
   opts.tenant,opts.repository,key);
 for(const [i,record] of [a2,a3].entries()) {
   await service.append({idempotencyKey:'audit-mixed-'+i,operations:[{
      kind:'auditLogs',id:record.id,action:'put',expectedVersion:null,record
   }]});
 }
 const accepted=await service.replay();
 assert.equal(accepted.receiptHead,r3.entryHash);
 assert.deepEqual(Object.keys(accepted.records.receipts).sort(),['13','14']);
 assert.equal(accepted.records.receipts[13].originalCore.includes('version2-private-low'),false);
 assert.equal(accepted.records.receipts[14].encryption.plaintextSha256,undefined);
 assert.equal(accepted.records.auditLogs[2].encryption.plaintextSha256,undefined);
 for(const value of ['version2-private-low','version3-private-high',
   'synthetic-private-audit-only','PRIVATE_AUDIT_V2','PRIVATE_AUDIT_V3'])
   assert.equal(JSON.stringify(accepted.events).includes(value),false,value);
 const mirror=join(root,'independent.git');
 execFileSync('git',['clone','--mirror',directory,mirror],{stdio:'ignore'});
 const disconnected=new GitAppStateService({...opts,directory:mirror,
   signer:undefined,checkpoint:accepted.checkpoint});
 const restored=await disconnected.replay();
 assert.equal(restored.receiptHead,r3.entryHash);
 assert.deepEqual(restored.records,accepted.records);
 assert.equal(JSON.parse(restoreProtectedReceipt(restored.records.receipts[13],
   opts.tenant,opts.repository,key)).metadata.classification,'version2-private-low');
 assert.equal(JSON.parse(restoreProtectedReceipt(restored.records.receipts[14],
   opts.tenant,opts.repository,key)).metadata.classification,'version3-private-high');
 assert.equal(JSON.parse(restoreProtectedAuditLog(restored.records.auditLogs[1],
   opts.tenant,opts.repository,key)).metadata.classification,'PRIVATE_AUDIT_V2');
 assert.equal(JSON.parse(restoreProtectedAuditLog(restored.records.auditLogs[2],
   opts.tenant,opts.repository,key)).metadata.classification,'PRIVATE_AUDIT_V3');
 const wrongTrust=new GitAppStateService({...opts,directory:mirror,
   signer:undefined,checkpoint:accepted.checkpoint,trust:{...trust,receiptKeys:[]}});
 await assert.rejects(wrongTrust.replay(),/receipt key|Untrusted/i);
});
test('protected audit core enforces exact original schema, nonempty actions, null redactions and no unknown fields',()=>{
 const key=randomBytes(32),tenant='synthetic-tenant',repository='synthetic-repo';
 const row={id:1,userId:'synthetic-user',action:'audit',
   resourceType:'test',resourceId:'test',metadata:{private:'secret'},
   ipAddress:null,createdAt:'2026-11-08T00:00:00.000Z'};
 const record=protectLegacyAuditLog(Buffer.from(JSON.stringify(row)),tenant,repository,key);
 const invalid=[
  {...record,auditCore:JSON.stringify({...JSON.parse(record.auditCore),metadata:{private:'FORBIDDEN'}})},
  {...record,auditCore:JSON.stringify({...JSON.parse(record.auditCore),unknownField:'hidden'})},
  {...record,auditCore:JSON.stringify({...JSON.parse(record.auditCore),action:''})},
  {...record,auditCore:JSON.stringify({...JSON.parse(record.auditCore),userId:{bad:true}})},
 ];
 for(const forged of invalid)
   assert.throws(()=>verifyProtectedAuditCore(forged));
 const wrongOriginal={...row,unreviewedAttribute:'secret'};
 assert.throws(()=>protectLegacyAuditLog(Buffer.from(JSON.stringify(wrongOriginal)),tenant,repository,key),/fields/);
 assert.throws(()=>protectLegacyAuditLog(Buffer.from(JSON.stringify({...row,action:''})),tenant,repository,key),/action/);
});
