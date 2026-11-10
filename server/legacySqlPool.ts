import type { PoolClient, QueryResult, QueryResultRow } from "pg";
let database: Promise<typeof import("./db")> | undefined;
const legacyDatabase = () => database ??= import("./db");

/** Rollback-only SQL access. Importing commercial routes never opens or even
 * imports the PostgreSQL implementation; Git handlers return before using it. */
export const pool = {
  async query<T extends QueryResultRow = any>(text: string, values?: any[]): Promise<QueryResult<T>> {
    return (await legacyDatabase()).pool.query<T>(text, values);
  },
  async connect(): Promise<PoolClient> {
    return (await legacyDatabase()).pool.connect();
  },
};
