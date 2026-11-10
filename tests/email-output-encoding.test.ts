import { beforeEach, describe, expect, it, vi } from "vitest";
import { escapeMarkup } from "../server/outputEncoding";

const storage = vi.hoisted(() => ({ createPendingEmail: vi.fn() }));
vi.mock("../server/storage", () => ({ storage }));

import { sendGitCommitFailureEmail } from "../server/email";

beforeEach(() => vi.clearAllMocks());

describe("Git commit failure email encoding", () => {
  it("encodes every receipt/error field in HTML without altering plain text", async () => {
    const attack = `<img src=x onerror="alert('xss')">&`;
    await sendGitCommitFailureEmail({
      to: "owner@example.test",
      receiptId: `receipt-${attack}`,
      entryHash: `hash-${attack}`,
      errorMessage: `GitHub Contents API error 500: ${attack}`,
      baseUrl: "https://example.test",
    });
    const email = storage.createPendingEmail.mock.calls[0][0];
    for (const prefix of ["receipt-", "hash-", "GitHub Contents API error 500: "]) {
      expect(email.bodyHtml).toContain(escapeMarkup(`${prefix}${attack}`));
      expect(email.bodyText).toContain(`${prefix}${attack}`);
    }
    expect(email.bodyHtml).not.toContain("<img");
    expect(email.bodyHtml).toContain('href="https://example.test/dashboard#github"');
  });

  it("keeps numeric receipt IDs readable", async () => {
    await sendGitCommitFailureEmail({
      to: "owner@example.test", receiptId: 42, entryHash: "sha256:abc",
      errorMessage: "Token expired", baseUrl: "https://example.test",
    });
    const email = storage.createPendingEmail.mock.calls[0][0];
    expect(email.bodyHtml).toContain(">42</td>");
    expect(email.bodyHtml).toContain(">Token expired</td>");
  });
});
