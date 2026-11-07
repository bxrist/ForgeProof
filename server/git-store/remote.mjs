import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hash } from './schema.mjs';
import { GitAppStateService, IntegrityError, ConflictError } from './store.mjs';

// One exclusive filesystem clone per worker. Never construct from HTTP input.
export class RemoteGitAppStateService {
  constructor({ remote, privateStore, retainCheckpoint, transport = {}, ...options }) {
    if (!options.checkpoint || typeof retainCheckpoint !== 'function') throw new Error('Independent checkpoint and durable retention callback required');
    if (!privateStore || privateStore.tenant !== options.tenant || privateStore.repository !== options.repository || privateStore.url !== remote) throw new Error('Explicit private store scope required');
    const local = transport.localTestOnly === true;
    if (local ? !/^\/(?!.*[\n\r\0]).+/.test(remote) : !/^ssh:\/\/[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\/[a-zA-Z0-9/_.-]+$/.test(remote)) throw new Error('Only scoped SSH transport (or local test fixture) permitted');
    if (!local && (!transport.knownHosts || !transport.identityFile || ![transport.knownHosts, transport.identityFile].every(p => /^\/[a-zA-Z0-9/_.-]+$/.test(p)))) throw new Error('Pinned SSH known-hosts and dedicated identity paths required');
    this.options = { ...options, trust: structuredClone(options.trust), checkpoint: structuredClone(options.checkpoint) };
    this.remote = remote; this.transport = structuredClone(transport);
    this.ref = `refs/heads/forgeproof/${options.tenant}/${options.repository}`;
    this.checkpoint = structuredClone(options.checkpoint); this.retainCheckpoint = retainCheckpoint;
    this.local = new GitAppStateService(this.options); this.queue = Promise.resolve();
  }
  exclusive(fn) {
    const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result;
  }
  async transportGit(args, expectedHead) {
    let hookDirectory;
    if (args[0] === 'push') {
      if (!/^[a-f0-9]{40}$/.test(expectedHead)) throw new Error('Expected remote head required');
      hookDirectory = await mkdtemp(join(tmpdir(), 'forgeproof-push-'));
      // Git supplies its OWN advertised old OID to pre-push. Check it before a
      // normal (non-force) push; receive-pack then locks/CASes that exact OID.
      // Fixed shell code, quoted data comparisons only; no interpolation/eval.
      await writeFile(join(hookDirectory, 'pre-push'), `#!/bin/sh
count=0
while read -r local_ref local_oid remote_ref remote_oid; do
  [ "$remote_ref" = "$FORGEPROOF_EXPECTED_REF" ] || exit 1
  [ "$remote_oid" = "$FORGEPROOF_EXPECTED_HEAD" ] || exit 1
  count=$((count + 1))
done
[ "$count" = 1 ]
`, { mode: 0o700, flag: 'wx' });
    }
    const ssh = this.transport.localTestOnly ? undefined : `ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${this.transport.knownHosts} -i ${this.transport.identityFile}`;
    try { return await new Promise((resolve, reject) => {
      execFile('git', ['--no-replace-objects', '-c', 'core.hooksPath=' + (hookDirectory ?? '/dev/null'), '-c', 'protocol.allow=never', '-c', `protocol.${this.transport.localTestOnly ? 'file' : 'ssh'}.allow=always`, '--git-dir=' + this.options.directory, ...args], {
        env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', ...(ssh ? { GIT_SSH_COMMAND: ssh } : {}), FORGEPROOF_EXPECTED_REF: this.ref, FORGEPROOF_EXPECTED_HEAD: expectedHead ?? '' },
        timeout: 30000, maxBuffer: 1024 * 1024,
      }, (error, stdout) => error ? reject(new Error('Private Git transport failed; outcome may be ambiguous')) : resolve(stdout.trim()));
    }); } finally { if (hookDirectory) await rm(hookDirectory, { recursive: true, force: true }); }
  }
  async advertised() {
    const output = await this.transportGit(['ls-remote', '--symref', this.remote, this.ref]);
    const lines = output.split('\n');
    if (lines.length !== 1 || !new RegExp(`^[a-f0-9]{40}\\t${this.ref}$`).test(lines[0])) throw new IntegrityError('Missing, symbolic or invalid remote stream');
    return lines[0].slice(0, 40);
  }
  async refresh() {
    await this.local.ready;
    // Local repository configuration is not a transport authority. Reject URL
    // rewriting, helpers, alternate executables and includes before any network I/O.
    const config = await this.local.git(['config', '--local', '--name-only', '--list']);
    const allowed = new Set(['core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates', 'receive.denynonfastforwards', 'receive.denydeletes']);
    if (config.split('\n').some(key => key && !allowed.has(key))) throw new IntegrityError('Untrusted local Git transport configuration');
    await this.advertised();
    const temporary = `refs/forgeproof-fetch/${randomUUID()}`;
    try {
      await this.transportGit(['fetch', '--no-tags', '--no-write-fetch-head', this.remote, `${this.ref}:${temporary}`]);
      const oid = await this.local.git(['rev-parse', '--verify', temporary]);
      const verifier = new GitAppStateService({ ...this.options, checkpoint: this.checkpoint, signer: undefined });
      verifier.head = async () => oid;
      const state = await verifier.replay();
      // Retention is independently protected, monotonic and durable BEFORE acknowledgment.
      await this.retainCheckpoint(structuredClone(state.checkpoint));
      this.checkpoint = structuredClone(state.checkpoint);
      return state;
    } finally { await this.local.git(['update-ref', '-d', temporary]); }
  }
  replay() { return this.exclusive(() => this.refresh()); }
  async get(kind, id) { return (await this.replay()).records[kind]?.[id]; }
  async list(kind) { return Object.values((await this.replay()).records[kind] ?? {}); }
  append(transaction) {
    const request = JSON.parse(canonical(transaction));
    return this.exclusive(async () => {
      if (!this.options.signer) throw new Error('Read-only service');
      const requestHash = hash(canonical({ actor: this.options.signer.actor, operations: request.operations }));
      for (let attempt = 0; attempt < 8; attempt++) {
        const state = await this.refresh(); // Always resolve ambiguous previous publication first.
        const existing = state.events.find(e => e.body.idempotencyKey === request.idempotencyKey);
        if (existing) {
          if (existing.body.requestHash !== requestHash) throw new ConflictError('Idempotency key reused with different request');
          return { checkpoint: state.checkpoint, event: existing, duplicate: true };
        }
        let candidate;
        // An interrupted attempt's local signed candidate is reusable after restart.
        const pending = new GitAppStateService({ ...this.options, checkpoint: state.checkpoint });
        try {
          const saved = await pending.replay();
          const event = saved.events.at(-1);
          if (saved.checkpoint.sequence === state.checkpoint.sequence + 1 && event.body.idempotencyKey === request.idempotencyKey && event.body.requestHash === requestHash) candidate = { checkpoint: saved.checkpoint, event };
        } catch { /* Unpublished stale candidate is disposable; remote verification already passed. */ }
        if (!candidate) {
          await this.local.git(['update-ref', '--no-deref', this.ref, state.checkpoint.commit]);
          const writer = new GitAppStateService({ ...this.options, checkpoint: state.checkpoint });
          candidate = await writer.append(request);
        }
        // An ancestor check and pre-push expected-head check fence rewinds/deletion
        // as well as competing writes, without enabling force push.
        await this.local.git(['merge-base', '--is-ancestor', state.checkpoint.commit, candidate.checkpoint.commit]);
        try {
          await this.transportGit(['push', '--porcelain', this.remote, `${candidate.checkpoint.commit}:${this.ref}`], state.checkpoint.commit);
        } catch { /* Rejection AND timeout require verified remote readback before any retry. */ }
        const readback = await this.refresh(); // Failure propagates; never acknowledge local-only state.
        const accepted = readback.events.find(e => e.body.idempotencyKey === request.idempotencyKey);
        if (accepted) {
          if (accepted.body.requestHash !== requestHash) throw new ConflictError('Idempotency key reused with different request');
          return { checkpoint: readback.checkpoint, event: accepted, duplicate: false };
        }
      }
      throw new ConflictError('Remote contention retry limit; retry unchanged request');
    });
  }
}
