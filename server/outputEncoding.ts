/**
 * Encode plain text for HTML/XML text nodes and quoted attributes.
 * Do not use this for JavaScript, CSS, or URL contexts.
 */
export function escapeMarkup(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

// These documents need inline styles for badges and printable certificates,
// but never scripts, network access, forms, or an attacker-controlled base URL.
export const DOCUMENT_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
