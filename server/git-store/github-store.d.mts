import { GitAppStateService, type Checkpoint, type Signer, type Trust } from './store.mjs';
export type GitHubRequest = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;
export declare class GitHubTransport {
  constructor(options: { owner: string; repo: string; request: GitHubRequest });
  ref(ref: string): Promise<string | null>;
}
export declare class GitHubAppStateService extends GitAppStateService {
  constructor(options: { transport: GitHubTransport; tenant: string; repository: string; trust: Trust; checkpoint: Checkpoint | null; signer?: Signer; retainCheckpoint?: (c: Checkpoint) => Promise<void>; readCacheMs?: number });
}
export declare class GitHubCredentialVault {
  constructor(options: { transport: GitHubTransport; prefix: string });
  transact<T>(namespace: string, change: (envelope: string | undefined) => { envelope: string; result: T }): Promise<T>;
}
