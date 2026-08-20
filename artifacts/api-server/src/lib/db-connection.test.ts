import { beforeEach, describe, expect, it } from "vitest";

describe("shared database pool configuration", () => {
  beforeEach(() => {
    delete process.env.PGSSLROOTCERT;
  });

  it("enables TLS with certificate verification", async () => {
    const databaseUrl = "postgresql://test-user:test-password@localhost:5432/test-db";
    process.env.DATABASE_URL = databaseUrl;
    const { createPoolConfig } = await import("../../../../lib/db/src/index");

    expect(createPoolConfig(databaseUrl)).toEqual({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: true },
    });
  });
});