import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { canonical, hash, exact, identifier, positive, signatureValid, validateRecord, validateReceipt, classes } from './schema.mjs';
import { verifyProtectedReceiptCore } from './protected-receipt.mjs';
import { verifyProtectedAuditCore } from './protected-audit.mjs';
const receiptSignedCore = record => Object.prototype.hasOwnProperty.call(record, 'originalCore') ? verifyProtectedReceiptCore(record) : validateReceipt(record);
const ZERO = '0'.repeat(40);
export const MAX_EVENT_BYTES = 8 * 1024 * 1024;
export class ConflictError extends Error {}
export class IntegrityError extends Error {}
/** Explicit nonproduction service. A separate private bare repository is mandatory. */
export class GitAppStateService {
  constructor({ directory, tenant, repository, trust, checkpoint, signer, maxEventBytes = MAX_EVENT_BYTES }) {
    if (process.env.NODE_ENV === 'production') throw new Error('Experimental Git app state is disabled in production');
    identifier(tenant); identifier(repository);
    if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1 || maxEventBytes > MAX_EVENT_BYTES) throw new Error('Invalid event size limit');
    this.maxEventBytes = maxEventBytes;
    if (checkpoint === undefined) throw new Error('Explicit trusted checkpoint (or null for bootstrap) required');
    if (checkpoint !== null) {
      exact(checkpoint, ['commit','eventHash','sequence']);
      if (!/^[a-f0-9]{40}$/.test(checkpoint.commit) || !/^[a-f0-9]{64}$/.test(checkpoint.eventHash)) throw new Error('Invalid checkpoint');
      positive(checkpoint.sequence);
    }
    exact(trust, ['eventKeys','receiptKeys','receiptPredecessor']);
    if (trust.receiptPredecessor != null && !/^[a-f0-9]{64}$/.test(trust.receiptPredecessor)) throw new Error('Invalid receipt anchor');
    this.directory = directory; this.tenant = tenant; this.repository = repository;
    this.ref = `refs/heads/forgeproof/${tenant}/${repository}`;
    this.trust = structuredClone(trust); this.checkpoint = structuredClone(checkpoint); this.signer = signer;
    this.ready = this.assertPrivateBare();
  }
  async git(args, input) {
    // Never shell interpolation, working-tree checkout, index, hooks or transport.
    const child = execFile('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsync=committed,reference', '-c', 'core.fsyncMethod=fsync', '--git-dir=' + this.directory, ...args], {
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1',
        GIT_AUTHOR_NAME: 'ForgeProof event service', GIT_AUTHOR_EMAIL: 'event-service@invalid', GIT_COMMITTER_NAME: 'ForgeProof event service', GIT_COMMITTER_EMAIL: 'event-service@invalid' },
      maxBuffer: 32 * 1024 * 1024,
    });
    child.stdin.on('error', () => {}); // A premature Git exit is reported by the close handler.
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    return await new Promise((resolve, reject) => {
      let out = '', err = '';
      child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
      child.on('error', reject); child.on('close', code => code === 0 ? resolve(args[0] === 'show' ? out : out.trimEnd()) : reject(new Error(`git ${args[0]} failed: ${err}`)));
    });
  }
  async assertPrivateBare() {
    if (await realpath(this.directory) === await realpath(process.cwd())) throw new Error('Source repository forbidden');
    if (await this.git(['rev-parse', '--is-bare-repository']) !== 'true') throw new Error('Separate bare store required');
    if (await this.git(['rev-parse', '--show-object-format']) !== 'sha1') throw new Error('Unsupported Git object format');
    // Shallow/grafted ancestry is forbidden; replace objects are disabled on every invocation.
    if (await this.git(['rev-parse', '--is-shallow-repository']) !== 'false') throw new IntegrityError('Shallow store');
  }
  observe(checkpoint) {
    const current = this.checkpoint;
    if (current && (!checkpoint || checkpoint.sequence < current.sequence || (checkpoint.sequence === current.sequence && (checkpoint.commit !== current.commit || checkpoint.eventHash !== current.eventHash)))) throw new IntegrityError('History behind or divergent from observed checkpoint');
    this.checkpoint = structuredClone(checkpoint);
  }
  async head() {
    // Apple Git can omit dangling symbolic refs from for-each-ref entirely.
    // Reject both dangling and live symbolic refs before considering a ref absent.
    const symbolicTarget = await this.git(['symbolic-ref', '-q', this.ref]).catch(error => {
      if (error?.message === 'git symbolic-ref failed: ') return null;
      throw new IntegrityError('Unable to verify direct Git stream ref');
    });
    if (symbolicTarget !== null) throw new IntegrityError('Symbolic or dangling symref forbidden');
    const refs = await this.git(['for-each-ref', '--format=%(refname) %(objectname) %(symref)', this.ref]);
    const line = refs.split('\n').find(v => v.startsWith(this.ref + ' '));
    if (!line) return null;
    const [, oid, symbolic] = line.split(' ');
    if (symbolic || !/^[a-f0-9]{40}$/.test(oid)) throw new IntegrityError('Symbolic or invalid stream ref');
    return oid;
  }
  async replay() {
    await this.ready;
    const tip = await this.head();
    if (!tip) {
      if (this.checkpoint !== null) throw new IntegrityError('Missing trusted history');
      return { checkpoint: null, records: Object.fromEntries(classes.map(k => [k, Object.create(null)])), events: [], versions: {}, receiptHead: this.trust.receiptPredecessor ?? null };
    }
    const commits = (await this.git(['rev-list', '--reverse', '--topo-order', tip])).split('\n');
    const records = Object.fromEntries(classes.map(k => [k, Object.create(null)]));
    const state = { records, versions: {}, events: [], receiptHead: this.trust.receiptPredecessor ?? null, checkpoint: null };
    let previous = null, previousHash = null, pinned = this.checkpoint === null;
    for (const commit of commits) {
      // Read real object parents: rev-list parent output can be altered by legacy grafts.
      const headers = (await this.git(['cat-file', '-p', commit])).split('\n\n')[0].split('\n');
      const parents = headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7));
      if (parents.length !== (previous ? 1 : 0) || (previous && parents[0] !== previous)) throw new IntegrityError('Nonlinear or missing ancestry');
      const tree = await this.git(['ls-tree', commit]);
      if (!/^100644 blob [a-f0-9]{40}\tevent.json$/.test(tree)) throw new IntegrityError('Unexpected tree content');
      const raw = await this.git(['show', `${commit}:event.json`]);
      if (Buffer.byteLength(raw) > this.maxEventBytes) throw new IntegrityError('Event too large');
      const event = JSON.parse(raw);
      exact(event, ['body','signature']);
      if (raw !== canonical(event)) throw new IntegrityError('Noncanonical event');
      const b = event.body;
      exact(b, ['version','tenant','repository','sequence','previous','actor','keyId','idempotencyKey','requestHash','operations']);
      if (b.version !== 1 || b.tenant !== this.tenant || b.repository !== this.repository || b.sequence !== state.events.length + 1 || b.previous !== previousHash) throw new IntegrityError('Event chain/scope mismatch');
      identifier(b.actor); identifier(b.keyId); identifier(b.idempotencyKey);
      const key = this.trust.eventKeys?.[b.keyId];
      if (!key || key.actor !== b.actor || !signatureValid(canonical(b), event.signature, key.publicKey)) throw new IntegrityError('Untrusted event signature');
      if (b.requestHash !== hash(canonical({ actor: b.actor, operations: b.operations }))) throw new IntegrityError('Request hash mismatch');
      if (state.events.some(e => e.body.idempotencyKey === b.idempotencyKey)) throw new IntegrityError('Repeated idempotency key');
      this.apply(state, b.operations, b.sequence);
      const eventHash = hash(canonical(event));
      if (this.checkpoint?.commit === commit) {
        if (this.checkpoint.eventHash !== eventHash || this.checkpoint.sequence !== b.sequence) throw new IntegrityError('Checkpoint mismatch');
        pinned = true;
      }
      state.events.push(event); state.checkpoint = { commit, eventHash, sequence: b.sequence };
      previous = commit; previousHash = eventHash;
    }
    if (!pinned) throw new IntegrityError('Trusted checkpoint absent: rollback/rewrite');
    this.observe(state.checkpoint);
    return state;
  }
  /** Reconstructed read models are disposable; every read verifies the authoritative chain. */
  async get(kind, id) {
    if (!classes.includes(kind)) throw new Error('Unknown class');
    return (await this.replay()).records[kind][id];
  }
  async list(kind) {
    if (!classes.includes(kind)) throw new Error('Unknown class');
    return Object.values((await this.replay()).records[kind]);
  }
  apply(state, operations, sequence) {
    if (!Array.isArray(operations) || !operations.length || operations.length > 1000) throw new Error('Invalid transaction size');
    const touched = new Set();
    for (const op of operations) {
      exact(op, ['kind','id','action','expectedVersion','record']);
      if (!classes.includes(op.kind)) throw new Error('Unknown class');
      if (op.kind === 'users' || op.kind === 'sessions') identifier(op.id); else positive(op.id);
      const address = `${op.kind}/${op.id}`;
      if (touched.has(address)) throw new Error('Repeated transaction record');
      touched.add(address);
      if (op.expectedVersion !== (state.versions[address] ?? null)) throw new ConflictError('Record version conflict: ' + address);
      const existing = state.records[op.kind][op.id];
      if (op.action === 'delete') {
        if (!existing || ['receipts','auditLogs'].includes(op.kind) || op.record !== undefined) throw new Error('Invalid deletion');
        delete state.records[op.kind][op.id];
      } else if (op.action === 'put') {
        validateRecord(op.kind, op.record);
        if (op.kind === 'auditLogs' && Object.prototype.hasOwnProperty.call(op.record, 'auditCore')) verifyProtectedAuditCore(op.record);
        if (op.kind === 'auditLogs' && existing) throw new Error('Audit logs are immutable');
        if (op.record.id !== op.id) throw new Error('Record ID mismatch');
        if (op.kind === 'receipts') {
          if (existing) throw new Error('Receipts are immutable');
          const r = receiptSignedCore(op.record);
          if (!this.trust.receiptKeys?.includes(r.publicKey)) throw new IntegrityError('Untrusted historical receipt key');
          // Replit's original API requires the same owner for child attestations.
          // Enforce this invariant on signed events and keyless replay as well.
          if (r.parentAttestationId != null) {
            if (!Number.isSafeInteger(r.parentAttestationId) || r.parentAttestationId < 1)
              throw new IntegrityError('Invalid historical parent ID');
            const parentRecord = state.records.receipts[r.parentAttestationId];
            if (!parentRecord) throw new IntegrityError('Missing historical parent receipt');
            const parent = receiptSignedCore(parentRecord);
            if (parent.userId !== r.userId) throw new IntegrityError('Historical parent owner mismatch');
          }
          if (r.prevEntryHash !== state.receiptHead) throw new IntegrityError('Historical receipt predecessor mismatch');
          if (Object.values(state.records.receipts).some(v => receiptSignedCore(v).entryHash === r.entryHash)) throw new Error('Duplicate receipt hash');
          state.receiptHead = r.entryHash;
        }
        state.records[op.kind][op.id] = structuredClone(op.record);
      } else throw new Error('Unknown action');
      state.versions[address] = sequence;
    }
  }
  /** Shared append/preflight validation, including the complete signed envelope. No Git writes. */
  async prepareEvent(state, { idempotencyKey, operations }) {
    identifier(idempotencyKey);
    if (!this.signer) throw new Error('Read-only service');
    const { actor, keyId } = this.signer;
    identifier(actor); identifier(keyId);
    const sequence = (state.checkpoint?.sequence ?? 0) + 1;
    positive(sequence);
    this.apply(state, operations, sequence);
    const body = { version: 1, tenant: this.tenant, repository: this.repository, sequence, previous: state.checkpoint?.eventHash ?? null, actor, keyId, idempotencyKey, requestHash: hash(canonical({ actor, operations })), operations };
    const payload = canonical(body);
    // Preserve the existing body ceiling as well as enforcing the full envelope limit.
    if (Buffer.byteLength(payload) > MAX_EVENT_BYTES - 1024) throw new Error('Event too large');
    const signature = await this.signer.sign(Buffer.from(payload));
    const key = this.trust.eventKeys?.[keyId];
    if (!key || key.actor !== actor || !signatureValid(payload, signature, key.publicKey)) throw new IntegrityError('Signer not authorized');
    const event = { body, signature };
    if (Buffer.byteLength(canonical(event)) > this.maxEventBytes) throw new Error('Event too large');
    return event;
  }
  /** Validate every future event before any append. Existing identical requests are skipped. */
  async preflight(transactions) {
    // Isolate the complete input from mutation across awaits, just as append does.
    transactions = JSON.parse(canonical(transactions));
    const state = await this.replay();
    const seen = new Map(state.events.map(e => [e.body.idempotencyKey, e.body]));
    for (const tx of transactions) {
      exact(tx, ['idempotencyKey','operations']);
      identifier(tx.idempotencyKey);
      const old = seen.get(tx.idempotencyKey);
      if (old) {
        if (old.actor !== this.signer?.actor || canonical(old.operations) !== canonical(tx.operations)) throw new ConflictError('Migration idempotency conflict');
        continue;
      }
      const event = await this.prepareEvent(state, tx);
      // Actual signed event hashes give the next envelope its exact previous/sequence fields.
      state.checkpoint = { commit: state.checkpoint?.commit ?? ZERO, eventHash: hash(canonical(event)), sequence: event.body.sequence };
      seen.set(tx.idempotencyKey, event.body);
    }
  }
  /** Atomic transaction. Caller must supply record versions; retries never overwrite a competing update. */
  async append({ idempotencyKey, operations }, { beforeCAS } = {}) {
    identifier(idempotencyKey);
    if (!this.signer) throw new Error('Read-only service');
    // Snapshot mutable caller input before any await/signing.
    operations = JSON.parse(canonical(operations));
    await this.ready;
    const { actor, keyId } = this.signer;
    identifier(actor); identifier(keyId);
    const requestHash = hash(canonical({ actor, operations }));
    for (let attempt = 0; attempt < 8; attempt++) {
      const state = await this.replay();
      const retry = state.events.find(e => e.body.idempotencyKey === idempotencyKey);
      if (retry) {
        if (retry.body.requestHash !== requestHash) throw new ConflictError('Idempotency key reused with different request');
        this.observe(state.checkpoint);
        return { checkpoint: state.checkpoint, event: retry, duplicate: true };
      }
      const event = await this.prepareEvent(state, { idempotencyKey, operations });
      const seq = event.body.sequence;
      const blob = await this.git(['hash-object', '-w', '--stdin'], canonical(event));
      const tree = await this.git(['mktree'], `100644 blob ${blob}\tevent.json\n`);
      const parent = state.checkpoint?.commit;
      const commit = await this.git(['commit-tree', tree, ...(parent ? ['-p', parent] : [])], 'ForgeProof app state v1\n');
      if (beforeCAS) await beforeCAS({ attempt, parent, commit });
      try { await this.git(['update-ref', '--no-deref', this.ref, commit, parent ?? ZERO]); }
      catch (error) {
        if (await this.head() === (parent ?? null)) throw error;
        continue;
      }
      const checkpoint = { commit, eventHash: hash(canonical(event)), sequence: seq };
      this.observe(checkpoint);
      return { checkpoint, event, duplicate: false };
    }
    throw new ConflictError('Concurrent writer retry limit');
  }
}
