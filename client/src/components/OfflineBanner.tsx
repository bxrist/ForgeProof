import { useState, useEffect, useRef } from "react";
import { WifiOff, X } from "lucide-react";

export function OfflineBanner({ onReconnect }: { onReconnect?: () => void }) {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [dismissed, setDismissed] = useState(false);
  const dismissedRef = useRef(false);
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;

  useEffect(() => {
    function handleOffline() {
      setIsOffline(true);
      // A new offline event starts a new offline period — the banner may re-appear.
      dismissedRef.current = false;
      setDismissed(false);
    }
    function handleOnline() {
      setIsOffline(false);
      onReconnectRef.current?.();
    }
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  if (!isOffline || dismissed || dismissedRef.current) return null;

  return (
    <div
      role="alert"
      data-testid="banner-offline"
      className="relative z-[60] flex items-center justify-between gap-3 px-4 py-2.5 bg-amber-500 dark:bg-amber-600 text-white text-sm font-medium"
    >
      <div className="flex items-center gap-2">
        <WifiOff className="w-4 h-4 shrink-0" />
        <span>You're offline — live data is unavailable. We'll reload automatically when your connection returns.</span>
      </div>
      <button
        onClick={() => {
          dismissedRef.current = true;
          setDismissed(true);
        }}
        aria-label="Dismiss offline banner"
        data-testid="button-dismiss-offline-banner"
        className="shrink-0 rounded p-0.5 hover:bg-white/20 transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
