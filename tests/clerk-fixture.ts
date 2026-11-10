import { test as base, expect, type Page } from "@playwright/test";
import { clerkClient } from "@clerk/express";
import type { User } from "@clerk/backend";

// These preference tests mock application data, but exercise the real Clerk
// session. The legacy external ID deliberately matches the data fixtures.
export const test = base.extend<{}, { clerkFixtureUser: User }>({
  clerkFixtureUser: [async ({}, use) => {
    const client = clerkClient;
    const user = await client.users.createUser({
      externalId: "test-user-1",
      firstName: "Test",
      lastName: "User",
      emailAddress: [`forgeproof-test-${crypto.randomUUID()}@example.com`],
      skipPasswordRequirement: true,
    });
    try {
      await use(user);
    } finally {
      await client.users.deleteUser(user.id);
    }
  }, { scope: "worker", auto: true }],
});

export { expect };

export async function signInTestUser(page: Page) {
  const client = clerkClient;
  const { data } = await client.users.getUserList({ externalId: ["test-user-1"] });
  if (data.length !== 1) throw new Error("Clerk preference-test fixture account is unavailable");
  const ticket = await client.signInTokens.createSignInToken({ userId: data[0].id, expiresInSeconds: 60 });
  await page.goto(`/sign-in?__clerk_ticket=${encodeURIComponent(ticket.token)}`);
  await page.waitForURL("**/dashboard", { timeout: 30_000 });
}
