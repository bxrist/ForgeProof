// Git-authoritative application state held in a private GitHub repository.
// Transport is the GitHub Git Data API through the project's authorized GitHub
// connection (no SSH key, no database). Every commit carries one signed event;
// ref updates are non-forced, so GitHub rejects any write that is not a fast
// forward of the head this process verified (compare-and-swap).
import { createHash } from 'node:crypto';
import { canonical, hash, exact, identifier, signatureValid, classes } from './schema.mjs';
import { GitAppStateService, IntegrityError, ConflictError } from './store.mjs';

const enc = encodeURIComponent;

export class GitHubTransport {
  constructor({ owner, repo, request }) {
    identifier(owner.replace(/\./g, '_')); identifier(repo.replace(/\./g, '_'));
    this.base = `/repos/${enc(owner)}/${enc(repo)}`;
    this.request = request; // (path, {method, body}) => Response-like
  }
  async call(path, method = 'GET', body) {
    const started = performance.now();
    // Fixed operation labels only: never log repository/ref names, hashes,
    // request bodies, response bodies, credentials, or exception messages.
    const resource = /^\/git\/(commits|trees|blobs|refs?)(?:\/|$)/.exec(path)?.[1];
    const operation = ['GET', 'POST', 'PATCH'].includes(method) && resource
      ? `${method}:${resource}` : 'other';
    let status = null;
    let retries = 0;
    try {
    const request = () => this.request(this.base + path, {
      method,
      headers: { accept: 'application/vnd.github+json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let response = await request();
    // Only immutable reads: never replay a write or retry an integrity failure.
    for (let attempt = 0; attempt < 2 && method === 'GET' &&
        /^\/git\/(commits|trees|blobs)\//.test(path) &&
        [429, 502, 503, 504].includes(response.status); attempt++) {
      status = response.status;
      let delay = 250 * (attempt + 1);
      if (status === 429) {
        const header = response.headers?.get?.('retry-after');
        const seconds = header && /^\d+$/.test(header) ? Number(header) : null;
        const date = header && seconds === null ? Date.parse(header) : NaN;
        delay = seconds !== null ? seconds * 1000 : Number.isFinite(date)
          ? Math.max(0, date - Date.now()) : 60000;
        // Never retry earlier than requested; long cooldowns remain unavailable.
        if (!Number.isFinite(delay) || delay > 60000) break;
      }
      await response.text();
      await new Promise(resolve => setTimeout(resolve, delay));
      retries++;
      response = await request();
    }
    status = response.status;
    if (status === 429) {
      await response.text();
      throw Object.assign(new Error('Git transport rate limited'), { code: 'GIT_RATE_LIMITED' });
    }
    const text = await response.text();
    let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: response.status, json };
    } finally {
      const durationMs = Math.round(performance.now() - started);
      if (durationMs >= 1000 || status === null || status >= 400) {
        console.info('[git-store] Transport timing', JSON.stringify({
          operation, status, durationMs, retries,
        }));
      }
    }
  }
  async ref(ref) {
    const { status, json } = await this.call(`/git/ref/${ref.replace(/^refs\//, '').split('/').map(enc).join('/')}`);
    if (status === 404) return null;
    if (status !== 200 || json?.ref !== ref || json?.object?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(json.object.sha)) throw new IntegrityError('Unreadable or symbolic Git ref');
    return json.object.sha;
  }
  async commit(sha) {
    const { status, json } = await this.call(`/git/commits/${sha}`);
    if (status !== 200 || json?.sha !== sha) throw new IntegrityError('Missing Git commit');
    return { tree: json.tree.sha, parents: json.parents.map(p => p.sha) };
  }
  async singleFile(treeSha, name) {
    const { status, json } = await this.call(`/git/trees/${treeSha}`);
    if (status !== 200 || json?.truncated || !Array.isArray(json?.tree) || json.tree.length !== 1) throw new IntegrityError('Unexpected tree content');
    const [entry] = json.tree;
    if (entry.path !== name || entry.mode !== '100644' || entry.type !== 'blob') throw new IntegrityError('Unexpected tree content');
    const blob = await this.call(`/git/blobs/${entry.sha}`);
    if (blob.status !== 200 || blob.json?.encoding !== 'base64') throw new IntegrityError('Missing Git blob');
    const bytes = Buffer.from(blob.json.content, 'base64');
    // Content addressing: the blob ID must equal Git's own hash of the bytes.
    const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (oid !== entry.sha) throw new IntegrityError('Git blob hash mismatch');
    return bytes.toString('utf8');
  }
  async writeCommit(name, content, parent, message) {
    const blob = await this.call('/git/blobs', 'POST', { content: Buffer.from(content).toString('base64'), encoding: 'base64' });
    if (blob.status !== 201) throw new Error('Git blob write failed');
    const tree = await this.call('/git/trees', 'POST', { tree: [{ path: name, mode: '100644', type: 'blob', sha: blob.json.sha }] });
    if (tree.status !== 201) throw new Error('Git tree write failed');
    const commit = await this.call('/git/commits', 'POST', { message, tree: tree.json.sha, parents: parent ? [parent] : [] });
    if (commit.status !== 201) throw new Error('Git commit write failed');
    return commit.json.sha;
  }
  /** Non-forced update: true when accepted, false when another writer moved the ref. */
  async compareAndSwap(ref, expected, commit) {
    const res = expected
      ? await this.call(`/git/refs/${ref.replace(/^refs\//, '').split('/').map(enc).join('/')}`, 'PATCH', { sha: commit, force: false })
      : await this.call('/git/refs', 'POST', { ref, sha: commit });
    if (res.status === 200 || res.status === 201) return true;
    if (res.status === 422 || res.status === 409) return false;
    throw new Error(`Git ref update failed (${res.status})`);
  }
}

/** Same signed-event format and verification as GitAppStateService, stored on GitHub. */
export class GitHubAppStateService extends GitAppStateService {
  #queue = Promise.resolve();
  #commits = new Map();
  #verified = null; // { tip, state }
  #tipCache = null; // { at, tip }
  constructor({ transport, retainCheckpoint, readCacheMs = 750, ...options }) {
    super({ ...options, directory: '/nonexistent' });
    this.transport = transport;
    this.retainCheckpoint = retainCheckpoint ?? (async () => {});
    this.readCacheMs = readCacheMs;
  }
  assertPrivateBare() { return Promise.resolve(); }
  #exclusive(fn) { const r = this.#queue.then(fn); this.#queue = r.then(() => undefined, () => undefined); return r; }
  async #tip(fresh) {
    if (!fresh && this.#tipCache && Date.now() - this.#tipCache.at < this.readCacheMs) return this.#tipCache.tip;
    const tip = await this.transport.ref(this.ref);
    this.#tipCache = { at: Date.now(), tip };
    return tip;
  }
  async #load(sha, metadata) {
    let entry = this.#commits.get(sha);
    if (entry) return entry;
    const { tree, parents } = metadata ?? await this.transport.commit(sha);
    const raw = await this.transport.singleFile(tree, 'event.json');
    entry = { parents, raw };
    this.#commits.set(sha, entry);
    return entry;
  }
  #empty() {
    return { checkpoint: null, records: Object.fromEntries(classes.map(k => [k, Object.create(null)])), events: [], versions: {}, receiptHead: this.trust.receiptPredecessor ?? null };
  }
  async #replay(fresh) {
    const tip = await this.#tip(fresh);
    if (this.#verified && this.#verified.tip === tip) return structuredClone(this.#verified.state);
    if (!tip) {
      if (this.checkpoint !== null) throw new IntegrityError('Missing trusted history');
      return this.#empty();
    }
    // Walk back to the last verified tip (fast path) or genesis.
    const chain = [];
    let cursor = tip;
    const known = this.#verified?.tip ?? null;
    // Parent discovery is sequential; independent tree/blob reads need not be.
    // At most three payload reads plus one metadata request are in flight.
    // This cache contains untrusted bytes: verification below remains ordered.
    const pending = new Set();
    let fetchError;
    try {
      while (cursor && cursor !== known) {
        if (pending.size >= 3) await Promise.race(pending);
        if (fetchError) throw fetchError;
        const cached = this.#commits.get(cursor);
        const c = cached ?? await this.transport.commit(cursor);
        chain.push(cursor);
        if (c.parents.length > 1) throw new IntegrityError('Nonlinear ancestry');
        if (!cached) {
          const task = this.#load(cursor, c)
            .catch(error => { fetchError ??= error; })
            .finally(() => pending.delete(task));
          pending.add(task);
        }
        cursor = c.parents[0] ?? null;
      }
    } finally {
      // Drain started reads even on failure before another queued replay starts.
      await Promise.all(pending);
    }
    if (fetchError) throw fetchError;
    if (known && cursor !== known) throw new IntegrityError('History rewritten behind verified head');
    chain.reverse();
    const base = known ? structuredClone(this.#verified.state) : this.#empty();
    const state = base;
    let previous = state.checkpoint?.commit ?? null;
    let previousHash = state.checkpoint?.eventHash ?? null;
    let pinned = this.checkpoint === null || Boolean(known);
    for (const commit of chain) {
      const { parents, raw } = await this.#load(commit);
      if (parents.length !== (previous ? 1 : 0) || (previous && parents[0] !== previous)) throw new IntegrityError('Nonlinear or missing ancestry');
      if (Buffer.byteLength(raw) > this.maxEventBytes) throw new IntegrityError('Event too large');
      const event = JSON.parse(raw);
      exact(event, ['body', 'signature']);
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
    await this.retainCheckpoint(structuredClone(state.checkpoint));
    this.#verified = { tip, state: structuredClone(state) };
    return state;
  }
  replay() { return this.#exclusive(() => this.#replay(false)); }
  append({ idempotencyKey, operations }) {
    operations = JSON.parse(canonical(operations));
    return this.#exclusive(async () => {
      identifier(idempotencyKey);
      if (!this.signer) throw new Error('Read-only service');
      const requestHash = hash(canonical({ actor: this.signer.actor, operations }));
      for (let attempt = 0; attempt < 8; attempt++) {
        const state = await this.#replay(true);
        const retry = state.events.find(e => e.body.idempotencyKey === idempotencyKey);
        if (retry) {
          if (retry.body.requestHash !== requestHash) throw new ConflictError('Idempotency key reused with different request');
          return { checkpoint: state.checkpoint, event: retry, duplicate: true };
        }
        const event = await this.prepareEvent(state, { idempotencyKey, operations });
        const parent = state.checkpoint?.commit ?? null;
        const raw = canonical(event);
        const commit = await this.transport.writeCommit('event.json', raw, parent, 'ForgeProof app state v1\n');
        if (!/^[a-f0-9]{40}$/.test(commit)) throw new IntegrityError('Invalid created Git commit');
        // Git objects are immutable. Keep the signed bytes we just uploaded,
        // rather than downloading commit, tree and blob again after publication.
        // This is not a verified-state cache: replay still validates the event
        // and observes a fresh remote ref after the non-forced update.
        this.#commits.set(commit, { parents: parent ? [parent] : [], raw });
        if (await this.transport.compareAndSwap(this.ref, parent, commit)) {
          const checkpoint = { commit, eventHash: hash(canonical(event)), sequence: event.body.sequence };
          this.#tipCache = null;
          const accepted = await this.#replay(true); // verify the accepted head before acknowledging
          if (!accepted.events.some(e => e.body.idempotencyKey === idempotencyKey && hash(canonical(e)) === checkpoint.eventHash))
            throw new IntegrityError('Published event absent from remote head');
          return { checkpoint, event, duplicate: false };
        }
        this.#tipCache = null;
      }
      throw new ConflictError('Remote contention retry limit; retry unchanged request');
    });
  }
}

/** Custodian envelopes (already AES-256-GCM sealed by EncryptedProviderCustodian)
 * on their own refs in the same private repository, updated by compare-and-swap. */
export class GitHubCredentialVault {
  #queue = Promise.resolve();
  #envelopes = new Map(); // commit sha -> envelope (immutable)
  #heads = new Map(); // ref -> { at, head }
  constructor({ transport, prefix, readCacheMs = 1000 }) { this.transport = transport; this.prefix = prefix; this.readCacheMs = readCacheMs; }
  async #head(ref, fresh) {
    const cached = this.#heads.get(ref);
    if (!fresh && cached && Date.now() - cached.at < this.readCacheMs) return cached.head;
    const head = await this.transport.ref(ref);
    this.#heads.set(ref, { at: Date.now(), head });
    return head;
  }
  async #envelope(head) {
    if (!head) return undefined;
    if (!this.#envelopes.has(head)) this.#envelopes.set(head, await this.transport.singleFile((await this.transport.commit(head)).tree, 'vault.json'));
    return this.#envelopes.get(head);
  }
  #ref(namespace) { return `refs/heads/${this.prefix}/${createHash('sha256').update(namespace).digest('hex').slice(0, 40)}`; }
  transact(namespace, change) {
    const run = async () => {
      const ref = this.#ref(namespace);
      for (let attempt = 0; attempt < 8; attempt++) {
        // Reads may use a ~1s cached head; any write re-reads under CAS.
        let head = await this.#head(ref, attempt > 0);
        let envelope = await this.#envelope(head);
        let { envelope: next, result } = change(envelope);
        if (next === envelope) return result;
        if (attempt === 0) {
          const fresh = await this.#head(ref, true);
          if (fresh !== head) { head = fresh; envelope = await this.#envelope(head); ({ envelope: next, result } = change(envelope)); if (next === envelope) return result; }
        }
        const commit = await this.transport.writeCommit('vault.json', next, head, 'ForgeProof credential vault v1\n');
        if (await this.transport.compareAndSwap(ref, head, commit)) { this.#envelopes.set(commit, next); this.#heads.set(ref, { at: Date.now(), head: commit }); return result; }
      }
      throw new ConflictError('Vault contention retry limit');
    };
    const r = this.#queue.then(run); this.#queue = r.then(() => undefined, () => undefined); return r;
  }
}
