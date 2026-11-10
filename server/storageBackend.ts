import { AsyncLocalStorage } from "node:async_hooks";
import type { IStorage } from "./storage";
import { validateLegacyStorage } from "./storageContract";

const principals = new AsyncLocalStorage<{subject?: string}>();
let resolver: ((principal: string | undefined) => IStorage) | undefined;
let backendKind: "git" | "postgres" | undefined;

/** Only trusted server initialization may install the application backend. */
export function installApplicationStorage(resolve: (principal: string | undefined) => IStorage, kind: "git" | "postgres" = "git"): void {
  if (resolver) throw new Error("Application storage is already installed");
  validateLegacyStorage(resolve(undefined));
  resolver = resolve;
  backendKind = kind;
}

/** Called only after the existing authentication layer verifies the subject. */
export function withStoragePrincipal<T>(subject: string, action: () => T): T {
  if (!subject) throw new Error("Authenticated storage subject required");
  return principals.run({subject}, action);
}
export const hasApplicationStorage = () => backendKind === "git";
export function currentApplicationStorage(): IStorage | undefined {
  return hasApplicationStorage() ? resolver?.(principals.getStore()?.subject) : undefined;
}
export function requestStorageScope<T>(action: () => T): T {
  return principals.run({}, action);
}
export function setVerifiedStoragePrincipal(subject: string): void {
  const context = principals.getStore();
  if (!context) return; // Non-HTTP administrative callers retain their explicit scope.
  if (context.subject && context.subject !== subject) throw new Error("Conflicting authenticated storage subjects");
  context.subject = subject;
}

export function applicationStorageFacade(): IStorage {
  return new Proxy({} as IStorage, {
    get(_target, name) {
      if (!resolver) throw new Error("Application storage has not been initialized");
      const backend = resolver(principals.getStore()?.subject);
      const value = Reflect.get(backend, name);
      return typeof value === "function" ? value.bind(backend) : value;
    },
  });
}
