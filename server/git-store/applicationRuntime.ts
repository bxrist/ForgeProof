import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GitAppStateService } from "./store.mjs";
import { RemoteGitAppStateService } from "./remote.mjs";
import { GitStorage } from "./storage";
import { installApplicationStorage } from "../storageBackend";

/**
 * Bootstrap the existing commercial application, not the isolated test server.
 * Configuration contains public trust and module locations, never generated
 * identities or a fallback signing key. Custody modules keep key material external.
 */
export async function initializeApplicationStorage(): Promise<void> {
  const mode = process.env.FORGEPROOF_STORAGE ??
    (process.env.NODE_ENV === "development" && !process.env.FORGEPROOF_GIT_CONFIG ? "postgres" : "git");
  if (mode === "postgres") {
    if (!process.env.DATABASE_URL) throw new Error("Select Git storage and its existing configuration, or supply the legacy database connection");
    const { DatabaseStorage } = await import("../legacySqlStorage");
    const legacy = new DatabaseStorage();
    installApplicationStorage(() => legacy, "postgres");
    return;
  }
  if (mode !== "git") throw new Error("Unknown application storage backend");
  if (process.env.FORGEPROOF_GIT_GITHUB_REPOSITORY) {
    // Private GitHub repository through the authorized GitHub connection.
    const { createGitHubStore } = await import("./githubRuntime");
    const { settings, service, custody, material } = createGitHubStore();
    const state = await service.replay();
    if (!state.records.users[settings.guardUserId]) throw new Error("Existing owner account is absent from the Git store");
    const members = Object.keys(state.records.users);
    installApplicationStorage(subject => {
      if (subject && !members.includes(subject)) members.push(subject);
      return new GitStorage(service, subject ?? settings.guardUserId, members, settings.guardUserId,
        custody, `${settings.tenant}:${settings.stream}`,
        material.mailEncryptionKey, material.auditEncryptionKey, material.receiptEncryptionKey, true);
    });
    return;
  }
  const path = process.env.FORGEPROOF_GIT_CONFIG;
  if (!path) throw new Error("FORGEPROOF_GIT_CONFIG must identify the existing Git store configuration");
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077)) throw new Error("Git configuration must be owner-private");
  const config = JSON.parse(await readFile(path, "utf8"));
  if (!config.signerModule || !config.guardUserId) throw new Error("Git signer and existing bootstrap subject must be configured");
  const resources = await import(pathToFileURL(resolve(config.signerModule)).href);
  const service = resources.service ?? (config.remote
    ? new RemoteGitAppStateService({...config, signer:resources.signer,retainCheckpoint:resources.retainCheckpoint})
    : new GitAppStateService({...config, signer: resources.signer}));
  const state = await service.replay();
  if (!state.records.users[config.guardUserId]) throw new Error("Existing bootstrap account is absent; historical identities will not be fabricated");
  const members = Object.keys(state.records.users);
  installApplicationStorage(subject => {
    // Nonempty subjects are supplied only by the verified authentication boundary.
    if (subject && !members.includes(subject)) members.push(subject);
    return new GitStorage(service, subject ?? config.guardUserId, members, config.guardUserId,
      resources.custody, config.custodyScope ?? `${config.tenant}:${config.repository}`,
      resources.mailEncryptionKey, resources.auditEncryptionKey, resources.receiptEncryptionKey, true);
  });
}
