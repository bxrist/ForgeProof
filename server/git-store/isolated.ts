import express from 'express';
import { readFile, stat, realpath } from 'node:fs/promises';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { GitAppStateService, type Options } from './store.mjs';
import { GitStorage } from './storage';
import { insertRepositorySchema } from '../../shared/schema';

type Config = Omit<Options,'signer'> & { members: string[]; guardUserId: string; requestKeys: Record<string,string>; signerModule: string };
/** Separate entrypoint: never imports legacy routes, sessions, SQL or Stripe. */
export async function loadIsolatedConfig(path: string) {
  if (process.env.NODE_ENV === 'production' || process.env.FORGEPROOF_STORAGE !== 'git-isolated') throw new Error('Explicit nonproduction git-isolated selection required');
  const info = await stat(path);
  if (info.mode & 0o077) throw new Error('Private configuration permissions required');
  const config: Config = JSON.parse(await readFile(path,'utf8'));
  const storeInfo=await stat(config.directory);
  if (storeInfo.mode & 0o077 || !storeInfo.isDirectory()) throw new Error('Private tenant store permissions required');
  const actual=await realpath(config.directory);
  if (actual.startsWith((await realpath(process.cwd()))+'/')) throw new Error('Tenant store must be outside source tree');
  if (!Array.isArray(config.members) || !config.members.includes(config.guardUserId) || !config.requestKeys || config.checkpoint == null) throw new Error('Missing tenant trust configuration');
  for (const id of Object.keys(config.requestKeys)) {
    if (!config.members.includes(id) || createPublicKey(config.requestKeys[id]).asymmetricKeyType !== 'ed25519') throw new Error('Invalid request principal/key');
  }
  const {signer}=await import(pathToFileURL(resolve(config.signerModule)).href);
  const pin=config.trust?.eventKeys?.[signer?.keyId];
  const challenge=Buffer.from('forgeproof-isolated-startup-v1');
  if (!pin || pin.actor!==signer.actor || !verify(null,challenge,pin.publicKey,Buffer.from(await signer.sign(challenge),'base64'))) throw new Error('Trusted event signer required');
  const service = new GitAppStateService({...config,signer});
  await service.replay();
  return {config,service};
}
export async function createIsolatedApp(path: string) {
  const {config,service}=await loadIsolatedConfig(path);
  const app=express();
  // Signed bytes are the exact raw request body, not a JSON reserialization.
  app.use(express.raw({type:()=>true,limit:'64kb'}));
  app.use(async(req,res,next)=> {
    try {
      const user=req.get('x-forgeproof-user') ?? '';
      const timestamp=req.get('x-forgeproof-time') ?? '';
      const key=req.get('x-forgeproof-request') ?? '';
      const signature=req.get('x-forgeproof-signature') ?? '';
      const publicKey=config.requestKeys[user];
      if (!publicKey || !/^\d{13}$/.test(timestamp) || Math.abs(Date.now()-Number(timestamp))>60000 || !/^[a-zA-Z0-9_-]{1,100}$/.test(key)) return res.status(401).json({error:'Unauthorized'});
      const body=Buffer.isBuffer(req.body)?req.body:Buffer.alloc(0);
      const payload=JSON.stringify(['forgeproof-isolated-v1',config.tenant,config.repository,user,req.method,req.originalUrl,timestamp,key,createHash('sha256').update(body).digest('hex')]);
      const bytes=Buffer.from(signature,'base64');
      if(bytes.length!==64 || bytes.toString('base64')!==signature || !verify(null,Buffer.from(payload),publicKey,bytes)) return res.status(401).json({error:'Unauthorized'});
      res.locals.storage=new GitStorage(service,user,config.members,config.guardUserId);
      res.locals.user=user; res.locals.requestKey=key;
      next();
    } catch(e) { next(e); }
  });
  app.get('/api/repositories',async(_req,res,next)=> {
    try { res.json(await (res.locals.storage as GitStorage).getRepositories(res.locals.user)); } catch(e){next(e);}
  });
  app.post('/api/repositories',async(req,res,next)=> {
    try {
      const body=JSON.parse(req.body.toString('utf8'));
      if (body.userId!==undefined && body.userId!==res.locals.user) return res.status(403).json({error:'Forbidden'});
      const data=insertRepositorySchema.strict().parse({...body,userId:res.locals.user});
      res.status(201).json(await (res.locals.storage as GitStorage).createRepositoryIdempotent(data,res.locals.requestKey));
    } catch(e){next(e);}
  });
  app.get('/api/subscription',async(_req,res,next)=> {
    try { res.json(await (res.locals.storage as GitStorage).getSubscription(res.locals.user) ?? null); } catch(e){next(e);}
  });
  app.get('/api/verify',async(_req,res,next)=> {
    try { const state=await service.replay(); res.json({verified:true,checkpoint:state.checkpoint}); } catch(e){next(e);}
  });
  app.use((_req,res)=>{res.status(404).json({error:'Unavailable in isolated mode'});});
  app.use((_err: unknown,_req: express.Request,res: express.Response,_next: express.NextFunction)=>{res.status(409).json({error:'Request rejected'});});
  return app;
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  createIsolatedApp(process.env.FORGEPROOF_GIT_CONFIG ?? '').then(app=>app.listen(Number(process.env.PORT ?? 5001),'127.0.0.1')).catch(e=>{console.error(e.message);process.exitCode=1;});
}
