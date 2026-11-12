import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import { CLERK_PROXY_PATH, clerkProxyMiddleware, getClerkProxyHost } from "./middlewares/clerkProxyMiddleware";
import { startReceiptOutboxWorker } from "./receiptOutbox";
import { requestLogLine } from "./requestLog";
import { hasApplicationStorage, requestStorageScope } from "./storageBackend";
import { initializeApplicationStorage } from "./git-store/applicationRuntime";
import { withStripeRequestClient } from "./stripeClient";

const app = express();
app.set("trust proxy", 1);
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  (_req, _res, next) => withStripeRequestClient(next),
  async (req, res) => {
    const started = performance.now();
    let verificationMs = 0;
    let handlingMs = 0;
    let stage = "signature_and_ownership";
    res.once("finish", () => {
      console.info("[stripe] Webhook timing", JSON.stringify({
        status: res.statusCode, stage,
        totalMs: Math.round(performance.now() - started),
        verificationMs: Math.round(verificationMs),
        handlingMs: Math.round(handlingMs),
      }));
    });
    const signature = req.headers["stripe-signature"];
    if (!signature) {
      return res.status(400).json({ error: "Missing stripe-signature" });
    }
    try {
      const sig = Array.isArray(signature) ? signature[0] : signature;
      const { WebhookHandlers } = await import("./webhookHandlers");
      let owned: boolean;
      try {
        owned = await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      } finally {
        verificationMs = performance.now() - started;
      }
      if (!owned) return res.status(200).json({ received: true, ignored: true });

      stage = "application_handling";
      const handlingStarted = performance.now();
      try {
        const event = JSON.parse((req.body as Buffer).toString("utf8"));
        const { handleStripeEvent } = await import("./stripe");
        await handleStripeEvent(event);
      } catch (e) {
        console.error("Stripe event handling error:", e);
        return res.status(500).json({ error: "Event processing failed" });
      } finally {
        handlingMs = performance.now() - handlingStarted;
      }

      stage = "complete";
      res.status(200).json({ received: true });
    } catch (error: any) {
      console.error("Webhook error:", error.message);
      res.status(400).json({ error: "Webhook processing error" });
    }
  },
);

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      log(requestLogLine(req, res.statusCode, duration));
    }
  });

  next();
});

(async () => {
  await initializeApplicationStorage();
  app.use((_req, _res, next) => requestStorageScope(next));
  await registerRoutes(httpServer, app);

  if (!hasApplicationStorage()) try {
    const { seedDatabase } = await import("./seed");
    await seedDatabase();
  } catch (e) {
    console.error("Seed error:", e);
  }

  (async () => {
    if (hasApplicationStorage()) return;
    try {
      const { runCommitHealthCheck } = await import("./commitHealthCheck");
      await runCommitHealthCheck();
      // Re-run every 24 hours so broken URLs surface in logs without a restart
      const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
      setInterval(runCommitHealthCheck, TWENTY_FOUR_HOURS);
    } catch (e) {
      console.error("Commit health check error:", e);
    }
  })();

  (async () => {
    try {
      const { flushEmailQueue } = await import("./email");
      const ONE_MINUTE = 60 * 1000;
      setInterval(() => {
        flushEmailQueue().catch((e) => console.error("Email queue flush error:", e));
      }, ONE_MINUTE);
    } catch (e) {
      console.error("Email queue worker setup error:", e);
    }
  })();

  // Stripe sync schema migrations are local database setup only.  Provider
  // inspection, webhook changes, and catalog synchronization are deliberately
  // operator-triggered through the hardened admin reconciliation endpoint.
  (async () => {
    if (hasApplicationStorage()) return;
    try {
      const { runMigrations } = await import("stripe-replit-sync");
      const { pool } = await import("./db");
      await runMigrations({ databaseUrl: process.env.DATABASE_URL! });
      await pool.query(`
        CREATE TABLE IF NOT EXISTS stripe."_forgeproof_webhook_intents" (
          account_id text NOT NULL,
          environment text NOT NULL,
          url text NOT NULL,
          idempotency_key text NOT NULL,
          request_params jsonb NOT NULL,
          status text NOT NULL DEFAULT 'pending',
          stripe_endpoint_id text,
          secret_stored boolean NOT NULL DEFAULT false,
          created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
          updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
          PRIMARY KEY (account_id, environment),
          UNIQUE (account_id, url)
        )
      `);
      log("Stripe sync schema initialized", "stripe");
    } catch (e) {
      console.error("Stripe schema migration error (billing features unavailable):", e);
    }
  })();

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: process.env.FORGEPROOF_ISOLATED_STAGING === "true" ? "127.0.0.1" : "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
      if (!hasApplicationStorage()) startReceiptOutboxWorker();
    },
  );
})();
