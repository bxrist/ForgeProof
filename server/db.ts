import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import { hasApplicationStorage } from "./storageBackend";

const { Pool } = pg;

let connection: pg.Pool | undefined;
function getPool(): pg.Pool {
  if (hasApplicationStorage()) throw new Error("PostgreSQL is disabled in Git-authoritative mode");
  if (connection) return connection;
  if (!process.env.DATABASE_URL) throw new Error("PostgreSQL access requires DATABASE_URL");
  connection = new Pool({ connectionString: process.env.DATABASE_URL });
  connection.on("error", () => {
  // node-postgres emits this for idle clients that disconnect unexpectedly.
  // Handle it so a transient database socket drop cannot crash the process.
  console.error("Unexpected PostgreSQL pool connection error; the idle connection was discarded.");
  });
  return connection;
}

// Importing the shared application storage interface must not open or require
// PostgreSQL. SQL remains explicit and never falls back to a local database.
export const pool = new Proxy({} as pg.Pool, {
  get(_target, name) {
    const actual = getPool();
    const value = Reflect.get(actual, name);
    return typeof value === "function" ? value.bind(actual) : value;
  },
});
function createDatabase() { return drizzle(getPool(), { schema }); }
let database: ReturnType<typeof createDatabase> | undefined;
export const db = new Proxy({} as ReturnType<typeof createDatabase>, {
  get(_target, name) {
    if (hasApplicationStorage()) throw new Error("PostgreSQL is disabled in Git-authoritative mode");
    database ??= createDatabase();
    const value = Reflect.get(database, name);
    return typeof value === "function" ? value.bind(database) : value;
  },
});
