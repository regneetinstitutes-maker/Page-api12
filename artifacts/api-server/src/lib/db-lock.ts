const LOCK_NAMESPACE = 4_821_907;

function lockKey(name: string): number {
  let hash = LOCK_NAMESPACE;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return hash;
}

export async function withDatabaseAdvisoryLock<T>(name: string, work: () => Promise<T>): Promise<T | undefined> {
  if (process.env.NODE_ENV === "test") return work();
  const { pool } = await import("@workspace/db");
  const client = await pool.connect();
  const key = lockKey(name);
  try {
    const result = await client.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [key]);
    if (!result.rows[0]?.locked) return undefined;
    try {
      return await work();
    } finally {
      await client.query("select pg_advisory_unlock($1)", [key]);
    }
  } finally {
    client.release();
  }
}
