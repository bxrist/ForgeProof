/// <reference types="node" />
export type RecordClass = 'users' | 'repositories' | 'organizations' | 'orgMembers' | 'apiKeys' | 'subscriptions' | 'auditLogs' | 'sessions' | 'receipts';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface AppRecord { id: string | number; [field: string]: Json }
export interface Checkpoint { commit: string; eventHash: string; sequence: number }
export interface Trust {
  eventKeys: Record<string, { actor: string; publicKey: string }>;
  receiptKeys: string[];
  receiptPredecessor: string | null;
}
export type Operation = { kind: RecordClass; id: string | number; expectedVersion: number | null } & (
  { action: 'put'; record: AppRecord } | { action: 'delete' }
);
export interface Transaction { idempotencyKey: string; operations: Operation[] }
export interface Signer { actor: string; keyId: string; sign(bytes: Buffer): Promise<string> }
export interface Options {
  directory: string;
  tenant: string;
  repository: string;
  trust: Trust;
  checkpoint: Checkpoint | null;
  signer?: Signer;
  /** May only lower the production 8 MiB limit. */
  maxEventBytes?: number;
}
export interface Event {
  body: Transaction & { version: 1; tenant: string; repository: string; sequence: number; previous: string | null; actor: string; keyId: string; requestHash: string };
  signature: string;
}
export interface Replay {
  checkpoint: Checkpoint | null;
  records: Record<RecordClass, Record<string, AppRecord>>;
  versions: Record<string, number>;
  events: Event[];
  receiptHead: string | null;
}
export const MAX_EVENT_BYTES: number;
export class ConflictError extends Error {}
export class IntegrityError extends Error {}
export class GitAppStateService {
  constructor(options: Options);
  replay(): Promise<Replay>;
  preflight(transactions: Transaction[]): Promise<void>;
  get(kind: RecordClass, id: string | number): Promise<AppRecord | undefined>;
  list(kind: RecordClass): Promise<AppRecord[]>;
  append(transaction: Transaction): Promise<{ checkpoint: Checkpoint; event: Event; duplicate: boolean }>;
}
