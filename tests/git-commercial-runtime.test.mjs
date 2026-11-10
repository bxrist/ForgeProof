import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {generateKeyPairSync,sign,createHash,randomBytes} from 'node:crypto';
import {GitAppStateService} from '../server/git-store/store.mjs';
import {GitStorage} from '../server/git-store/storage.ts';

test('built commercial server starts, authenticates, issues and replays signed Git receipts without PostgreSQL or Stripe', {timeout:90000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'forgeproof-commercial-git-'));
  let child;
  async function stop() {
    if (!child || child.exitCode!==null) return;
    const process=child;
    await new Promise(resolve=>{process.once('exit',resolve);process.kill('SIGTERM');});
  }
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});
  const directory=join(root,'state.git');
  execFileSync('git',['init','--bare',directory],{stdio:'ignore'});
  const keys=generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  const publicKey=keys.publicKey.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g,'');
  const token='fixture_'+randomBytes(24).toString('hex');
  const tokenHash=createHash('sha256').update(token).digest('hex');
  const signer={actor:'fixture',keyId:'fixture',sign:async b=>sign(null,b,keys.privateKey).toString('base64')};
  const trust={eventKeys:{fixture:{actor:'fixture',publicKey:keys.publicKey}},receiptKeys:[publicKey],receiptPredecessor:null};
  const service=new GitAppStateService({directory,tenant:'fixture',repository:'app',checkpoint:null,signer,trust});
  await service.append({idempotencyKey:'fixture-bootstrap',operations:[
    {kind:'users',id:'fixture-user',action:'put',expectedVersion:null,record:{id:'fixture-user'}},
    {kind:'apiKeys',id:1,action:'put',expectedVersion:null,record:{id:1,userId:'fixture-user',name:'fixture',credentialRef:'custodian:fixture',
      isActive:true,permissions:['attest:read','attest:write'],expiresAt:new Date(Date.now()+3600000).toISOString()}},
    {kind:'subscriptions',id:1,action:'put',expectedVersion:null,record:{id:1,userId:'fixture-user',plan:'free',status:'active',
      attestationLimit:100,attestationCount:0,apiKeyLimit:5,currentPeriodStart:new Date().toISOString()}},
  ]});
  const signerModule=join(root,'resources.mjs');
  // Disposable synthetic custody fixture. No actual customer or operator material.
  await writeFile(signerModule,`import {sign} from 'node:crypto';
export const signer={actor:'fixture',keyId:'fixture',sign:async b=>sign(null,b,${JSON.stringify(keys.privateKey)}).toString('base64')};
export const custody={matches:async(s,r,h)=>r==='custodian:fixture'&&h===${JSON.stringify(tokenHash)}};
export const receiptEncryptionKey=Buffer.from('${randomBytes(32).toString('base64')}','base64');
export const auditEncryptionKey=Buffer.from('${randomBytes(32).toString('base64')}','base64');
export const mailEncryptionKey=Buffer.from('${randomBytes(32).toString('base64')}','base64');`,{mode:0o600});
  const config=join(root,'config.json');
  await writeFile(config,JSON.stringify({directory,tenant:'fixture',repository:'app',checkpoint:(await service.replay()).checkpoint,
    trust,guardUserId:'fixture-user',signerModule}),{mode:0o600});
  const listener=createServer(); await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const env={PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',PORT:String(port),
    FORGEPROOF_GIT_CONFIG:config,
    FORGEPROOF_ED25519_PRIVATE_KEY_PEM:keys.privateKey,FORGEPROOF_ED25519_PUBLIC_KEY_PIN:publicKey};
  for(const name of Object.keys(process.env)) if(name.startsWith('CLERK_')) env[name]=process.env[name];
  const base=`http://127.0.0.1:${port}`;
  async function start() {
    child=spawn(process.execPath,[resolve('dist/index.cjs')],{env,stdio:['ignore','pipe','pipe']});
    child.stdout.resume();child.stderr.resume();
    for(let i=0;i<100;i++){
      if(child.exitCode!==null) throw new Error('Commercial Git server exited during startup');
      try {const response=await fetch(base+'/api/verify/chain');if(response.ok)return;}
      catch {}
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    throw new Error('Commercial Git server did not become ready');
  }
  await start();
  const body={file_path:'synthetic-fixture.ts',file_hash:'a'.repeat(64),model_name:'fixture',model_provider:'fixture',country_of_origin:'US'};
  const denied=await fetch(base+'/api/v1/attest',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal(denied.status,401);
  const response=await fetch(base+'/api/v1/attest',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(body)});
  assert.equal(response.status,201);
  const receipt=await response.json();
  assert.equal(receipt.id,1);
  assert.equal((await service.replay()).records.subscriptions[1].attestationCount,1);
  await stop();await start();
  const chain=await (await fetch(base+'/api/verify/chain')).json();
  assert.equal(chain.chainIntegrity,true);
  assert.equal(chain.entries.length,1);
  assert.equal(chain.entries[0].entryHash,receipt.entryHash);
  assert.equal(chain.entries[0].signatureValid,true);
  assert.equal(chain.entries[0].gitLedgerStatus,'in_git');
  const historical={...receipt,id:2,userId:'historical-orphan',prevEntryHash:receipt.entryHash,
    signedAt:new Date().toISOString()};
  historical.entryHash=createHash('sha256').update([historical.fileHash,historical.modelName,
    historical.modelProvider,historical.countryOfOrigin,historical.prevEntryHash,historical.signedAt].join('|')).digest('hex');
  historical.signature=sign(null,Buffer.from([historical.entryHash,historical.fileHash,historical.signedAt].join('|')),keys.privateKey).toString('base64');
  await service.append({idempotencyKey:'fixture-historical-orphan',operations:[
    {kind:'receipts',id:2,action:'put',expectedVersion:null,record:{id:2,original:JSON.stringify(historical)}}]});
  const publicHistory=await (await fetch(base+'/api/verify/chain')).json();
  assert.equal(publicHistory.chainIntegrity,true);
  assert.equal(publicHistory.totalEntries,2);
  const orphanContext=new GitStorage(service,'historical-orphan',['fixture-user','historical-orphan'],'fixture-user',
    undefined,'',undefined,undefined,undefined,true);
  await assert.rejects(orphanContext.ensureUser('historical-orphan'),/read-only/);
  assert.equal((await service.replay()).records.users['historical-orphan'],undefined);
  const mcp=await fetch(base+'/api/mcp/tools',{method:'POST',
    headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
    body:JSON.stringify({tool:'forgeproof_attest',arguments:body})});
  assert.equal(mcp.status,200,await mcp.text());
  const withMcp=await (await fetch(base+'/api/verify/chain')).json();
  assert.equal(withMcp.totalEntries,3);
  assert.equal(withMcp.chainIntegrity,true);
  assert.ok(withMcp.entries.every(entry=>entry.signatureValid));
  assert.equal((await service.replay()).records.subscriptions[1].attestationCount,2);
  // An independently supplied pin must survive a process restart and reject
  // a rewind. This does not stand in for a production checkpoint custodian.
  const current=(await service.replay()).checkpoint;
  const settings=JSON.parse(await (await import('node:fs/promises')).readFile(config,'utf8'));
  const baseline=settings.checkpoint;
  await stop();
  await writeFile(config,JSON.stringify({...settings,checkpoint:current}),{mode:0o600});
  execFileSync('git',['--git-dir',directory,'update-ref','refs/heads/forgeproof/fixture/app',baseline.commit],{stdio:'ignore'});
  await assert.rejects(start(),/exited during startup/);
});
