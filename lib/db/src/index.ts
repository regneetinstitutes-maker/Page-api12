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
  const ca = process.env.PGSSLROOTCERT_CONTENT
    ?? (process.env.PGSSLROOTCERT
      ? readFileSync(process.env.PGSSLROOTCERT, "utf8")
      : undefined);

  if (process.env.NODE_ENV === "production" && !ca) {
    throw new Error(
      "PGSSLROOTCERT or PGSSLROOTCERT_CONTENT must be set in production " +
        "to verify the AWS RDS PostgreSQL certificate chain.",
    );
  }

  const ssl = {
    ...(ca ? { ca } : {}),
    rejectUnauthorized: true,
  };

  return { connectionString: databaseUrl, ssl };
}

export const pool = new Pool(createPoolConfig(process.env.DATABASE_URL));
export const db = drizzle(pool, { schema });

export * from "./schema";
