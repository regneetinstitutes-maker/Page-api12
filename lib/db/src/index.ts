import { drizzle } from "drizzle-orm/node-postgres";
import { readFileSync } from "node:fs";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export function createPoolConfig(databaseUrl: string) {
  const ssl = process.env.PGSSLROOTCERT
    ? {
        ca: readFileSync(process.env.PGSSLROOTCERT, "utf8"),
        rejectUnauthorized: true,
      }
    : { rejectUnauthorized: true };

  return { connectionString: databaseUrl, ssl };
}

export const pool = new Pool(createPoolConfig(process.env.DATABASE_URL));
export const db = drizzle(pool, { schema });

export * from "./schema";
