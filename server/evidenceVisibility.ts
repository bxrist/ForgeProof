// Presentation redaction, not a mutation of the protected original.
export function redactEvidence(value: any): any {
  if (Array.isArray(value)) return value.map(redactEvidence);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, /secret|token|password|credential|private.?key|api.?key|authorization|cookie/i.test(k) ? "[redacted]" : redactEvidence(v)]));
  return value;
}
