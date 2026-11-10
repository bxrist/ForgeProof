import { Card } from "@/components/ui/card";

export function HistoricalInventory() {
  return (
    <Card className="p-5 mb-6 bg-muted/30" data-testid="historical-inventory">
      <details>
        <summary className="cursor-pointer text-sm font-semibold">Historical inventory snapshot · 2026-11-10 — not live validation</summary>
        <div className="mt-3 text-xs text-muted-foreground space-y-2">
          <p>Historical global inventory snapshot dated 2026-11-10; exact time not recorded: 23 receipts, 9 repositories, 2 key records. These are archived aggregate counts, not your account totals or evidence of current validity.</p>
          <p>The account key list only shows keys owned by the signed-in account. At this snapshot, the owner had one key; the two global key records included another service principal's key. No credentials or other principals' key details are exposed.</p>
          <p>Original protected archive: 64 rows, including 17 receipts and 12 archived sessions. Archived sessions are historical inventory, not active Clerk sessions or evidence of current authentication.</p>
          <p>The account cards above use current account-scoped API responses only. Historical snapshots must not be added to those counts.</p>
        </div>
      </details>
    </Card>
  );
}
