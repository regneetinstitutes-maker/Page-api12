import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("@aws-sdk/client-secrets-manager", () => ({
  GetSecretValueCommand: vi.fn((input) => input),
  SecretsManagerClient: vi.fn(() => ({ send: sendMock })),
}));

const validSecret = {
  engine: "postgres",
  host: "db.example.internal",
  port: 5432,
  database: "postgres",
  username: "postgres",
  password: "db-password",
  PAYU_KEY: "payu-key",
  PAYU_SALT: "payu-salt",
  PAYU_SURL: "https://example.com/success",
  PAYU_FURL: "https://example.com/failure",
  PAYU_URL: "https://secure.payu.in/_payment",
};

describe("production secrets loader", () => {
  beforeEach(() => {
    vi.resetModules();
    sendMock.mockReset();
    process.env.NODE_ENV = "production";
    process.env.AWS_REGION = "ap-south-1";
    delete process.env.DATABASE_URL;
    for (const field of ["PAYU_KEY", "PAYU_SALT", "PAYU_SURL", "PAYU_FURL", "PAYU_URL"]) {
      delete process.env[field];
    }
  });

  it("builds the database URL and publishes PayU configuration", async () => {
    sendMock.mockResolvedValue({ SecretString: JSON.stringify(validSecret) });
    const { initializeSecrets } = await import("./secrets");

    await initializeSecrets();

    expect(process.env.DATABASE_URL).toBe(
      "postgresql://postgres:db-password@db.example.internal:5432/postgres",
    );
    expect(process.env.PAYU_KEY).toBe("payu-key");
    expect(process.env.PAYU_SALT).toBe("payu-salt");
    expect(process.env.PAYU_URL).toBe("https://secure.payu.in/_payment");
  });

  it("accepts the legacy dbname field without defaulting the database name", async () => {
    const { database: _database, ...legacySecret } = validSecret;
    sendMock.mockResolvedValue({ SecretString: JSON.stringify({ ...legacySecret, dbname: "legacy_db" }) });
    const { getDatabaseUrl } = await import("./secrets");

    await expect(getDatabaseUrl()).resolves.toContain("/legacy_db");
  });

  it("rejects a secret with no explicit database name", async () => {
    const { database: _database, ...missingDatabase } = validSecret;
    sendMock.mockResolvedValue({ SecretString: JSON.stringify(missingDatabase) });
    const { initializeSecrets } = await import("./secrets");

    await expect(initializeSecrets()).rejects.toThrow("database configuration is incomplete");
  });

  it("rejects incomplete PayU configuration", async () => {
    const { PAYU_KEY: _key, ...missingPayU } = validSecret;
    sendMock.mockResolvedValue({ SecretString: JSON.stringify(missingPayU) });
    const { initializeSecrets } = await import("./secrets");

    await expect(initializeSecrets()).rejects.toThrow("missing PAYU_KEY");
  });

  it("reports retrieval failure without exposing the rejected value", async () => {
    sendMock.mockRejectedValue(new Error("secret-value-should-not-appear"));
    const { initializeSecrets } = await import("./secrets");

    await expect(initializeSecrets()).rejects.toThrow("Failed to load production configuration");
    await expect(initializeSecrets()).rejects.not.toThrow("secret-value-should-not-appear");
  });

  it("reports malformed JSON without exposing its contents", async () => {
    sendMock.mockResolvedValue({ SecretString: '{"password":"hidden"' });
    const { initializeSecrets } = await import("./secrets");

    await expect(initializeSecrets()).rejects.toThrow("secret JSON is malformed");
    await expect(initializeSecrets()).rejects.not.toThrow("hidden");
  });
});