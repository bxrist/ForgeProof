#!/usr/bin/env node
import {readFile,writeFile,stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {GitAppStateService} from './store.mjs';
import {migrateArchive,readTenantArchive} from './archive.mjs';
import {canonical,exact} from './schema.mjs';
export async function archiveMain(args) {
  const [command,directory,configPath,output,inputPath,pinnedDigest,extra]=args;
  if(!['migrate','read-tenant'].includes(command)||!pinnedDigest||!extra) throw new Error('Usage: archive-cli.mjs migrate STORE CONFIG OUTPUT REVIEWED_EXPORT PINNED_MANIFEST_SHA256 SIGNER_MODULE; read-tenant STORE CONFIG OUTPUT MANIFEST PINNED_MANIFEST_SHA256 AUTHORIZED_TENANT');
  if((await stat(directory)).mode&0o077) throw new Error('Restrictive private archive permissions required');
  const config=JSON.parse(await readFile(configPath,'utf8')); exact(config,['tenant','repository','checkpoint','trust']);
  const signer=command==='migrate'?(await import(pathToFileURL(resolve(extra)).href)).signer:undefined;
  const service=new GitAppStateService({...config,directory:resolve(directory),signer});
  const input=JSON.parse(await readFile(inputPath,'utf8'));
  const result=command==='migrate'?{checkpoint:await migrateArchive(service,input,pinnedDigest)}:{receipts:await readTenantArchive(service,input,pinnedDigest,extra)};
  await writeFile(output,canonical(result)+'\n',{mode:0o600,flag:'wx'});
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) archiveMain(process.argv.slice(2)).then(()=>console.log('Verified archive operation complete')).catch(e=>{console.error(e.message);process.exitCode=1;});
