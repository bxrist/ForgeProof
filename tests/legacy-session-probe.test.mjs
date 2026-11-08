import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import {IncomingMessage,ServerResponse} from 'node:http';
import {Duplex} from 'node:stream';
import {randomBytes} from 'node:crypto';
import {LegacySessionContinuityProbe,SESSION_PROBE_STOP} from '../server/git-store/legacy-session-probe.ts';

const scope={tenantId:'synthetic',repositoryId:'probe'};
const instant=Date.parse('2026-01-01T00:00:00.000Z');
const expiry='2026-01-02T00:00:00.123Z';
const value=()=>({cookie:{expires:expiry,originalMaxAge:86400123,httpOnly:true,secure:false},
 passport:{user:{claims:{sub:'SYNTHETIC_UNTRUSTED_CLAIM'},token:'SYNTHETIC_TOKEN'}},nested:[null,false,1.25]});
const get=(store,sid='SYNTHETIC_SID')=>new Promise((resolve,reject)=>store.get(sid,(e,v)=>e?reject(e):resolve(v)));
const stop=(store,method,...args)=>new Promise(resolve=>store[method](...args,e=>{
 assert.equal(e.message,SESSION_PROBE_STOP);assert.equal(e.cause,undefined);resolve();
}));

test('scope-bound read preserves detached JSON and exact expiry; every mutation stops without writes',async()=>{
 const original=value(),calls=[];
 const reader={async readActive(s,sid){calls.push({s,sid});return {session:original,expiresAt:expiry};}};
 const store=new LegacySessionContinuityProbe(scope,reader,()=>instant);
 const recovered=await get(store);
 assert.deepEqual(recovered,original);
 recovered.passport.user.token='changed';assert.equal(original.passport.user.token,'SYNTHETIC_TOKEN');
 assert.deepEqual(calls,[{s:scope,sid:'SYNTHETIC_SID'}]);
 assert.equal(JSON.stringify(store).includes('SYNTHETIC_TOKEN'),false);
 assert.equal(JSON.stringify(store).includes('SYNTHETIC_SID'),false);
 for(const method of ['set','touch']) await stop(store,method,'SYNTHETIC_SID',original);
 await stop(store,'destroy','SYNTHETIC_SID');await stop(store,'clear');
 assert.equal(calls.length,1);
 assert.throws(()=>store.destroy('SYNTHETIC_SID'),{message:SESSION_PROBE_STOP});
});

test('fresh authority reads, expiry boundaries, revocation and cross-scope isolation',async()=>{
 let row={session:value(),expiresAt:expiry},reads=0;
 const reader={async readActive(s,sid){reads++;return s.repositoryId===scope.repositoryId&&sid==='SYNTHETIC_SID'?row:null;}};
 const store=new LegacySessionContinuityProbe(scope,reader,()=>instant);
 assert.ok(await get(store));row=null;assert.equal(await get(store),null);
 row={session:value(),expiresAt:new Date(instant).toISOString()};assert.equal(await get(store),null);
 row={session:value(),expiresAt:expiry};row.session.cookie.expires=new Date(instant).toISOString();
 assert.equal(await get(store),null);
 assert.equal(await get(new LegacySessionContinuityProbe({...scope,repositoryId:'other'},reader,()=>instant)),null);
 assert.equal(await get(store,'other-sid'),null);assert.equal(reads,6);
});

test('missing or malformed authority, serialization and backend errors fail with redacted errors',async()=>{
 assert.throws(()=>new LegacySessionContinuityProbe(scope,{}));
 for(const row of [undefined,{session:value(),expiresAt:'bad'},
  {session:{...value(),bad:undefined},expiresAt:expiry},
  {session:{...value(),bad:NaN},expiresAt:expiry},
  {session:{...value(),cookie:{}},expiresAt:expiry}]) {
  const store=new LegacySessionContinuityProbe(scope,{async readActive(){return row;}},()=>instant);
  await assert.rejects(get(store),e=>e.message==='Session continuity STOP: trusted legacy read failed'&&!e.cause);
 }
 const store=new LegacySessionContinuityProbe(scope,{async readActive(){throw new Error('SYNTHETIC_SID SYNTHETIC_TOKEN');}});
 await assert.rejects(get(store),e=>!e.message.includes('SYNTHETIC')&&!e.cause);
});

// Real middleware fixtures: signing/verification belongs exclusively to express-session.
async function fixture(t,store,secret,route) {
 const app=express();
 app.use(session({secret,store,resave:false,saveUninitialized:false,cookie:{maxAge:86400000}}));
 app.use(route);
 app.use((err,_req,res,_next)=>res.status(503).end('STOP'));
 return cookie=>new Promise((resolve,reject)=>{
  const chunks=[];
  const socket=new Duplex({read(){},write(chunk,_encoding,done){chunks.push(Buffer.from(chunk));done();}});
  const req=new IncomingMessage(socket);
  req.method='GET';req.url='/';req.headers=cookie?{cookie}:{};
  const res=new ServerResponse(req);res.useChunkedEncodingByDefault=false;res.assignSocket(socket);
  res.on('error',reject);res.on('finish',()=>{
   const raw=Buffer.concat(chunks).toString();
   resolve({status:res.statusCode,headers:res.getHeaders(),body:raw.slice(raw.indexOf('\r\n\r\n')+4)});
   socket.destroy();
  });
  app.handle(req,res);
 });
}

test('genuine middleware preserves original cookie SID and auth JSON; tampered/rotated secrets never read legacy',async t=>{
 const secret=randomBytes(32).toString('hex'),legacy=new session.MemoryStore();
 let originalSid,originalJson;
 const issue=await fixture(t,legacy,secret,(req,res)=>{
  req.session.passport=value().passport;originalSid=req.sessionID;
  req.session.save(err=>{if(err)throw err;legacy.get(originalSid,(_e,v)=>{originalJson=v;res.end('issued');});});
 });
 const issued=await issue(),cookie=issued.headers['set-cookie'][0].split(';')[0];
 let reads=0;
 const probe=new LegacySessionContinuityProbe(scope,{async readActive(s,sid){
  reads++;assert.deepEqual(s,scope);assert.equal(sid,originalSid);
  return {session:structuredClone(originalJson),expiresAt:originalJson.cookie.expires};
 }});
 const inspect=await fixture(t,probe,secret,(req,res)=>{
  // End-response touch is unsupported. Inspect before response, then explicitly
  // test the STOP and detach session to prevent automatic renewal in this probe.
  assert.equal(req.sessionID,originalSid);
  assert.deepEqual(req.session.passport,originalJson.passport);
  req.session.touch(); // changes request cookie only, never stored authority
  probe.touch(req.sessionID,req.session,err=>{
   assert.equal(err.message,SESSION_PROBE_STOP);req.session=null;res.end('compatible');
  });
 });
 const out=await inspect(cookie);assert.equal(out.body,'compatible');assert.equal(out.headers['set-cookie'],undefined);
 assert.equal(reads,1);
 const reject=await fixture(t,probe,secret,(req,res)=>{assert.equal(req.session.passport,undefined);req.session=null;res.end('anonymous');});
 assert.equal((await reject(cookie+'corrupt')).body,'anonymous');assert.equal(reads,1);
 const wrong=await fixture(t,probe,randomBytes(32).toString('hex'),(req,res)=>{assert.equal(req.session.passport,undefined);req.session=null;res.end('anonymous');});
 assert.equal((await wrong(cookie)).body,'anonymous');assert.equal(reads,1);
 const create=await fixture(t,probe,secret,(req,res)=>{req.session.newValue=true;req.session.save(err=>{
  assert.equal(err.message,SESSION_PROBE_STOP);req.session=null;res.status(503).end('STOP');
 });});
 assert.equal((await create()).status,503);assert.equal(reads,1);
});
