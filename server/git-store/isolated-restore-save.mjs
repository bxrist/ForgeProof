import { openSealedFullState } from './full-state-sealed.mjs';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const failure = () => new Error('Encrypted envelope save rejected');

// Caller supplies an existing directory; no path component may be attacker writable.
// Same-UID hostile processes are outside this boundary (use a dedicated owner account).
async function checkDirectory(directory) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) throw failure();
  const systemUid = (await fs.lstat(path.parse(directory).root)).uid;
  let current = directory;
  while (true) {
    const s = await fs.lstat(current);
    if (!s.isDirectory() || s.isSymbolicLink()) throw failure();
    if (current === directory) {
      if (s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700) throw failure();
    } else if ((s.uid !== systemUid && s.uid !== process.getuid()) ||
               ((s.mode & 0o022) && !(s.uid === systemUid && (s.mode & 0o1000)))) throw failure();
    try { await fs.lstat(path.join(current, '.git')); throw failure(); }
    catch (e) { if (e.code !== 'ENOENT') throw failure(); }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return fs.lstat(directory);
}

/** Save only the encrypted envelope; link publishes atomically without replacing a name.
 * A failure is not success: after power loss the operator must inspect/reconcile the target.
 */
export async function saveIsolatedEnvelope(directory, filename, envelope, { scope, encryptionKey, hmacKey, manifest } = {}) {
  let handle, dirHandle, temporary, target, published = false;
  try {
    if (!/^[A-Za-z0-9_-]+\.json$/.test(filename)) throw failure();
    envelope = structuredClone(envelope);
    // Reject arbitrary objects: this sink is exclusively for a sealed capture result.
    if (envelope?.productionGoAllowed !== false || envelope?.version !== 1 ||
        envelope?.tableRecords?.length !== 10 ||
        envelope.tableRecords.some(r => typeof r.ciphertextBase64 !== 'string')) throw failure();
    openSealedFullState(envelope, scope, encryptionKey, hmacKey, manifest);
    const before = await checkDirectory(directory);
    dirHandle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const pinned = await dirHandle.stat();
    if (before.ino !== pinned.ino || before.dev !== pinned.dev) throw failure();
    temporary = path.join(directory, `.sealed-${randomUUID()}`);
    target = path.join(directory, filename);
    handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    const bytes = Buffer.from(JSON.stringify(envelope));
    await handle.writeFile(bytes);
    await handle.sync();
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) throw failure();
    const readback = Buffer.alloc(bytes.length);
    const read = await handle.read(readback, 0, bytes.length, 0);
    if (read.bytesRead !== bytes.length || !readback.equals(bytes) || stat.size !== bytes.length) throw failure();
    const after = await checkDirectory(directory);
    if (after.ino !== pinned.ino || after.dev !== pinned.dev) throw failure();
    await fs.link(temporary, target);
    published = true;
    await fs.unlink(temporary);
    temporary = undefined;
    await dirHandle.sync();
    return { saved: true, productionGoAllowed: false };
  } catch {
    if (published) await fs.unlink(target).catch(() => {});
    throw failure();
  } finally {
    await handle?.close().catch(() => {});
    if (temporary) await fs.unlink(temporary).catch(() => {});
    await dirHandle?.close().catch(() => {});
  }
}
