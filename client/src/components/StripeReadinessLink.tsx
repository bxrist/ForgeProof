import { useEffect, useState } from "react";
import { Link } from "wouter";
import { CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Navigation hint only; the readiness API remains the authorization boundary. */
export function StripeReadinessLink({ identity }: { identity: string | null }) {
  const [authorizedFor, setAuthorizedFor] = useState<string | null>(null);
  useEffect(() => {
    setAuthorizedFor(null);
    if (!identity) return;
    const controller = new AbortController();
    let current = true;
    void (async () => {
      try {
        const response = await fetch("/api/admin/stripe/readiness", {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) return;
        const report = await response.json();
        // Both ready:true and ready:false confirm access. Reject HTML redirects
        // and malformed responses without displaying provider details.
        if (current && typeof report?.ready === "boolean") setAuthorizedFor(identity);
      } catch {
        // Pending, unauthorized and unavailable all keep this optional link hidden.
      }
    })();
    return () => { current = false; controller.abort(); };
  }, [identity]);

  if (!identity || authorizedFor !== identity) return null;
  return (
    <Link href="/admin/stripe">
      <Button variant="ghost" size="sm" data-testid="link-stripe-readiness">
        <CreditCard className="w-3.5 h-3.5 mr-1.5" />
        Stripe readiness
      </Button>
    </Link>
  );
}
