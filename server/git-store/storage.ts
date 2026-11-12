import { createHash, createHmac, randomUUID } from 'node:crypto';
import { UnavailableCustodian, type CredentialCustodian } from './custody';
import type { IStorage } from '../storage';
import type { User } from '../../shared/models/auth';
import type * as S from '../../shared/schema';
import { GitAppStateService, ConflictError, type AppRecord, type RecordClass, type Replay, type Operation } from './store.mjs';
import { protectQueuedEmail, restoreQueuedEmail } from './protected-email.mjs';
// Optional isolated Git-only delivery types. The public production SQL schema
// must NOT be expanded or migrated to support this unreleased adapter.
type PrivatePendingEmail = {
  id: number; to: string; subject: string; bodyText: string; bodyHtml: string;
  status: 'pending' | 'sent' | 'failed'; retryCount: number;
  nextRetryAt: Date; createdAt: Date;
};
type InsertPrivatePendingEmail = Omit<PrivatePendingEmail,'id'|'createdAt'> & {
  status?: 'pending' | 'sent' | 'failed'; retryCount?: number; nextRetryAt?: Date;
};
import { protectLegacyAuditLog, restoreProtectedAuditLog } from './protected-audit.mjs';
import { protectLegacyReceipt, restoreProtectedReceipt } from './protected-receipt.mjs';
import { redactEvidence } from '../evidenceVisibility';
import { dashboardAllows, validateDashboardRelations } from './dashboardScope';

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
  for (const k of Object.keys(value)) if (k !== 'signedAt' && (k.endsWith('At') || k.startsWith('currentPeriod')) && typeof value[k] === 'string') value[k] = new Date(value[k] as string);
  return value as T;
}
const unsupported = (): never => { throw new Error('Secure credential custody or immutable receipt annotation integration required'); };

/** A tenant-scoped IStorage implementation. The independently configured membership
 * allowlist is mandatory; it is never inferred from request data or untrusted Git. */
export class GitStorage implements IStorage {
  constructor(readonly service: Pick<GitAppStateService, 'replay' | 'append'>, readonly principal: string, readonly members: readonly string[], readonly guardUserId: string, readonly custody: CredentialCustodian = new UnavailableCustodian(), readonly custodyScope: string = '', readonly mailEncryptionKey?: Buffer, readonly auditEncryptionKey?: Buffer, readonly receiptEncryptionKey?: Buffer, readonly applicationRegistry = false) {
    if (!members.length || !members.includes(principal) || !members.includes(guardUserId)) throw new Error('Tenant authorization denied');
  }
  private authorize(id: string) { if (!this.members.includes(id)) throw new Error('Tenant authorization denied'); }
  private async state() {
    const state = await this.service.replay();
    this.validate(state);
    return state;
  }
  private validate(state: Replay) {
    // Full-app registry comes only from verified signed user records. This
    // admits concurrently registered users, not receipt-only orphan identities,
    // and does not authenticate a caller or confer organization permissions.
    if (this.applicationRegistry) for (const id of Object.keys(state.records.users))
      if (!this.members.includes(id)) (this.members as string[]).push(id);
    const records = state.records;
    validateDashboardRelations(state);
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
      const r = kind === 'receipts'
        ? JSON.parse(String(row.originalCore ?? row.original)) as AppRecord
        : (kind === 'auditLogs' && row.auditCore ? JSON.parse(String(row.auditCore)) as AppRecord : row);
      for (const field of ['userId','ownerId']) if (r[field] != null) {
        // Verified historical evidence survives deletion of its original
        // identity. Never create a user or grant a capability from that evidence.
        if (this.applicationRegistry && kind==='receipts' && field==='userId' && !exists('users',r[field])) continue;
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
  private async mutate<T>(label: string, input: unknown, build: (state: Replay) => ({ operations: Operation[]; result: T } | Promise<{ operations: Operation[]; result: T }>), key: string = randomUUID(), verifyState?: (state: Replay) => Promise<void>): Promise<T> {
    const idempotencyKey = digest([this.principal,label,key]);
    const fingerprint = digest([label,encode(input)]);
    for (let attempt=0; attempt<8; attempt++) {
      const state = await this.state();
      if (verifyState) await verifyState(state);
      const previous = state.events.find(e => e.body.idempotencyKey === idempotencyKey);
      if (previous) {
        const audit = previous.body.operations.find(o => o.kind === 'auditLogs' && o.action === 'put' && o.record.resourceType === 'storage-request');
        if (!audit || audit.action !== 'put' || audit.record.resourceId !== fingerprint) throw Object.assign(new Error('Idempotency request conflict'), {status:409});
        // Return the original result, even after subsequent updates/cancellation.
        const first = previous.body.operations[0];
        return (first.action === 'put' ? decode(first.kind === 'receipts' ? JSON.parse(String(first.record.originalCore ?? first.record.original)) : first.kind === 'auditLogs' && first.record.auditCore ? JSON.parse(String(first.record.auditCore)) : first.record) : undefined) as T;
      }
      const guard = state.records.users[this.guardUserId];
      if (!guard) throw new Error('Trusted tenant bootstrap user required');
      const {operations,result} = await build(state);
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
  private githubCredentialScope(id: string): string {
    // Bind external OAuth material to BOTH the authenticated Git tenant and
    // immutable user ID. A signed Git user record pointing to another user's
    // opaque ref cannot decrypt that person's credential.
    return this.custodyBinding()+':github:'+createHash('sha256').update(id).digest('hex');
  }
  async ensureUser(id: string): Promise<User | undefined> {
    this.authorize(id);
    if (id !== this.principal) throw new Error('User creation owner denied');
    if (await this.getUser(id)) return this.getUser(id);
    if (this.applicationRegistry && Object.values((await this.state()).records.receipts)
      .some(r=>JSON.parse(String(r.originalCore ?? r.original)).userId===id))
      throw Object.assign(new Error('Historical receipt-only identity is read-only'),{status:403});
    await this.mutate('ensure-user', {id}, state => {
      if (state.records.users[id]) return {operations:[],result:undefined};
      const record = encode({id,notifyOnGitFailure:true,createdAt:new Date(),updatedAt:new Date()});
      return {operations:[this.put(state,'users',record)],result:undefined};
    });
    return this.getUser(id);
  }
  async getUser(id: string): Promise<User | undefined> {
    const row = await this.row<User & { githubTokenRef?: string | null }>('users',id);
    this.authorize(id);
    if (!row) return undefined;
    const { githubTokenRef, ...safe } = row;
    let githubToken: string | null = null;
    // Only the authenticated subject may obtain decrypted GitHub credentials.
    // An existing vault reference with missing custody is a hard failure, not
    // evidence that the account is disconnected.
    if (id === this.principal && githubTokenRef != null) {
      const token = await this.custody.recoverGithubToken(this.githubCredentialScope(id), githubTokenRef);
      if (!token) throw new Error('GitHub credential recovery unavailable');
      githubToken = token;
    }
    return Object.assign({
      email:null,firstName:null,lastName:null,profileImageUrl:null,
      githubUsername:null,notificationEmail:null,stripeCustomerId:null,
      notifyOnGitFailure:true,detailRepoId:null,lastActiveTab:null,
      defaultRepoId:null,createdAt:null,updatedAt:null
    },safe,{githubToken});
  }
  async updateUser(id: string,data: Partial<User>): Promise<void> {
    this.authorize(id);
    if (id !== this.principal) throw new Error('User update owner denied');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid user update');
    const allowed = new Set(['email','firstName','lastName','profileImageUrl','githubUsername',
      'notificationEmail','notifyOnGitFailure','stripeCustomerId','defaultRepoId',
      'detailRepoId','lastActiveTab','createdAt','updatedAt','githubToken']);
    if (Object.keys(data).some(key=>!allowed.has(key))) throw new Error('Unsupported user update field');
    const hasToken = Object.prototype.hasOwnProperty.call(data,'githubToken');
    if (!hasToken) {
      await this.update('users',id,data);
      return;
    }
    if (id !== this.principal) throw new Error('Credential owner denied');
    const scope = this.githubCredentialScope(id);
    const token = (data as {githubToken?: unknown}).githubToken;
    if (!(token===null || (typeof token==='string' && token.length>0 &&
      token.length<=16384 && !/[\x00-\x1F\x7F]/.test(token))))
      throw new Error('Invalid GitHub credential input');
    const { githubToken:_secret, ...publicPatch } = data;
    const oldState = await this.state();
    const user = oldState.records.users[id];
    if (!user) throw new Error('Record not found');
    const previousRef = typeof user.githubTokenRef === 'string' ? user.githubTokenRef : null;
    // Stage in an independently encrypted CAS vault, BEFORE the signed Git
    // authorization pointer changes. Never destroy the old secret before Git
    // publication is confirmed: an ambiguous push must remain recoverable.
    const nextRef = typeof token === 'string'
      ? await this.custody.stage(scope,id+':github-oauth:'+randomUUID(),
        {kind:'github-oauth',material:token}) : null;
    await this.mutate<void>('update:users:github-custody',
      {id,publicPatch,githubTokenRef:nextRef},state=>{
      const prior=state.records.users[id];
      if (!prior) throw new Error('Record not found');
      if ((prior.githubTokenRef ?? null)!==previousRef)
        throw new Error('Concurrent GitHub credential update; retry');
      const record=encode({...prior,...publicPatch,id,githubTokenRef:nextRef});
      return {operations:[this.put(state,'users',record)],result:undefined};
    });
    // Cleanup failure is explicitly surfaced. It does not undo the already
    // published safe pointer. Retrying cleanup must not revoke the new token.
    if (previousRef && previousRef !== nextRef)
      await this.custody.destroy(scope,previousRef);
  }
  async getRepositories(userId: string) { this.authorize(userId); return (await this.rows<S.Repository>('repositories')).filter(r=>r.userId===userId); }
  private dashboardAdmin(state: Replay, binding: AppRecord | undefined): boolean {
    if (!binding || binding.revokedAt!=null) return false;
    if (binding.orgId!=null) {
      const org=state.records.organizations[String(binding.orgId)];
      return !!org && (org.ownerId===this.principal || Object.values(state.records.orgMembers)
        .some(m=>m.orgId===binding.orgId && m.userId===this.principal && m.role==='admin'));
    }
    return binding.ownerId===this.principal;
  }
  async grantDashboardReceipt(bindingId:number,receiptId:number):Promise<{id:number}> {
    return this.mutate('dashboard-grant',{bindingId,receiptId},state=>{
      const binding=state.records.serviceDashboardBindings[bindingId];
      if (!this.dashboardAdmin(state,binding)) throw Object.assign(new Error('Forbidden'),{status:403});
      if (binding.scope!=='selected') throw Object.assign(new Error('Full-service scope requires binding revocation'),{status:409});
      const sealed=state.records.receipts[receiptId];
      const receipt=sealed && JSON.parse(String(sealed.originalCore ?? sealed.original));
      if (!receipt || receipt.userId!==binding.issuerId ||
          Object.values(state.records.serviceDashboardGrants).some(g=>g.bindingId===bindingId && g.receiptId===receiptId && g.revokedAt==null))
        throw Object.assign(new Error('Receipt unavailable or already granted'),{status:409});
      const id=this.next(state,'serviceDashboardGrants');
      return {operations:[this.put(state,'serviceDashboardGrants',{id,bindingId,receiptId,
        grantedBy:this.principal,createdAt:new Date().toISOString(),revokedAt:null})],result:{id}};
    });
  }
  async revokeDashboardAccess(resource:'grants'|'bindings',id:number):Promise<void> {
    await this.mutate('dashboard-revoke',{resource,id},state=>{
      const kind=resource==='grants'?'serviceDashboardGrants':'serviceDashboardBindings';
      const row=state.records[kind][id];
      const binding=resource==='grants'?state.records.serviceDashboardBindings[String(row?.bindingId)]:row;
      if (!row || row.revokedAt!=null || !this.dashboardAdmin(state,binding))
        throw Object.assign(new Error('Forbidden'),{status:403});
      return {operations:[this.put(state,kind,{...row,revokedAt:new Date().toISOString()})],result:undefined};
    });
  }
  getRepository(id: number) { return this.row<S.Repository>('repositories',id); }
  async getRepositoryByGithubId(githubId: number,userId: string) { return (await this.getRepositories(userId)).find(r=>r.githubId===githubId); }
  createRepository(data: S.InsertRepository) { return this.create<S.Repository>('repositories',data,{orgId:null,defaultBranch:'main',description:null,lastSyncedAt:null}); }
  createRepositoryIdempotent(data: S.InsertRepository,key: string) { return this.create<S.Repository>('repositories',data,{orgId:null,defaultBranch:'main',description:null,lastSyncedAt:null},key); }
  updateRepository(id: number,data: Partial<S.InsertRepository>) { return this.update('repositories',id,data); }
  updateRepositoryLastSynced(id: number) { return this.update('repositories',id,{lastSyncedAt:new Date()}); }
  deleteRepository(id: number) { return this.remove('repositories',id); }
  private async receipts() { return Object.values((await this.state()).records.receipts).map(r=>decode<S.AttestationReceipt>(JSON.parse(String(r.originalCore ?? r.original)))!); }
  private async receiptAnnotations() { return Object.values((await this.state()).records.receiptAnnotations ?? {}); }
  private async receiptOverlay(receipts: S.AttestationReceipt[], state?: Replay) {
    const map = new Map<string,{gitCommitUrl:string,gitCommitMessage:string | null}>();
    for (const row of state ? Object.values(state.records.receiptAnnotations ?? {}) : await this.receiptAnnotations()) map.set(String(row.receiptEntryHash), { gitCommitUrl: String(row.gitCommitUrl), gitCommitMessage: row.gitCommitMessage==null ? null : String(row.gitCommitMessage) });
    return receipts.map(r => {
      const annotation = map.get(r.entryHash);
      return annotation ? ({...r,gitCommitUrl: annotation.gitCommitUrl,gitCommitMessage: annotation.gitCommitMessage}) : r;
    });
  }
  async getAttestations(userId: string) {
    this.authorize(userId);
    const state = await this.state();
    const receipts = Object.values(state.records.receipts).map(r=>decode<S.AttestationReceipt>(JSON.parse(String(r.originalCore ?? r.original)))!);
    return (await this.receiptOverlay(receipts,state)).filter(r=>dashboardAllows(state,userId,r)).sort((a,b)=>b.id-a.id);
  }
  async getSystemAttestations() { return this.members.includes('forgeproof-system') ? this.getAttestations('forgeproof-system') : []; }
  async getAllAttestationsOrdered() { return (await this.receiptOverlay(await this.receipts())).sort((a,b)=>a.id-b.id); }
  async getAttestation(id: number) { return (await this.receiptOverlay(await this.receipts())).find(r=>r.id===id); }
  async getAuthorizedReceiptEvidence(id: number, viewer: string) {
    if (viewer !== this.principal) throw new Error('Receipt evidence access denied');
    const state = await this.state(), row = state.records.receipts[id];
    if (!row) throw new Error('Receipt not found');
    const core = JSON.parse(String(row.originalCore ?? row.original));
    if (!dashboardAllows(state, viewer, core)) throw new Error('Receipt evidence access denied');
    if (row.encryption && !this.receiptEncryptionKey)
      return { metadata: null, auditDetails: null, evidenceVisibility: { metadata: 'protected_unavailable', auditDetails: 'protected_unavailable' } };
    const scope = this.mailBinding();
    const original = row.encryption
      ? JSON.parse(restoreProtectedReceipt(row, scope.tenant, scope.repository, this.receiptEncryptionKey!).toString('utf8')) : core;
    return { metadata: redactEvidence(original.metadata ?? null), auditDetails: original.auditDetails ?? null,
      evidenceVisibility: { metadata: original.metadata == null ? 'not_recorded' : 'available', auditDetails: original.auditDetails == null ? 'not_recorded' : 'available' } };
  }
  /** Replit's ForgeProof lineage query must preserve repository and owner boundaries. */
  async getAttestationsByFilePath(filePath: string, userId: string, repositoryId: number | null, issuerId?: string): Promise<S.AttestationReceipt[]> {
    this.authorize(userId);
    const state = await this.state();
    const receipts = Object.values(state.records.receipts).map(r=>decode<S.AttestationReceipt>(JSON.parse(String(r.originalCore ?? r.original)))!);
    return (await this.receiptOverlay(receipts,state))
      .filter(r => r.filePath===filePath && (r.repositoryId ?? null)===repositoryId &&
        (issuerId ? r.userId===issuerId && dashboardAllows(state,userId,r)
          : r.userId===userId || r.userId==='forgeproof-system'))
      .sort((a,b)=>a.id-b.id);
  }
  async getAttestationByEntryHash(hash: string) { return (await this.receiptOverlay(await this.receipts())).find(r=>r.entryHash===hash); }
  async getAttestationsByParentId(id: number, ownerId: string = this.principal): Promise<S.AttestationReceipt[]> {
    this.authorize(ownerId);
    return (await this.receiptOverlay(await this.receipts()))
      .filter(r=>r.parentAttestationId===id && r.userId===ownerId)
      .sort((a,b)=>a.id-b.id);
  }
  async getLatestAttestation() { return (await this.getAllAttestationsOrdered()).at(-1); }
  createAttestation(data: S.InsertAttestationReceipt) { return this.createAttestationAndCount(data,randomUUID()); }
  async issueAttestationWithSigner(source: Omit<S.InsertAttestationReceipt,'signature'|'publicKey'|'entryHash'|'prevEntryHash'|'createdAt'>, signer: { publicKey: string; sign(input: Buffer): Promise<string> }, requestId: string, verifyNonCommercial?: (state: Replay) => Promise<void>) {
    if (!Buffer.isBuffer(this.receiptEncryptionKey) || this.receiptEncryptionKey.length !== 32)
      throw new Error('Receipt protection key required');
    const encryptionKey = this.receiptEncryptionKey;
    const scope = this.mailBinding();
    if (!this.members.includes(this.principal)) throw new Error('Receipt owner denied');
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid attestation source');
    if (!signer || typeof signer !== 'object' || typeof signer.publicKey !== 'string' || !signer.publicKey || typeof signer.sign !== 'function')
      throw new Error('Trusted signer required');
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,128}$/.test(requestId))
      throw new Error('Invalid requestId');
    const src = encode(source) as unknown as Omit<S.InsertAttestationReceipt,'signature'|'publicKey'|'entryHash'|'prevEntryHash'|'createdAt'>;
    const allowed = new Set(['userId','orgId','repositoryId','fileName','filePath','fileHash','modelName','modelProvider','countryOfOrigin','detectedCountry','complianceStatus','receiptVersion','signedAt','attestationType','parentAttestationId','auditVerdict','auditDetails','gitCommitUrl','gitCommitMessage','metadata']);
    if (Object.keys(src).some(field => !allowed.has(field))) throw new Error('Unknown attestation field');
    if (src.userId !== this.principal || !this.members.includes(src.userId)) throw new Error('Receipt owner denied');
    if (src.receiptVersion !== 'v1') throw new Error('Unsupported original receipt version');
    if (typeof src.signedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(src.signedAt) || !Number.isFinite(Date.parse(src.signedAt)))
      throw new Error('Explicit signedAt required');
    if (src.gitCommitUrl != null || src.gitCommitMessage != null)
      throw new Error('GitHub export provenance requires a signed annotation');
    const sourceFingerprint = createHmac('sha256',encryptionKey)
      .update('ForgeProof:atomic-signed-receipt:v1\n')
      .update(stable(src)).digest('hex');
    return this.mutate<S.AttestationReceipt>('attest-atomic-signed-and-count',
      {requestId,requestProof:'hmac-sha256:'+sourceFingerprint}, async state => {
      // Replay contains business state, not signing trust. Trust MUST come
      // from the independently pinned Git service configuration, never from
      // a caller record or a replayed organization.
      const service = this.service as typeof this.service & {
        trust?: {receiptKeys?: readonly string[]};
        options?: {trust?: {receiptKeys?: readonly string[]}};
      };
      const trusted = service.trust?.receiptKeys ?? service.options?.trust?.receiptKeys;
      if (!Array.isArray(trusted) || !trusted.includes(signer.publicKey))
        throw new Error('Signer key not trusted');
      const sub = Object.values(state.records.subscriptions).find(row=>row.userId===src.userId);

      if (!verifyNonCommercial && (!sub || (sub.plan!=='free' && !['active','trialing'].includes(String(sub.status))) ||
          (Number(sub.attestationLimit)!==-1 && Number(sub.attestationCount)>=Number(sub.attestationLimit))))
        throw new Error('Quota or subscription denied');
      const id = this.next(state,'receipts');
      const previousHash = typeof state.receiptHead === 'string' && /^[a-f0-9]{64}$/.test(state.receiptHead) ? state.receiptHead : 'genesis';
      const entryHash = createHash('sha256').update([
        src.fileHash,src.modelName,src.modelProvider,src.countryOfOrigin,previousHash,src.signedAt
      ].join('|')).digest('hex');
      const signature = await signer.sign(Buffer.from([entryHash,src.fileHash,src.signedAt].join('|')));
      const original = encode({
        id,userId:src.userId,orgId:src.orgId ?? null,
        repositoryId:src.repositoryId ?? null,fileName:src.fileName,
        filePath:src.filePath,fileHash:src.fileHash,
        modelName:src.modelName,modelProvider:src.modelProvider,
        countryOfOrigin:src.countryOfOrigin,
        detectedCountry:src.detectedCountry ?? null,
        complianceStatus:src.complianceStatus ?? 'unverified',
        signature,publicKey:signer.publicKey,
        entryHash,prevEntryHash:previousHash === 'genesis' ? null : previousHash,
        receiptVersion:src.receiptVersion,signedAt:src.signedAt,
        createdAt:new Date(),attestationType:src.attestationType ?? 'origin',
        parentAttestationId:src.parentAttestationId ?? null,
        auditVerdict:src.auditVerdict ?? null,
        auditDetails:src.auditDetails ?? null,
        gitCommitUrl:null,
        gitCommitMessage:null,
        metadata:src.metadata ?? null
      });
      const sealed = protectLegacyReceipt(Buffer.from(JSON.stringify(original)), scope.tenant, scope.repository, encryptionKey);
      const publicView = decode<S.AttestationReceipt>(JSON.parse(sealed.originalCore))!;
      return {operations:[
        this.put(state,'receipts',encode(sealed)),
        ...(!verifyNonCommercial && sub ? [this.put(state,'subscriptions',{...sub,attestationCount:Number(sub.attestationCount)+1})] : [])
      ],result:publicView};
    },requestId,verifyNonCommercial);
  }
  // Resolve only this principal's existing signed Git event; never append or
  // infer success from SQL, a receipt ID, or caller-supplied tenant metadata.
  async getAttestationByRequestId(requestId: string, verifyState: (state: Replay) => Promise<void>) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,128}$/.test(requestId))
      throw Object.assign(new Error('Invalid requestId'), {status:400});
    const state = await this.state(); // Replay verifies Git and receipt signatures.
    await verifyState(state);
    const key = digest([this.principal,'attest-atomic-signed-and-count',requestId]);
    const event = state.events.find(e => e.body.idempotencyKey === key);
    const first = event?.body.operations[0];
    if (!first || first.kind !== 'receipts' || first.action !== 'put') return undefined;
    const receipt = decode<S.AttestationReceipt>(JSON.parse(String(first.record.originalCore ?? first.record.original)));
    return receipt?.userId === this.principal ? receipt : undefined;
  }
  createAttestationAndCount(data: S.InsertAttestationReceipt,key: string) {
    // The source signature is created by the existing trusted ForgeProof signer,
    // BEFORE entering IStorage. Never invent a timestamp or re-sign on retry.
    if (!Buffer.isBuffer(this.receiptEncryptionKey) || this.receiptEncryptionKey.length !== 32)
      throw new Error('Receipt protection key required');
    const encryptionKey = this.receiptEncryptionKey;
    const scope = this.mailBinding();
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('Invalid attestation input');
    const originalInput = encode(data) as unknown as S.InsertAttestationReceipt;
    const allowed = new Set(['userId','orgId','repositoryId','fileName','filePath','fileHash',
      'modelName','modelProvider','countryOfOrigin','detectedCountry','complianceStatus',
      'signature','publicKey','entryHash','prevEntryHash','receiptVersion','signedAt',
      'attestationType','parentAttestationId','auditVerdict','auditDetails','gitCommitUrl',
      'gitCommitMessage','metadata']);
    if (Object.keys(originalInput).some(field => !allowed.has(field)))
      throw new Error('Unknown attestation field');
    if (originalInput.userId !== this.principal || !this.members.includes(originalInput.userId))
      throw new Error('Receipt owner denied');
    if (typeof originalInput.signedAt !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(originalInput.signedAt) ||
        !Number.isFinite(Date.parse(originalInput.signedAt)))
      throw new Error('Explicit signedAt required');
    if (typeof originalInput.signature !== 'string' || !originalInput.signature)
      throw new Error('Original signed signature required');
    if (typeof originalInput.entryHash !== 'string' || !/^[a-f0-9]{64}$/.test(originalInput.entryHash))
      throw new Error('Original entryHash required');
    if (originalInput.receiptVersion !== 'v1')
      throw new Error('Unsupported original receipt version');
    // Export provenance is NOT part of the original legacy Ed25519 signature.
    // It must be independently committed by the owner after a real GitHub push.
    if (originalInput.gitCommitUrl != null || originalInput.gitCommitMessage != null)
      throw new Error('GitHub export provenance requires a signed annotation');

    // Any private metadata is used solely for this HMAC and AES-GCM envelope.
    // An ordinary SHA256(data) in the signed audit trail would permit offline
    // dictionary attacks against private fields.
    const sourceFingerprint = createHmac('sha256',encryptionKey)
      .update('ForgeProof:new-signed-receipt:v2\n')
      .update(stable(originalInput)).digest('hex');
    return this.mutate<S.AttestationReceipt>('attest-and-count',
      {requestProof:'hmac-sha256:'+sourceFingerprint},state=> {
      const sub = Object.values(state.records.subscriptions).find(row=>row.userId===originalInput.userId);
      if (!sub || (sub.plan!=='free' && !['active','trialing'].includes(String(sub.status))) ||
          (Number(sub.attestationLimit)!==-1 && Number(sub.attestationCount)>=Number(sub.attestationLimit)))
        throw new Error('Quota or subscription denied');
      const id = this.next(state,'receipts');
      const original = encode({
        id,userId:originalInput.userId,orgId:originalInput.orgId ?? null,
        repositoryId:originalInput.repositoryId ?? null,fileName:originalInput.fileName,
        filePath:originalInput.filePath,fileHash:originalInput.fileHash,
        modelName:originalInput.modelName,modelProvider:originalInput.modelProvider,
        countryOfOrigin:originalInput.countryOfOrigin,
        detectedCountry:originalInput.detectedCountry ?? null,
        complianceStatus:originalInput.complianceStatus ?? 'unverified',
        signature:originalInput.signature,publicKey:originalInput.publicKey,
        entryHash:originalInput.entryHash,prevEntryHash:originalInput.prevEntryHash ?? null,
        receiptVersion:originalInput.receiptVersion,signedAt:originalInput.signedAt,
        createdAt:new Date(),attestationType:originalInput.attestationType ?? 'origin',
        parentAttestationId:originalInput.parentAttestationId ?? null,
        auditVerdict:originalInput.auditVerdict ?? null,
        auditDetails:originalInput.auditDetails ?? null,
        gitCommitUrl:originalInput.gitCommitUrl ?? null,
        gitCommitMessage:originalInput.gitCommitMessage ?? null,
        metadata:originalInput.metadata ?? null
      });
      // protectLegacyReceipt verifies the original Ed25519 signature and
      // preserves all private fields as exact encrypted source bytes.
      const sealed = protectLegacyReceipt(Buffer.from(JSON.stringify(original)),
        scope.tenant,scope.repository,encryptionKey);
      const publicView = decode<S.AttestationReceipt>(JSON.parse(sealed.originalCore))!;
      return {operations:[
        this.put(state,'receipts',encode(sealed)),
        this.put(state,'subscriptions',{...sub,attestationCount:Number(sub.attestationCount)+1})
      ],result:publicView};
    },key);
  }
  async updateAttestationGitCommitUrl(id: number,url: string,message?: string): Promise<void> {
    if (this.principal !== this.guardUserId) throw new Error('Only owner may annotate receipt git commits');
    if (typeof url !== 'string') throw new Error('Invalid git commit URL');
    const matched = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/commit\/([a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.exec(url);
    if (!matched || [matched[1],matched[2]].some(c => c === '.' || c === '..')) throw new Error('Invalid git commit URL');
    // Git objects are case-insensitive hexadecimal, but canonical signed-Git
    // annotations store lowercase SHA and treat case variants idempotently.
    const normalized = `https://github.com/${matched[1]}/${matched[2]}/commit/${matched[3].toLowerCase()}`;
    if (message !== undefined && message !== null && (typeof message !== 'string' || message.length < 1 || message.length > 1024)) throw new Error('Invalid git commit message');
    const normalizedMessage = message == null ? null : message;
    await this.mutate('annotate-receipt',{id,url:normalized,message:normalizedMessage},state => {
      const receiptRecord = state.records.receipts[id];
      if (!receiptRecord) throw new Error('Receipt not found');
      const receipt = decode<S.AttestationReceipt>(JSON.parse(String(receiptRecord.originalCore ?? receiptRecord.original)))!;
      if (receipt.userId !== this.principal) throw new Error('Only receipt owner may annotate');
      const existing = Object.values(state.records.receiptAnnotations ?? {}).find((v:AppRecord)=>v.receiptEntryHash===receipt.entryHash);
      if (existing) {
        if (existing.gitCommitUrl===normalized && (existing.gitCommitMessage ?? null)===normalizedMessage) return {operations:[],result:undefined};
        throw new Error('Conflicting receipt annotation exists');
      }
      const annotation = encode({id:receipt.id,receiptEntryHash:receipt.entryHash,gitCommitUrl:normalized,gitCommitMessage:normalizedMessage,createdAt:new Date()});
      return {operations:[this.put(state,'receiptAnnotations',annotation)],result:undefined};
    });
  }
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
    if(!sub || (sub.plan!=='free' && !['active','trialing'].includes(String(sub.status))) || (Number(sub.apiKeyLimit)!==-1 && count>=Number(sub.apiKeyLimit))) throw new Error('API key quota denied');
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
    await this.mutate('delete:organizations',{id},state=>{
      const bindings=Object.values(state.records.serviceDashboardBindings).filter(b=>b.orgId===id);
      const bindingIds=new Set(bindings.map(b=>Number(b.id)));
      return {operations:[
        ...Object.values(state.records.serviceDashboardGrants).filter(g=>bindingIds.has(Number(g.bindingId))).map(g=>this.del(state,'serviceDashboardGrants',Number(g.id))),
        ...bindings.map(b=>this.del(state,'serviceDashboardBindings',Number(b.id))),
        ...Object.values(state.records.orgMembers).filter(m=>m.orgId===id).map(m=>this.del(state,'orgMembers',Number(m.id))),
        this.del(state,'organizations',id),
      ],result:undefined};
    });
  }
  async getOrgMembers(id: number) { return (await this.rows<S.OrgMember>('orgMembers')).filter(m=>m.orgId===id); }
  async getOrgMember(id: number,userId: string) { this.authorize(userId); return (await this.getOrgMembers(id)).find(m=>m.userId===userId); }
  addOrgMember(data: S.InsertOrgMember) { return this.create<S.OrgMember>('orgMembers',data,{role:'member'}); }
  async addOrgMemberAuthorized(orgId:number,userId:string,role:'admin'|'member'):Promise<S.OrgMember> {
    return this.mutate('org.member_added',{orgId,userId,role},state=>{
      const org=state.records.organizations[orgId];
      const owner=org?.ownerId===this.principal;
      const admin=Object.values(state.records.orgMembers).some(m=>m.orgId===orgId && m.userId===this.principal && m.role==='admin');
      if (!org || (!owner && (role==='admin' || !admin))) throw Object.assign(new Error('Forbidden'),{status:403});
      if (!state.records.users[userId]) throw Object.assign(new Error('Unknown application user'),{status:400});
      if (Object.values(state.records.orgMembers).some(m=>m.orgId===orgId && m.userId===userId))
        throw Object.assign(new Error('User is already a member'),{status:409});
      const row={id:this.next(state,'orgMembers'),orgId,userId,role,createdAt:new Date().toISOString()};
      return {operations:[this.put(state,'orgMembers',row)],result:decode<S.OrgMember>(row)!};
    });
  }
  async removeOrgMember(id: number,userId: string) { const member=await this.getOrgMember(id,userId); if (member) await this.remove('orgMembers',member.id); }
  async updateOrgMemberRole(id: number,userId: string,role: string) { const member=await this.getOrgMember(id,userId); if (!member) throw new Error('Member not found'); await this.update('orgMembers',member.id,{role}); }
  async createAuditLog(data: S.InsertAuditLog) {
    if (data == null || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid audit metadata input');
    if (data.metadata == null) {
      const {metadata,...safe}=data;
      return this.create<S.AuditLog>('auditLogs',safe,{userId:null,resourceType:null,resourceId:null,ipAddress:null})
        .then(row=>({...row,metadata:null}));
    }
    const auditKey = this.auditEncryptionKey;
    if (!Buffer.isBuffer(auditKey) || auditKey.length !== 32) throw new Error('Private Git-backed audit metadata unavailable');
    const allowed = new Set(['userId','action','resourceType','resourceId','metadata','ipAddress']);
    const keys = Object.keys(data as Record<string, unknown>);
    if (keys.some(k=>!allowed.has(k))) throw new Error('Invalid audit metadata input');
    if (typeof data.action !== 'string' || !data.action.trim() || data.action.length > 65536)
      throw new Error('Invalid audit action');
    const scope = this.mailBinding();
    const requestToken = randomUUID();
    return this.mutate<S.AuditLog>('create-protected-audit',{requestToken},state => {
      const id = this.next(state,'auditLogs');
      const createdAt = new Date();
      const row: S.AuditLog = {
        id,
        userId: data.userId ?? null,
        action: data.action,
        resourceType: data.resourceType ?? null,
        resourceId: data.resourceId ?? null,
        metadata: data.metadata,
        ipAddress: data.ipAddress ?? null,
        createdAt,
      };
      const core = Buffer.from(JSON.stringify(row));
      const protectedRecord = protectLegacyAuditLog(core, scope.tenant, scope.repository, auditKey);
      return {operations:[this.put(state,'auditLogs',encode(protectedRecord))], result:row};
    });
  }
  async getAuditLogs(userId?: string,limit=100) {
    if (userId) this.authorize(userId);
    // this.state() performs full signed Git replay and verifies protected audit
    // cores before JSON.parse here. Unauthenticated/corrupt history fails closed.
    const rows = Object.values((await this.state()).records.auditLogs)
      .map(r => decode<S.AuditLog>(r.auditCore ? JSON.parse(String(r.auditCore)) : r)!);
    // Protected historical metadata never enters the IStorage HTTP/UI read model.
    return rows.filter(a => !userId || a.userId === userId).reverse().slice(0,limit)
      .map(a => ({...a,metadata:null}));
  }
  async getAuthorizedAuditLogs(viewer: string, limit = 100) {
    if (viewer !== this.principal) throw new Error('Audit evidence access denied');
    const state = await this.state(), scope = this.mailBinding();
    return Object.values(state.records.auditLogs).map(row => {
      const core = row.auditCore ? JSON.parse(String(row.auditCore)) : row;
      return { row, core };
    }).filter(({ core }) => core.userId === viewer).reverse().slice(0, limit).map(({ row, core }) => {
      if (row.encryption && !this.auditEncryptionKey) return { ...decode<S.AuditLog>(core), metadata: null, metadataVisibility: 'protected_unavailable' };
      const original = row.encryption ? JSON.parse(restoreProtectedAuditLog(row, scope.tenant, scope.repository, this.auditEncryptionKey!).toString('utf8')) : core;
      return { ...decode<S.AuditLog>(original), metadata: redactEvidence(original.metadata ?? null),
        metadataVisibility: original.metadata == null ? 'not_recorded' : 'available' };
    });
  }
  async getAuditLogsByResource(type: string,id: string) { return (await this.getAuditLogs(undefined,Number.MAX_SAFE_INTEGER)).filter(a=>a.resourceType===type&&a.resourceId===id); }
  async clearAllAttestations(): Promise<void> { throw new Error('Immutable history cannot be cleared'); }
  async getSubscription(userId: string) { this.authorize(userId); return (await this.rows<S.Subscription>('subscriptions')).find(s=>s.userId===userId); }
  async applyStripeSubscription(eventId: string, created: number, eventDigest: string, input: S.InsertSubscription): Promise<void> {
    if (!/^evt_[A-Za-z0-9]+$/.test(eventId) || !Number.isSafeInteger(created) || !/^[a-f0-9]{64}$/.test(eventDigest))
      throw new Error('Invalid billing event identity');
    const patch=encode(input);
    await this.mutate('stripe-provider-event',{eventId,eventDigest},state=>{
      const user=state.records.users[input.userId];
      if (!user || (user.stripeCustomerId && user.stripeCustomerId!==input.stripeCustomerId))
        throw new Error('Billing customer ownership denied');
      const old=Object.values(state.records.subscriptions).find(s=>s.userId===input.userId);
      if (old && (old.stripeCustomerId && old.stripeCustomerId!==input.stripeCustomerId ||
          old.stripeSubscriptionId && input.stripeSubscriptionId && old.stripeSubscriptionId!==input.stripeSubscriptionId))
        throw new Error('Billing subscription ownership denied');
      if (old && Number(old.billingEventCreated)>created) return {operations:[],result:undefined};
      const start=patch.currentPeriodStart ?? old?.currentPeriodStart ?? new Date(created*1000).toISOString();
      const renewed=!!old?.currentPeriodStart && Date.parse(String(start))>Date.parse(String(old.currentPeriodStart));
      const record=encode({...old,...patch,id:old?.id ?? this.next(state,'subscriptions'),
        currentPeriodStart:start, attestationCount:!old || renewed ? 0 : old.attestationCount,
        billingEventId:eventId,billingEventCreated:created,createdAt:old?.createdAt ?? new Date()});
      return {operations:[this.put(state,'subscriptions',record)],result:undefined};
    },eventId);
  }
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
  private requireMailKey() {
    if (!Buffer.isBuffer(this.mailEncryptionKey) || this.mailEncryptionKey.length !== 32) throw new Error('Durable Git-backed pending-email queue unavailable');
    return this.mailEncryptionKey;
  }
  private mailBinding(): {tenant:string; repository:string} {
    // Bind encryption to the verified signed-Git stream, not a user ID or
    // generic custody namespace that might be reused in another tenant.
    const scope = this.service as typeof this.service & {tenant?:unknown; repository?:unknown};
    if (typeof scope.tenant !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(scope.tenant) ||
        typeof scope.repository !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(scope.repository))
      throw new Error('Private Git mail scope unavailable');
    return {tenant:scope.tenant,repository:scope.repository};
  }

  private decodePendingEmail(record: AppRecord): PrivatePendingEmail {
    const key = this.requireMailKey();
    const scope = this.mailBinding();
    const restored = restoreQueuedEmail(record, scope.tenant, scope.repository, key);
    return {
      id: Number(record.id),
      to: restored.to,
      subject: restored.subject,
      bodyText: restored.bodyText,
      bodyHtml: restored.bodyHtml,
      status: String(record.status) as PrivatePendingEmail['status'],
      retryCount: Number(record.retryCount),
      nextRetryAt: new Date(String(record.nextRetryAt)),
      createdAt: new Date(String(record.createdAt)),
    };
  }

  async createPendingEmail(email: InsertPrivatePendingEmail): Promise<PrivatePendingEmail> {
    const key = this.requireMailKey();
    const scope = this.mailBinding();
    if ((email.status ?? 'pending') !== 'pending' || (email.retryCount ?? 0) !== 0)
      throw new Error('New pending email must begin pending with zero attempts');
    const requestToken = randomUUID();
    // Keep original private content exclusively in this closure. The stored
    // signed Git request and audit fingerprint contain only random request ID.
    return this.mutate<PrivatePendingEmail>('create-pending-email',{requestToken},state => {
      const id = this.next(state,'pendingEmails');
      const createdAt = new Date();
      const nextRetryAt = email.nextRetryAt ?? createdAt;
      const status = 'pending';
      const retryCount = 0;
      const protectedRecord = protectQueuedEmail({to:email.to,subject:email.subject,bodyText:email.bodyText,bodyHtml:email.bodyHtml}, scope.tenant, scope.repository, id, key);
      const row = encode({id,status,retryCount,nextRetryAt,createdAt,...protectedRecord});
      return { operations:[this.put(state,'pendingEmails',row)], result:this.decodePendingEmail(row) };
    });
  }

  async getDuePendingEmails(): Promise<PrivatePendingEmail[]> {
    this.requireMailKey();
    const now = Date.now();
    const rows = await this.rows<AppRecord>('pendingEmails');
    return rows
      .filter(r => r.status === 'pending' && Date.parse(String(r.nextRetryAt)) <= now)
      .sort((a,b) => Number(a.id)-Number(b.id))
      .map(r => this.decodePendingEmail(encode(r)));
  }

  async updatePendingEmail(id: number, data: Partial<InsertPrivatePendingEmail>): Promise<void> {
    this.requireMailKey();
    this.mailBinding();
    const allowed = new Set(['status','retryCount','nextRetryAt']);
    if (data == null || typeof data !== 'object' || Array.isArray(data) ||
        Object.keys(data).some(k=>!allowed.has(k))) throw new Error('Pending email content immutable');
    const safe = encode(data);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid pending email id');
    return this.mutate<void>('update-pending-email',{id,data:safe},state => {
      const old = state.records.pendingEmails[id];
      if (!old) throw new Error('Pending email not found');
      if (old.status !== 'pending') throw new Error('Pending email terminal status immutable');
      const next = encode({
        ...old,
        status: safe.status ?? old.status,
        retryCount: safe.retryCount ?? old.retryCount,
        nextRetryAt: safe.nextRetryAt ?? old.nextRetryAt,
      });
      const terminal = new Set(['sent','failed']);
      if (terminal.has(String(old.status)) && next.status !== old.status) throw new Error('Pending email terminal status immutable');
      if (old.status === 'pending' && !['pending','sent','failed'].includes(String(next.status))) throw new Error('Invalid pending status transition');
      if (Number(next.retryCount) < Number(old.retryCount)) throw new Error('Pending email retryCount must be monotonic');
      return { operations:[this.put(state,'pendingEmails',next)], result:undefined };
    });
  }
}
