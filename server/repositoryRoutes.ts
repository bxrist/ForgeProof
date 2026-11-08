import type { Express, RequestHandler } from "express";
import type { IStorage } from "./storage";

/** Shared legacy handlers: callers supply storage and their authentication boundary. */
export function registerRepositoryList(app: Express, storage: IStorage, uiLimiter: RequestHandler, isAuthenticated: RequestHandler) {
  app.get("/api/repositories", uiLimiter, isAuthenticated, async (req, res) => {
    const user = req.user as any;
    const userId = user.claims?.sub || user.id;
    const repos = await storage.getRepositories(userId);
    res.json(repos);
  });
}

export function registerRepositoryDelete(app: Express, storage: IStorage, uiLimiter: RequestHandler, isAuthenticated: RequestHandler) {
  app.delete("/api/repositories/:id", uiLimiter, isAuthenticated, async (req, res) => {
    const id = parseInt(req.params.id as string);
    if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
    const user = req.user as any;
    const userId = user.claims?.sub || user.id;
    const repo = await storage.getRepository(id);
    if (!repo) return res.status(404).json({ message: "Not found" });
    if (repo.userId !== userId) return res.status(403).json({ message: "Forbidden" });
    await storage.deleteRepository(id);
    await storage.createAuditLog({ userId, action: "repository.deleted", resourceType: "repository", resourceId: String(req.params.id) });
    res.json({ message: "Repository removed" });
  });
}
