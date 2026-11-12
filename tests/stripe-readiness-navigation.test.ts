import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Readiness is retired for every identity, not conditionally hidden by role.
// Server-side readiness authorization is covered by stripe-admin-routes.test.ts.
describe("retired Stripe readiness UI", () => {
  it("does not mount readiness navigation or probe its API on the dashboard", () => {
    const dashboard = readFileSync("client/src/pages/dashboard.tsx", "utf8");
    expect(dashboard).not.toMatch(/StripeReadiness|stripe readiness|\/admin\/stripe/i);
  });

  it("does not expose the readiness page even by direct navigation", () => {
    const app = readFileSync("client/src/App.tsx", "utf8");
    expect(app).not.toMatch(/AdminStripePage|admin-stripe|\/admin\/stripe/);
    expect(app).toContain("<Route component={NotFound} />");
  });
});
