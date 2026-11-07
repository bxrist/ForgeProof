import { createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export type Credential = { kind: 'api-key'; verifier: string; prefix: string } | { kind: 'oidc-session'; material: string };
export interface CredentialCustodian {
  /** Stable request IDs and uniqueness are scoped to a trusted tenant store binding. */
  stage(scope: string, request: string, value: Credential): Promise<string>;
  matches(scope: string, ref: string, verifier: string): Promise<boolean>;
  destroy(scope: string, ref: string): Promise<void>;
  recoverSession(scope: string, ref: string): Promise<string | undefined>;
}
export class UnavailableCustodian implements CredentialCustodian {
  async stage(_s: string, _r: string, _v: Credential): Promise<string> { throw new Error('Secure credential custody unavailable'); }
  async matches(_s: string, _r: string, _v: string): Promise<boolean> { throw new Error('Secure credential custody unavailable'); }
  async destroy(_s: string, _r: string): Promise<void> { throw new Error('Secure credential custody unavailable'); }
  async recoverSession(_s: string, _r: string): Promise<string | undefined> { throw new Error('Secure credential custody unavailable'); }
}
/** Must provide durable, linearizable read-modify-write, including across workers.
 * Only encrypted credential envelopes live here; never app business state.
 * A production provider is deliberately not auto-configured. */
export interface EncryptedCredentialVault {
  transact<T>(namespace: string, change: (envelope: string | undefined) => { envelope: string; result: T }): Promise<T>;
}
type Entry = { ref: string; request: string; value: Credential | null; retired?: Extract<Credential, {kind: 'api-key'}> };
const equal = (a: string, b: string) => { const x=Buffer.from(a), y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); };
/** Key comes from external secure provisioning, never Git/config serialized to Git.
 * Namespace is authenticated as AAD; all uniqueness checks happen inside vault CAS. */
export class EncryptedProviderCustodian implements CredentialCustodian {
  private readonly key: Buffer;
  constructor(private vault: EncryptedCredentialVault, key: Buffer) {
    if(key.length!==32) throw new Error('Custody encryption requires 256-bit key');
    this.key=Buffer.from(key);
  }
  private transaction<T>(scope: string, change: (entries: Entry[])=>T) {
    if (!scope || scope.length>512) throw new Error('Invalid custody scope');
    return this.vault.transact(scope, envelope=> {
      let entries: Entry[]=[];
      if(envelope) {
        const bytes=Buffer.from(envelope,'base64');
        const decipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));
        decipher.setAAD(Buffer.from(scope)); decipher.setAuthTag(bytes.subarray(12,28));
        entries=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString());
      }
      const result=change(entries), iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',this.key,iv);
      cipher.setAAD(Buffer.from(scope));
      const ciphertext=Buffer.concat([cipher.update(JSON.stringify(entries)),cipher.final()]);
      return {envelope:Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64'),result};
    });
  }
  stage(scope: string, request: string, value: Credential) {
    if(!request || request.length>256) throw new Error('Invalid custody request');
    if(value.kind==='api-key' && (!/^[a-f0-9]{64}$/.test(value.verifier) || !/^[a-zA-Z0-9_]{1,12}$/.test(value.prefix))) throw new Error('Invalid API verifier/prefix');
    if(value.kind==='oidc-session' && (!value.material || value.material.length>65536)) throw new Error('Invalid session material');
    return this.transaction(scope, entries=> {
      const old=entries.find(e=>e.request===request);
      if(old) { if(!old.value || !equal(JSON.stringify(old.value),JSON.stringify(value))) throw new Error('Custody request conflict'); return old.ref; }
      if(value.kind==='api-key' && entries.some(e=> { const prior=e.value?.kind==='api-key' ? e.value:e.retired; return prior && (equal(prior.verifier,value.verifier) || prior.prefix===value.prefix); })) throw new Error('Duplicate credential verifier/prefix');
      const ref='custodian:'+randomUUID(); entries.push({ref,request,value}); return ref;
    });
  }
  matches(scope: string, ref: string, verifier: string) {
    if(!/^[a-f0-9]{64}$/.test(verifier)) return Promise.resolve(false);
    return this.transaction(scope, entries=> { const value=entries.find(e=>e.ref===ref)?.value; return value?.kind==='api-key' && equal(value.verifier,verifier); });
  }
  destroy(scope: string, ref: string) { return this.transaction(scope, entries=> { const entry=entries.find(e=>e.ref===ref); if(entry) { if(entry.value?.kind==='api-key') entry.retired=entry.value; entry.value=null; } }); }
  recoverSession(scope: string, ref: string) { return this.transaction(scope, entries=> { const value=entries.find(e=>e.ref===ref)?.value; return value?.kind==='oidc-session' ? value.material : undefined; }); }
}
