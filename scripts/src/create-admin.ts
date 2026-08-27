import { readFileSync } from "node:fs";
import pg from "pg";
import bcrypt from "bcrypt";

const { Pool } = pg;
const username = process.env.ADMIN_USERNAME ?? "admin_niha";
const password = process.env.ADMIN_PASSWORD;
const name = process.env.ADMIN_NAME ?? "Admin Niha";
const passwordRounds = 10;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

if (!password) {
  throw new Error("ADMIN_PASSWORD must be set");
}

if (password.length < 12) {
  throw new Error("ADMIN_PASSWORD must be at least 12 characters long");
}

const ca = process.env.PGSSLROOTCERT_CONTENT
  ?? (process.env.PGSSLROOTCERT
    ? readFileSync(process.env.PGSSLROOTCERT, "utf8")
    : undefined);

if (process.env.NODE_ENV === "production" && !ca) {
  throw new Error("PGSSLROOTCERT or PGSSLROOTCERT_CONTENT must be set in production");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { ...(ca ? { ca } : {}), rejectUnauthorized: true },
});

try {
  const passwordHash = await bcrypt.hash(password, passwordRounds);
  const result = await pool.query(
    `INSERT INTO users
      (username, name, age, password_hash, password_algo, role, account_status,
       failed_login_attempts, locked_until, updated_at)
     VALUES ($1, $2, 18, $3, 'bcrypt', 'admin', 'active', 0, NULL, now())
     ON CONFLICT (username) DO UPDATE SET
       name = EXCLUDED.name,
       password_hash = EXCLUDED.password_hash,
       password_algo = EXCLUDED.password_algo,
       role = 'admin',
       account_status = 'active',
       failed_login_attempts = 0,
       locked_until = NULL,
       updated_at = now()
     RETURNING id, username, role`,
    [username.toLowerCase(), name, passwordHash],
  );

  console.log(`Admin user ready: ${result.rows[0].username} (${result.rows[0].id})`);
} finally {
  await pool.end();
}