import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import rateLimit from "express-rate-limit";

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath));

  // High shared-ingress quota; only SPA fallbacks consume it, never static assets.
  const spaFallbackLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 12_000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many page requests, please try again later." },
  });

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", spaFallbackLimiter, (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
