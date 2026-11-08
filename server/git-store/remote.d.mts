import type { Options, Checkpoint, Replay, Transaction, Event, AppRecord, RecordClass } from './store.mjs';
export interface RemoteOptions extends Omit<Options, 'checkpoint'> {
  checkpoint: Checkpoint;
  remote: string;
  privateStore: { url: string; tenant: string; repository: string };
  /** Independently protected monotonic durable retention. Reject regressions/divergence.
   * Must resolve only after the pin survives worker loss. Never store solely in this clone. */
  retainCheckpoint(checkpoint: Checkpoint): Promise<void>;
  transport: { knownHosts: string; identityFile: string; localTestOnly?: false } | { localTestOnly: true };
}
export class RemoteGitAppStateService {
  constructor(options: RemoteOptions);
  replay(): Promise<Replay>;
  get(kind: RecordClass, id: string | number): Promise<AppRecord | undefined>;
  list(kind: RecordClass): Promise<AppRecord[]>;
  append(transaction: Transaction): Promise<{ checkpoint: Checkpoint; event: Event; duplicate: boolean }>;
}
