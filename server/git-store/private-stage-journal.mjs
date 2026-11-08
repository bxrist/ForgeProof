// Source-only Linux/local-filesystem journal. No append or production authority.
import fs from 'node:fs';
import path from 'node:path';
import {createCipheriv,createDecipheriv,createHmac,randomBytes} from 'node:crypto';
import {canonical} from './schema.mjs';

const ERROR='Private stage journal verification failed';
const MAX=32*1024*1024;
const kinds=new Set(['core','evidence','email','api-key']);
const mac=(key,value)=>createHmac('sha256',key).update(value).digest('hex');
const hex=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const inside=(root,target)=>target===root || target.startsWith(root+path.sep);
function noLinks(target) {
 for (let p=target;;p=path.dirname(p)) {
  if (fs.lstatSync(p).isSymbolicLink()) throw new Error();
  if (p===path.dirname(p)) break;
 }
}
function privateStat(stat,directory) {
 if (!(directory?stat.isDirectory():stat.isFile()) || stat.uid!==process.getuid() ||
     (stat.mode&0o777)!==(directory?0o700:0o600)) throw new Error();
}
function identity(a,b) {if(a.dev!==b.dev || a.ino!==b.ino)throw new Error();}

/** Trusted owner workflow supplies binding, source proof and independent keys.
 * Directory must already exist, be private and outside every Git worktree.
 * Linux /proc descriptor anchoring is mandatory; unsupported hosts fail closed.
 */
export function openPrivateStageJournal({directory,worktree,binding,journalKey,proofKey}) {
 let fd;
 try {
  if (process.platform!=='linux' || !path.isAbsolute(directory) || !path.isAbsolute(worktree) ||
      !binding || Object.keys(binding).sort().join(',')!=='authenticated,repositoryId,tenantId' ||
      binding.authenticated!==true || ['tenantId','repositoryId'].some(k=>
       typeof binding[k]!=='string'|| !/^[A-Za-z0-9_-]{1,128}$/.test(binding[k])) ||
      [journalKey,proofKey].some(k=>!Buffer.isBuffer(k)||k.length!==32) ||
      journalKey.equals(proofKey)) throw new Error();
  directory=path.resolve(directory);worktree=fs.realpathSync(worktree);
  noLinks(directory);
  if(inside(worktree,directory))throw new Error();
  for(let p=directory;;p=path.dirname(p)) {
   const marker=path.join(p,'.git');
   if(fs.existsSync(marker) && (!fs.lstatSync(marker).isDirectory() ||
       fs.existsSync(path.join(marker,'HEAD'))))throw new Error();
   if(p===path.dirname(p))break;
  }
  fd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  const pinned=fs.fstatSync(fd);privateStat(pinned,true);
  const base=`/proc/self/fd/${fd}`;
  identity(pinned,fs.statSync(base));
  const key=Buffer.from(journalKey),proof=Buffer.from(proofKey),scope={...binding};
  let closed=false;
  function guard() {
   if(closed)throw new Error();
   noLinks(directory);
   const current=fs.lstatSync(directory);privateStat(current,true);identity(pinned,current);
   privateStat(fs.fstatSync(fd),true);
  }
  function request(expected) {
   if(!expected || Object.keys(expected).sort().join(',')!=='id,kind,sourceCommitment,stageDigest' ||
       typeof expected.id!=='string'|| !/^[A-Za-z0-9_-]{1,128}$/.test(expected.id) ||
       !kinds.has(expected.kind)|| !hex(expected.sourceCommitment)||
       !/^hmac-sha256:[a-f0-9]{64}$/.test(expected.stageDigest))throw new Error();
   return Buffer.from(JSON.stringify({version:1,scope,...expected}));
  }
  function validate(bytes,expected) {
   if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>MAX)throw new Error();
   const stage=JSON.parse(bytes.toString('utf8'));
   if(!stage || stage.version!==1)throw new Error();
   if(stage.scope && (stage.scope.tenantId!==scope.tenantId ||
       stage.scope.repositoryId!==scope.repositoryId))throw new Error();
   if(stage.sourceCommitment && stage.sourceCommitment!==expected.sourceCommitment)throw new Error();
   if(stage.summary && (stage.summary.sourceCommitment!==expected.sourceCommitment ||
       stage.summary.productionGoAllowed!==false))throw new Error();
   const txs=expected.kind==='core'?(stage.transaction===null?[]:[stage.transaction]):stage.transactions;
   if(!Array.isArray(txs)||txs.some(tx=>!tx || !Array.isArray(tx.operations)))throw new Error();
   const digestInput=expected.kind==='api-key'?canonical(stage):bytes;
   if(expected.stageDigest!=='hmac-sha256:'+mac(proof,digestInput))throw new Error();
   return {transactionCount:txs.length,operationCount:txs.reduce((n,tx)=>n+tx.operations.length,0)};
  }
  function read(expected) {
   guard();const aad=request(expected);let entry;
   try {
    entry=fs.openSync(`${base}/${expected.id}.stage`,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const stat=fs.fstatSync(entry);privateStat(stat,false);
    if(stat.size<33||stat.size>MAX+28)throw new Error();
    const encrypted=fs.readFileSync(entry);
    const decipher=createDecipheriv('aes-256-gcm',key,encrypted.subarray(0,12));
    decipher.setAAD(aad);decipher.setAuthTag(encrypted.subarray(12,28));
    const bytes=Buffer.concat([decipher.update(encrypted.subarray(28)),decipher.final()]);
    const counts=validate(bytes,expected);guard();
    return {bytes,summary:{...counts,commitment:'hmac-sha256:'+mac(key,Buffer.concat([aad,bytes])),
     productionGoAllowed:false,fullApplicationMigrationComplete:false}};
   } finally {if(entry!==undefined)fs.closeSync(entry);}
  }
  return Object.freeze({
   read(expected) {try{return read(expected);}catch{throw new Error(ERROR);}},
   verify(expected) {try{return read(expected).summary;}catch{throw new Error(ERROR);}},
   persist(expected,input) {
    let temp,tempFd;
    try {
     guard();const aad=request(expected);
     if(!Buffer.isBuffer(input))throw new Error();
     const bytes=Buffer.from(input);validate(bytes,expected);
     // Existing entries must authenticate and match exact bytes; never overwrite.
     const target=`${base}/${expected.id}.stage`;
     let exists=false;
     try {fs.lstatSync(target);exists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
     if(exists) {
      const saved=read(expected);if(!saved.bytes.equals(bytes))throw new Error();
      fs.fsyncSync(fd);guard();return saved.summary;
     }
     const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
     cipher.setAAD(aad);
     const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);
     temp=`${base}/.pending-${randomBytes(16).toString('hex')}`;
     tempFd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
     fs.writeFileSync(tempFd,Buffer.concat([nonce,cipher.getAuthTag(),ciphertext]));
     fs.fsyncSync(tempFd);fs.closeSync(tempFd);tempFd=undefined;guard();
     try {fs.linkSync(temp,target);}catch(e){if(e.code!=='EEXIST')throw e;}
     // No ordinary rename: link is the no-replace publication point.
     fs.fsyncSync(fd);guard();
     const saved=read(expected);if(!saved.bytes.equals(bytes))throw new Error();
     fs.unlinkSync(temp);temp=undefined;fs.fsyncSync(fd);guard();
     return saved.summary;
    } catch {throw new Error(ERROR);}
    finally {
     if(tempFd!==undefined)fs.closeSync(tempFd);
     // On error retain encrypted orphan for operator investigation; never promote it.
    }
   },
   close() {if(!closed){closed=true;fs.closeSync(fd);key.fill(0);proof.fill(0);}},
  });
 } catch {if(fd!==undefined)fs.closeSync(fd);throw new Error(ERROR);}
}
