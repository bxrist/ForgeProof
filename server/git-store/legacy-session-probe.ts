import session from 'express-session';
import { isDeepStrictEqual } from 'node:util';

export const SESSION_PROBE_STOP = 'Session continuity STOP: durable transition not implemented';
const READ_STOP = 'Session continuity STOP: trusted legacy read failed';

function normalizedJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || seen.has(value)) throw new Error();
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new Error();
  seen.add(value);
  for (const item of Object.values(value)) normalizedJson(item, seen);
  seen.delete(value);
}

/** Private, scope-bound custody contract. readActive must consult current authority
 * on every call, enforce revocation, and return detached normalized JSON plus the
 * exact SQL expiry. Never implement this using snapshots or session JSON claims.
 * No writer, SQL connection, logger, cookie secret or principal resolver is accepted.
 */
export interface LegacySessionReader {
  readActive(scope: Readonly<{ tenantId: string; repositoryId: string }>, sid: string):
    Promise<null | { session: session.SessionData; expiresAt: string }>;
}

const custody = new WeakMap<LegacySessionContinuityProbe, {
  reader: LegacySessionReader;
  scope: Readonly<{ tenantId: string; repositoryId: string }>;
  now: () => number;
}>();
function stop(callback?: (err?: any) => void): void {
  if (!callback) throw new Error(SESSION_PROBE_STOP);
  queueMicrotask(() => callback(new Error(SESSION_PROBE_STOP)));
}

/** SOURCE-ONLY COMPATIBILITY PROBE, not a production session store.
 * Only express-session may supply SIDs after its own cookie verification. All
 * mutations (including normal end-of-request touch) deliberately STOP. Installing
 * this in production would break renewal/logout and is expressly unsupported.
 */
export class LegacySessionContinuityProbe extends session.Store {
  constructor(scope: { tenantId: string; repositoryId: string }, reader: LegacySessionReader,
    now: () => number = Date.now) {
    super();
    if (!scope?.tenantId || !scope.repositoryId || typeof reader?.readActive !== 'function' ||
      typeof now !== 'function') throw new Error(READ_STOP);
    custody.set(this, { scope: Object.freeze({ tenantId: scope.tenantId, repositoryId: scope.repositoryId }), reader, now });
  }

  get(sid: string, callback: (err: any, value?: session.SessionData | null) => void): void {
    // Keep the consumer callback outside the catch; never call it twice if it throws.
    const read = async () => {
      try {
        if (typeof sid !== 'string' || !sid) throw new Error();
        const state = custody.get(this)!;
        const row = await state.reader.readActive(state.scope, sid);
        if (row === null) return null;
        const now = state.now();
        if (!Number.isFinite(now) || !row || typeof row.expiresAt !== 'string' ||
          !Number.isFinite(Date.parse(row.expiresAt))) throw new Error();
        const value = row.session;
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
          !value.cookie || typeof value.cookie !== 'object' || Array.isArray(value.cookie)) throw new Error();
        // Reject lossy/non-JSON custody values. No identity fields are examined.
        normalizedJson(value);
        const text = JSON.stringify(value);
        const detached = JSON.parse(text);
        if (!isDeepStrictEqual(detached, value)) throw new Error();
        const cookieExpiry = detached.cookie.expires;
        if (typeof cookieExpiry !== 'string' || !Number.isFinite(Date.parse(cookieExpiry))) throw new Error();
        if (Date.parse(row.expiresAt) <= now || Date.parse(cookieExpiry) <= now) return null;
        return detached as session.SessionData;
      } catch { throw new Error(READ_STOP); }
    };
    void read().then(value => callback(null, value), () => callback(new Error(READ_STOP)));
  }

  set(_sid: string, _value: session.SessionData, callback?: (err?: any) => void): void {
    stop(callback);
  }
  touch(_sid: string, _value: session.SessionData, callback?: (err?: any) => void): void {
    stop(callback);
  }
  destroy(_sid: string, callback?: (err?: any) => void): void { stop(callback); }
  clear(callback?: (err?: any) => void): void { stop(callback); }
}
