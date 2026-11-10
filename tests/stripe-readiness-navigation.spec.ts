import { test, expect, type Page } from "@playwright/test";

// Mount the actual navigation component in the browser without creating Clerk
// customers or calling Stripe. This tests UI response handling, not server auth.
async function mount(page: Page, identity: string | null) {
  await page.goto("/demo");
  await page.evaluate(async (identity) => {
    // Vite serves these existing modules in the development test server.
    const load = (path: string) => import(/* @vite-ignore */ path);
    const source = await (await fetch("/src/components/StripeReadinessLink.tsx")).text();
    const main = await (await fetch("/src/main.tsx")).text();
    const reactUrl = source.match(/from "([^"]+\/react\.js[^"]*)"/)?.[1];
    const domUrl = main.match(/from "([^"]+\/react-dom_client\.js[^"]*)"/)?.[1];
    if (!reactUrl || !domUrl) throw new Error("Vite dependency URLs unavailable");
    const React = (await load(reactUrl)).default;
    const { createRoot } = (await load(domUrl)).default;
    const { StripeReadinessLink } = await load("/src/components/StripeReadinessLink.tsx");
    const host = document.createElement("div");
    host.id = "navigation-test-host";
    document.body.append(host);
    const root = createRoot(host);
    (window as any).renderReadiness = (id: string | null) =>
      root.render(React.createElement(StripeReadinessLink, { identity: id }));
    (window as any).renderReadiness(identity);
  }, identity);
}
const endpoint = "**/api/admin/stripe/readiness";

test("hidden during loading; authorized admin sees navigation even when not ready", async ({ page }) => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  await page.route(endpoint, async route => {
    await wait;
    await route.fulfill({json:{ready:false}});
  });
  const request = page.waitForRequest(endpoint);
  await mount(page, "admin:session-one");
  await request;
  await expect(page.getByTestId("link-stripe-readiness")).toHaveCount(0);
  release();
  await expect(page.getByTestId("link-stripe-readiness")).toBeVisible();
  await expect(page.locator("#navigation-test-host a")).toHaveAttribute("href", "/admin/stripe");
});

for (const status of [401,403,503]) {
  test(`hidden on ${status}`, async ({ page }) => {
    await page.route(endpoint, route => route.fulfill({status,json:{message:"Unavailable"}}));
    const response = page.waitForResponse(endpoint);
    await mount(page, "customer:session-two");
    await response;
    await expect(page.getByTestId("link-stripe-readiness")).toHaveCount(0);
  });
}

test("switching away from an authorized admin removes navigation and refetches", async ({ page }) => {
  let status=200, calls=0;
  await page.route(endpoint, route => { calls++; return route.fulfill({status,json:status===200?{ready:true}:{message:"Forbidden"}}); });
  await mount(page, "admin:session-one");
  await expect(page.getByTestId("link-stripe-readiness")).toBeVisible();
  status=403;
  const response=page.waitForResponse(endpoint);
  await page.evaluate(()=> (window as any).renderReadiness("customer:session-two"));
  await response;
  await expect(page.getByTestId("link-stripe-readiness")).toHaveCount(0);
  expect(calls).toBe(2);
  await page.evaluate(()=> (window as any).renderReadiness(null));
  await expect(page.getByTestId("link-stripe-readiness")).toHaveCount(0);
  expect(calls).toBe(2);
});

test("late admin response cannot authorize the newly selected customer", async ({ page }) => {
  let release!:()=>void;
  const wait=new Promise<void>(resolve=>{release=resolve;});
  let calls=0;
  await page.route(endpoint, async route=>{
    if(++calls===1) {await wait; await route.fulfill({json:{ready:true}}).catch(()=>{});}
    else await route.fulfill({status:403,json:{message:"Forbidden"}});
  });
  const first=page.waitForRequest(endpoint);
  await mount(page,"admin:session-one"); await first;
  const second=page.waitForResponse(endpoint);
  await page.evaluate(()=> (window as any).renderReadiness("customer:session-two"));
  await second; release();
  await expect(page.getByTestId("link-stripe-readiness")).toHaveCount(0);
});
