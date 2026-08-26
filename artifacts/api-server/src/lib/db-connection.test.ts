import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("shared database pool configuration", () => {
  beforeEach(() => {
    delete process.env.PGSSLROOTCERT;
    delete process.env.PGSSLROOTCERT_CONTENT;
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    delete process.env.PGSSLROOTCERT_CONTENT;
    process.env.NODE_ENV = "test";
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

  it("uses the configured CA bundle while retaining certificate verification", async () => {
    const databaseUrl = "postgresql://test-user:test-password@localhost:5432/test-db";
    const ca = "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----";
    process.env.DATABASE_URL = databaseUrl;
    process.env.PGSSLROOTCERT_CONTENT = ca;
    const { createPoolConfig } = await import("../../../../lib/db/src/index");

    expect(createPoolConfig(databaseUrl)).toEqual({
      connectionString: databaseUrl,
      ssl: { ca, rejectUnauthorized: true },
    });
  });

  it("requires an explicit CA bundle in production", async () => {
    process.env.NODE_ENV = "production";
    const databaseUrl = "postgresql://test-user:test-password@localhost:5432/test-db";
    const { createPoolConfig } = await import("../../../../lib/db/src/index");

    expect(() => createPoolConfig(databaseUrl)).toThrow(
      "PGSSLROOTCERT or PGSSLROOTCERT_CONTENT must be set in production",
    );
  });
});