import { createHash, randomUUID } from 'node:crypto';
import { UnavailableCustodian, type CredentialCustodian } from './custody';
import type { IStorage } from '../storage';
import type { User } from '../../shared/models/auth';
import type * as S from '../../shared/schema';
import { GitAppStateService, ConflictError, type AppRecord, type RecordClass, type Replay, type Operation } from './store.mjs';

function stable(v: unknown): string {
  if (Array.isArray(v)) return '['+v.map(stable).join(',')+']';
  if (v && typeof v === 'object') return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable((v as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(v);
}
const digest = (v: unknown) => createHash('sha256').update(stable(v)).digest('hex');
const encode = (v: unknown): AppRecord => JSON.parse(JSON.stringify(v));
function decode<T>(record: AppRecord | undefined): T | undefined {
  if (!record) return undefined;
  const value = structuredClone(record) as Record<string, unknown>;
  for (const k of Object.keys(value)) if ((k.endsWith('At') || k.startsWith('currentPeriod')) && typeof value[k] === 'string') value[k] = new Date(value[k] as string);
  return value as T;
}
const unsupported = (): never => { throw new Error('Secure credential custody or immutable receipt annotation integration required'); };

/** A tenant-scoped IStorage implementation. The independently configured membership
 * allowlist is mandatory; it is never inferred from request data or untrusted Git. */
export class GitStorage implements IStorage {
  constructor(readonly service: Pick<GitAppStateService, 'replay' | 'append'>, readonly principal: string, readonly members: readonly string[], readonly guardUserId: string, readonly custody: CredentialCustodian = new UnavailableCustodian(), readonly custodyScope: string = '') {
    if (!members.length || !members.includes(principal) || !members.includes(guardUserId)) throw new Error('Tenant authorization denied');
  }
  private authorize(id: string) { if (!this.members.includes(id)) throw new Error('Tenant authorization denied'); }
  private async state() {
    const state = await this.service.replay();
    this.validate(state);
    return state;
  }
  private validate(state: Replay) {
    const records = state.records;
    const exists = (kind: RecordClass, id: unknown) => id != null && records[kind][String(id)];
    const unique = (kind: RecordClass, field: string) => {
      const seen = new Set();
      for (const row of Object.values(records[kind])) if (row[field] != null) {
        if (seen.has(row[field])) throw new Error(`Unique index violation: ${kind}.${field}`);
        seen.add(row[field]);
      }
    };
    for (const row of Object.values(records.users)) this.authorize(String(row.id));
    for (const [kind, rows] of Object.entries(records)) for (const row of Object.values(rows)) {
      const r = kind === 'receipts' ? JSON.parse(String(row.original)) as AppRecord : row;
      for (const field of ['userId','ownerId']) if (r[field] != null) {
        this.authorize(String(r[field]));
        if (!exists('users',r[field])) throw new Error('Missing user relation');
      }
      if (r.orgId != null && !exists('organizations',r.orgId)) throw new Error('Missing organization relation');
      if (r.repositoryId != null) {
        const repo=records.repositories[String(r.repositoryId)];
        if (!repo) throw new Error('Missing repository relation');
        if (repo.userId!==r.userId && (repo.orgId==null || repo.orgId!==r.orgId)) throw new Error('Repository ownership denied');
      }
      if (r.parentAttestationId != null && !exists('receipts',r.parentAttestationId)) throw new Error('Missing receipt relation');
      if (['repositories','receipts','subscriptions'].includes(kind) && r.orgId != null) {
        const org = records.organizations[String(r.orgId)];
        if (org.ownerId !== r.userId && !Object.values(records.orgMembers).some(m => m.orgId === r.orgId && m.userId === r.userId)) throw new Error('Organization membership denied');
      }
    }
    for (const [kind,field] of [['apiKeys','credentialRef'],['sessions','custodianRef'],['users','email'],['users','stripeCustomerId'],['organizations','slug'],['subscriptions','userId'],['subscriptions','stripeCustomerId'],['subscriptions','stripeSubscriptionId']] as const) unique(kind,field);
    for (const kind of ['repositories','orgMembers'] as const) {
      const seen = new Set();
      for (const r of Object.values(records[kind])) {
        const key = JSON.stringify(kind === 'repositories' ? [r.userId,r.githubId] : [r.orgId,r.userId]);
        if (seen.has(key)) throw new Error('Unique relation violation');
        seen.add(key);
      }
    }
  }
  private async rows<T>(kind: RecordClass): Promise<T[]> { return Object.values((await this.state()).records[kind]).map(r => decode<T>(r)!); }
  private async row<T>(kind: RecordClass,id: string | number): Promise<T | undefined> { return decode<T>((await this.state()).records[kind][id]); }
  private next(state: Replay, kind: RecordClass) {
    return Math.max(0,...Object.keys(state.versions).filter(k => k.startsWith(kind+'/')).map(k => Number(k.split('/')[1]))) + 1;
  }
  private put(state: Replay, kind: RecordClass, record: AppRecord): Operation {
    return { kind,id:record.id,action:'put',expectedVersion:state.versions[`${kind}/${record.id}`] ?? null,record };
  }
  private del(state: Replay, kind: RecordClass,id: number): Operation { return {kind,id,action:'delete',expectedVersion:state.versions[`${kind}/${id}`] ?? null}; }
  private async mutate<T>(label: string, input: unknown, build: (state: Replay) => { operations: Operation[]; result: T }, key: string = randomUUID()): Promise<T> {
    const idempotencyKey = digest([this.principal,label,key]);
    const fingerprint = digest([label,encode(input)]);
    for (let attempt=0; attempt<8; attempt++) {
      const state = await this.state();
      const previous = state.events.find(e => e.body.idempotencyKey === idempotencyKey);
      if (previous) {
        const audit = previous.body.operations.find(o => o.kind === 'auditLogs' && o.action === 'put' && o.record.resourceType === 'storage-request');
        if (!audit || audit.action !== 'put' || audit.record.resourceId !== fingerprint) throw new Error('Idempotency request conflict');
        // Return the original result, even after subsequent updates/cancellation.
        const first = previous.body.operations[0];
        return (first.action === 'put' ? decode(first.kind === 'receipts' ? JSON.parse(String(first.record.original)) : first.record) : undefined) as T;
      }
      const guard = state.records.users[this.guardUserId];
      if (!guard) throw new Error('Trusted tenant bootstrap user required');
      const {operations,result} = build(state);
      const auditId=Math.max(this.next(state,'auditLogs'),...operations.filter(o=>o.kind==='auditLogs').map(o=>Number(o.id)+1));
      const audit = {id:auditId,userId:this.principal,action:label,resourceType:'storage-request',resourceId:fingerprint,createdAt:new Date().toISOString()};
      const all = [...operations];
      if (!all.some(o => o.kind === 'users' && o.id === guard.id)) all.push(this.put(state,'users',guard));
      all.push(this.put(state,'auditLogs',audit));
      const projected = structuredClone(state);
      for (const op of all) { if (op.action === 'put') projected.records[op.kind][op.id] = op.record; else delete projected.records[op.kind][op.id]; }
      this.validate(projected);
      try { await this.service.append({idempotencyKey,operations:all}); return result; }
      catch (e) { if (!(e instanceof ConflictError) || attempt === 7) throw e; }
    }
    throw new Error('Storage retry limit');
  }
  private create<T>(kind: RecordClass, data: unknown, defaults: object = {}, key?: string): Promise<T> {
    data = encode(data);
    return this.mutate(`create:${kind}`,data,state => {
      const record = encode({...defaults,...data as object,id:this.next(state,kind),createdAt:new Date()});
      return {operations:[this.put(state,kind,record)],result:decode<T>(record)!};
    },key);
  }
  private update(kind: RecordClass,id: number | string,data: unknown): Promise<void> {
    data = encode(data);
    return this.mutate(`update:${kind}`,{id,data}, state => {
      const old = state.records[kind][id];
      if (!old) throw new Error('Record not found');
      const record = encode({...old,...data as object,id});
      return {operations:[this.put(state,kind,record)],result:undefined};
    });
  }
  private remove(kind: RecordClass,id: number): Promise<void> {
    return this.mutate(`delete:${kind}`,{id},state => ({operations:[this.del(state,kind,id)],result:undefined}));
  }
  async getUser(id: string) { this.authorize(id); const row = await this.row<User>('users',id); return row ? Object.assign({email:null,firstName:null,lastName:null,profileImageUrl:null,githubUsername:null,notificationEmail:null,stripeCustomerId:null,defaultRepoId:null,createdAt:null,updatedAt:null},row,{githubToken:null}) : undefined; }
  async updateUser(id: string,data: Partial<User>) { this.authorize(id); if ('githubToken' in data || 'id' in data) unsupported(); await this.update('users',id,data); }
  async getRepositories(userId: string) { this.authorize(userId); return (await this.rows<S.Repository>('repositories')).filter(r=>r.userId===userId); }
  getRepository(id: number) { return this.row<S.Repository>('repositories',id); }
  async getRepositoryByGithubId(githubId: number,userId: string) { return (await this.getRepositories(userId)).find(r=>r.githubId===githubId); }
  createRepository(data: S.InsertRepository) { return this.create<S.Repository>('repositories',data,{orgId:null,defaultBranch:'main',description:null,lastSyncedAt:null}); }
  createRepositoryIdempotent(data: S.InsertRepository,key: string) { return this.create<S.Repository>('repositories',data,{orgId:null,defaultBranch:'main',description:null,lastSyncedAt:null},key); }
  updateRepository(id: number,data: Partial<S.InsertRepository>) { return this.update('repositories',id,data); }
  updateRepositoryLastSynced(id: number) { return this.update('repositories',id,{lastSyncedAt:new Date()}); }
  deleteRepository(id: number) { return this.remove('repositories',id); }
  private async receipts() { return Object.values((await this.state()).records.receipts).map(r=>decode<S.AttestationReceipt>(JSON.parse(String(r.original)))!); }
  async getAttestations(userId: string) { this.authorize(userId); return (await this.receipts()).filter(r=>r.userId===userId).reverse(); }
  async getSystemAttestations() { return this.members.includes('forgeproof-system') ? this.getAttestations('forgeproof-system') : []; }
  async getAllAttestationsOrdered() { return (await this.receipts()).sort((a,b)=>a.id-b.id); }
  async getAttestation(id: number) { return (await this.receipts()).find(r=>r.id===id); }
  async getAttestationByEntryHash(hash: string) { return (await this.receipts()).find(r=>r.entryHash===hash); }
  async getAttestationsByParentId(id: number) { return (await this.receipts()).filter(r=>r.parentAttestationId===id); }
  async getLatestAttestation() { return (await this.getAllAttestationsOrdered()).at(-1); }
  createAttestation(data: S.InsertAttestationReceipt) { return this.createAttestationAndCount(data,randomUUID()); }
  createAttestationAndCount(data: S.InsertAttestationReceipt,key: string) {
    data = JSON.parse(JSON.stringify(data));
    return this.mutate<S.AttestationReceipt>('attest-and-count',data,state=> {
      const sub = Object.values(state.records.subscriptions).find(s=>s.userId===data.userId);
      if (!sub || !['active','trialing'].includes(String(sub.status)) || (Number(sub.attestationLimit)!==-1 && Number(sub.attestationCount)>=Number(sub.attestationLimit))) throw new Error('Quota or subscription denied');
      const receipt = encode({orgId:null,repositoryId:null,detectedCountry:null,complianceStatus:'unverified',attestationType:'origin',parentAttestationId:null,auditVerdict:null,auditDetails:null,prevEntryHash:null,receiptVersion:'v1',signedAt:null,gitCommitUrl:null,gitCommitMessage:null,metadata:null,...data,id:this.next(state,'receipts'),createdAt:new Date()});
      return {operations:[this.put(state,'receipts',{id:receipt.id,original:JSON.stringify(receipt)}),this.put(state,'subscriptions',{...sub,attestationCount:Number(sub.attestationCount)+1})],result:decode<S.AttestationReceipt>(receipt)!};
    },key);
  }
  async updateAttestationGitCommitUrl(_id: number,_url: string,_message?: string): Promise<void> { return unsupported(); }
  private custodyBinding() { if (!this.custodyScope) throw new Error('Secure credential custody binding unavailable'); return this.custodyScope; }
  private keyView(record: AppRecord): S.ApiKey {
    // IStorage compatibility: no verifier or prefix is returned, even to internal callers.
    return {...decode<S.ApiKey>(record)!,keyHash:'',keyPrefix:''};
  }
  async getApiKeys(userId: string): Promise<S.ApiKey[]> {
    this.authorize(userId); if(userId!==this.principal) throw new Error('Credential owner denied');
    return Object.values((await this.state()).records.apiKeys).filter(r=>r.userId===userId).map(r=>this.keyView(r));
  }
  async getApiKeyByHash(hash: string): Promise<S.ApiKey | undefined> {
    const scope=this.custodyBinding(), state=await this.state();
    const matches=[];
    for(const row of Object.values(state.records.apiKeys)) if(await this.custody.matches(scope,String(row.credentialRef),hash)) matches.push(row);
    if(matches.length>1) throw new Error('Duplicate credential lookup');
    const row=matches[0];
    if(!row || row.userId!==this.principal || !row.isActive || (row.expiresAt && Date.parse(String(row.expiresAt))<=Date.now())) return undefined;
    return this.keyView(row);
  }
  createApiKey(data: S.InsertApiKey): Promise<S.ApiKey> { return this.createApiKeyIdempotent(data,randomUUID()); }
  async createApiKeyIdempotent(data: S.InsertApiKey,key: string, rotateId?: number): Promise<S.ApiKey> {
    const scope=this.custodyBinding(); this.authorize(data.userId);
    if(data.userId!==this.principal) throw new Error('Credential owner denied');
    // Stage is durable and inert. Never hash verifier-bearing input into a Git audit fingerprint.
    const ref=await this.custody.stage(scope,this.principal+':'+key,{kind:'api-key',verifier:data.keyHash,prefix:data.keyPrefix});
    const safe=encode({userId:data.userId,name:data.name,permissions:data.permissions ?? ['attest:read','attest:write'],isActive:data.isActive ?? true,expiresAt:data.expiresAt ?? null,credentialRef:ref});
    const result=await this.mutate<AppRecord>('credential-authorize',{safe,rotateId:rotateId ?? null},state=> {
      const old=rotateId===undefined ? undefined : state.records.apiKeys[rotateId];
      if(rotateId!==undefined && (!old || old.userId!==this.principal || !old.isActive)) throw new Error('Rotation owner/state denied');
      const sub=Object.values(state.records.subscriptions).find(s=>s.userId===this.principal);
      const count=Object.values(state.records.apiKeys).filter(r=>r.userId===this.principal && r.isActive && (!r.expiresAt || Date.parse(String(r.expiresAt))>Date.now())).length-(old ? 1:0);
      if(!sub || !['active','trialing'].includes(String(sub.status)) || (Number(sub.apiKeyLimit)!==-1 && count>=Number(sub.apiKeyLimit))) throw new Error('API key quota denied');
      if(Object.values(state.records.apiKeys).some(r=>r.credentialRef===ref)) throw new Error('Credential already authorized');
      const record=encode({...safe,id:this.next(state,'apiKeys'),createdAt:new Date(),lastUsedAt:null});
      return {operations:[this.put(state,'apiKeys',record),...(old ? [this.put(state,'apiKeys',{...old,isActive:false})]:[])],result:record};
    },key);
    // Do not delete staged material on ambiguous append failure: Git may already have accepted it.
    // Rotation disables the old Git authorization atomically; custody deletion can be retried separately.
    return this.keyView(result);
  }
  async deleteApiKey(id: number,userId: string): Promise<void> {
    this.authorize(userId); if(userId!==this.principal) throw new Error('Credential owner denied');
    const scope=this.custodyBinding();
    await this.mutate<void>('credential-revoke',{id,userId},state=> {
      const row=state.records.apiKeys[id]; if(!row || row.userId!==userId) throw new Error('Credential owner denied');
      return {operations:[this.put(state,'apiKeys',{...row,isActive:false})],result:undefined};
    });
    const row=(await this.state()).records.apiKeys[id];
    await this.custody.destroy(scope,String(row.credentialRef));
  }
  async updateApiKeyLastUsed(id: number): Promise<void> {
    await this.mutate<void>('credential-use',{id},state=> {
      const row=state.records.apiKeys[id];
      if(!row || row.userId!==this.principal || !row.isActive || (row.expiresAt && Date.parse(String(row.expiresAt))<=Date.now())) throw new Error('Credential use denied');
      return {operations:[this.put(state,'apiKeys',{...row,lastUsedAt:new Date().toISOString()})],result:undefined};
    });
  }
  async authenticateApiKey(hash: string,permission: 'attest:read' | 'attest:write',requestId: string) {
    const key=await this.getApiKeyByHash(hash);
    if(!key || !key.permissions?.includes(permission)) throw new Error('Credential authorization denied');
    await this.mutate<void>('credential-authenticate',{id:key.id,permission},state=> {
      const row=state.records.apiKeys[key.id];
      if(!row || row.userId!==this.principal || !row.isActive || !Array.isArray(row.permissions) || !row.permissions.includes(permission) || (row.expiresAt && Date.parse(String(row.expiresAt))<=Date.now())) throw new Error('Credential authorization denied');
      return {operations:[this.put(state,'apiKeys',{...row,lastUsedAt:new Date().toISOString()})],result:undefined};
    },requestId);
    // Recheck after the append, including retries of old requests after revocation.
    const accepted=await this.getApiKeyByHash(hash);
    if(!accepted) throw new Error('Credential authorization denied');
    return accepted;
  }
  async stageOidcSession(material: string,expiresAt: Date,requestId: string) {
    const scope=this.custodyBinding();
    if(!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime()<=Date.now()) throw new Error('Session expiry denied');
    const ref=await this.custody.stage(scope,this.principal+':session:'+requestId,{kind:'oidc-session',material});
    const id=digest([this.principal,'session',requestId]);
    await this.mutate('session-authorize',{id,ref,expiresAt},state=> {
      if(state.versions['sessions/'+id]) throw new Error('Session request already used');
      const record=encode({id,userId:this.principal,custodianRef:ref,expiresAt});
      return {operations:[this.put(state,'sessions',record)],result:record};
    },requestId);
    return id;
  }
  async recoverOidcSession(id: string) {
    const row=(await this.state()).records.sessions[id];
    if(!row || row.userId!==this.principal || Date.parse(String(row.expiresAt))<=Date.now()) throw new Error('Session authorization denied');
    const material=await this.custody.recoverSession(this.custodyBinding(),String(row.custodianRef));
    const current=(await this.state()).records.sessions[id];
    if(!current || current.userId!==this.principal || current.custodianRef!==row.custodianRef || Date.parse(String(current.expiresAt))<=Date.now()) throw new Error('Session authorization denied');
    return material;
  }
  async revokeOidcSession(id: string) {
    const scope=this.custodyBinding();
    const row=(await this.state()).records.sessions[id];
    if(!row || row.userId!==this.principal) throw new Error('Session authorization denied');
    await this.mutate<void>('session-revoke',{id},state=> {
      const current=state.records.sessions[id];
      if(!current || current.userId!==this.principal) throw new Error('Session authorization denied');
      return {operations:[this.put(state,'sessions',{...current,expiresAt:new Date(0).toISOString()})],result:undefined};
    });
    await this.custody.destroy(scope,String(row.custodianRef));
  }
  async getOrganizations(userId: string) { this.authorize(userId); const memberships=await this.rows<S.OrgMember>('orgMembers'); return (await this.rows<S.Organization>('organizations')).filter(o=>o.ownerId===userId || memberships.some(m=>m.orgId===o.id&&m.userId===userId)); }
  getOrganization(id: number) { return this.row<S.Organization>('organizations',id); }
  async getOrganizationBySlug(slug: string) { return (await this.rows<S.Organization>('organizations')).find(o=>o.slug===slug); }
  createOrganization(data: S.InsertOrganization) { return this.create<S.Organization>('organizations',data,{description:null}); }
  updateOrganization(id: number,data: Partial<S.InsertOrganization>) { return this.update('organizations',id,data); }
  async deleteOrganization(id: number) {
    await this.mutate('delete:organizations',{id},state=>({operations:[...Object.values(state.records.orgMembers).filter(m=>m.orgId===id).map(m=>this.del(state,'orgMembers',Number(m.id))),this.del(state,'organizations',id)],result:undefined}));
  }
  async getOrgMembers(id: number) { return (await this.rows<S.OrgMember>('orgMembers')).filter(m=>m.orgId===id); }
  async getOrgMember(id: number,userId: string) { this.authorize(userId); return (await this.getOrgMembers(id)).find(m=>m.userId===userId); }
  addOrgMember(data: S.InsertOrgMember) { return this.create<S.OrgMember>('orgMembers',data,{role:'member'}); }
  async removeOrgMember(id: number,userId: string) { const member=await this.getOrgMember(id,userId); if (member) await this.remove('orgMembers',member.id); }
  async updateOrgMemberRole(id: number,userId: string,role: string) { const member=await this.getOrgMember(id,userId); if (!member) throw new Error('Member not found'); await this.update('orgMembers',member.id,{role}); }
  createAuditLog(data: S.InsertAuditLog) { if (data.metadata != null) unsupported(); const {metadata,...safe}=data; return this.create<S.AuditLog>('auditLogs',safe,{userId:null,resourceType:null,resourceId:null,ipAddress:null}); }
  async getAuditLogs(userId?: string,limit=100) { if(userId) this.authorize(userId); return (await this.rows<S.AuditLog>('auditLogs')).filter(a=>!userId||a.userId===userId).reverse().slice(0,limit).map(a=>({...a,metadata:null})); }
  async getAuditLogsByResource(type: string,id: string) { return (await this.getAuditLogs(undefined,Number.MAX_SAFE_INTEGER)).filter(a=>a.resourceType===type&&a.resourceId===id); }
  async clearAllAttestations(): Promise<void> { throw new Error('Immutable history cannot be cleared'); }
  async getSubscription(userId: string) { this.authorize(userId); return (await this.rows<S.Subscription>('subscriptions')).find(s=>s.userId===userId); }
  async getSubscriptionByStripeId(id: string) { return (await this.rows<S.Subscription>('subscriptions')).find(s=>s.stripeSubscriptionId===id); }
  async getSubscriptionByCustomerId(id: string) { return (await this.rows<S.Subscription>('subscriptions')).find(s=>s.stripeCustomerId===id); }
  createSubscription(data: S.InsertSubscription) { return this.create<S.Subscription>('subscriptions',data,{orgId:null,stripeCustomerId:null,stripeSubscriptionId:null,plan:'free',status:'active',attestationLimit:100,attestationCount:0,apiKeyLimit:1,currentPeriodStart:null,currentPeriodEnd:null}); }
  updateSubscription(id: number,data: Partial<S.InsertSubscription>) { return this.update('subscriptions',id,data); }
  /** Provider event must already be authenticated by a trusted billing caller. No provider calls here. */
  reconcileSubscription(id: number,data: Partial<S.InsertSubscription>,eventId: string) {
    data = JSON.parse(JSON.stringify(data));
    return this.mutate<void>('billing-reconcile',{id,data},state=> {
      const old=state.records.subscriptions[id]; if(!old) throw new Error('Subscription not found');
      if ('attestationCount' in data || 'userId' in data) throw new Error('Billing event cannot reset usage or ownership');
      let count=Number(old.attestationCount);
      if (data.currentPeriodStart) {
        const next=new Date(data.currentPeriodStart).getTime();
        const before=old.currentPeriodStart ? Date.parse(String(old.currentPeriodStart)) : null;
        if (!Number.isFinite(next) || before===null || next<before) throw new Error('Unreviewed or stale billing period');
        if(next>before) count=0;
      }
      return {operations:[this.put(state,'subscriptions',encode({...old,...data,id,attestationCount:count}))],result:undefined};
    },eventId);
  }
  /** Internal boundary for StripeInbox only. No untrusted HTTP body may call this directly. */
  async acceptStripeInvoice(event: {id: string; created: number; customer: string; subscription: string; start: number; end: number; plan: string; limit: number; keyLimit: number}) {
    return this.mutate<void>('stripe-inbox',event,state=> {
      const existing=Object.values(state.records.auditLogs).find(r=>r.resourceType==='stripe-event' && r.resourceId===event.id);
      if(existing) {
        if(existing.action!==digest(event)) throw new Error('Provider event ID conflict');
        return {operations:[],result:undefined};
      }
      const sub=Object.values(state.records.subscriptions).find(s=>s.stripeCustomerId===event.customer && s.stripeSubscriptionId===event.subscription);
      if(!sub) throw new Error('Unknown provider customer/subscription');
      if(sub.billingEventCreated!=null && event.created<=Number(sub.billingEventCreated)) throw new Error('Stale or unordered provider event');
      const before=Date.parse(String(sub.currentPeriodStart));
      const previousEnd=Date.parse(String(sub.currentPeriodEnd));
      const start=event.start*1000, end=event.end*1000;
      if(!Number.isFinite(before) || !Number.isFinite(previousEnd) || start<before || end<=start || end<previousEnd || (start===before && end!==previousEnd) || (start>before && start<previousEnd)) throw new Error('Unsafe billing period');
      const record=encode({...sub,plan:event.plan,status:'active',attestationLimit:event.limit,apiKeyLimit:event.keyLimit,currentPeriodStart:new Date(start),currentPeriodEnd:new Date(end),attestationCount:start>before ? 0:sub.attestationCount,billingEventCreated:event.created,billingEventId:event.id});
      const audit=encode({id:this.next(state,'auditLogs'),userId:this.principal,action:digest(event),resourceType:'stripe-event',resourceId:event.id,createdAt:new Date()});
      return {operations:[this.put(state,'subscriptions',record),this.put(state,'auditLogs',audit)],result:undefined};
    },event.id);
  }
  async incrementAttestationCount(_id: string): Promise<void> { throw new Error('Use atomic createAttestationAndCount to prevent duplicate quota charges'); }
  async resetAttestationCount(_id: number): Promise<void> { throw new Error('Usage reset requires reviewed billing-period reconciliation'); }
  async getOrCreateFreeSubscription(userId: string) {
    const old=await this.getSubscription(userId); if(old) return old;
    try { return await this.createSubscription({userId}); } catch(e) { const raced=await this.getSubscription(userId); if(raced) return raced; throw e; }
  }
}
