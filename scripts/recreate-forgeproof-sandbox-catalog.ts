import { getUncachableStripeClient } from "../server/stripeClient";
import { ensureForgeProofSandboxCatalog } from "../server/stripeSandboxCatalog";

async function main() {
  // The old application pin deliberately differs during this owner-approved
  // transition. The provisioner enforces the exact destination and test mode.
  const stripe = await getUncachableStripeClient({ skipAccountGuard: true });
  console.log(JSON.stringify(await ensureForgeProofSandboxCatalog(stripe)));
}

main().catch(() => {
  console.error("Sandbox catalog setup stopped. Account, mode, or catalog checks failed; provider details withheld.");
  process.exitCode = 1;
});
