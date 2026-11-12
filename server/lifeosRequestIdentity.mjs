// Strict canonical UTC milliseconds avoid timestamp normalization ambiguity.
export function requireLifeosRequestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,128}$/.test(value))
    throw Object.assign(new Error('Invalid LifeOS request identity'), {status:400});
  return value;
}
export function parseLifeosRequestIdentity(key, signedAt) {
  if (key === undefined && signedAt === undefined) return undefined;
  const requestId = requireLifeosRequestId(key);
  if (typeof signedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(signedAt) ||
      !Number.isFinite(Date.parse(signedAt)) || new Date(signedAt).toISOString() !== signedAt)
    throw Object.assign(new Error('Invalid LifeOS signedAt'), {status:400});
  return {requestId, signedAt};
}
