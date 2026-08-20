/**
 * AWS Secrets Manager loader for production environment.
 *
 * In production (NODE_ENV=production), this module loads database credentials
 * from AWS Secrets Manager at application startup.
 *
 * In development, this module reads DATABASE_URL from environment variables
 * (typically set in .env).
 *
 * The EC2 IAM role must have permission to read the secret:
 * "pagewoga/prod/database"
 */

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

/**
 * Database secret structure expected from AWS Secrets Manager
 */
interface ProductionSecret {
  engine?: string;
  host: string;
  port: number | string;
  database?: string;
  dbname?: string;
  username: string;
  password: string;
  PAYU_KEY: string;
  PAYU_SALT: string;
  PAYU_SURL: string;
  PAYU_FURL: string;
  PAYU_URL: string;
}

const REQUIRED_PAYU_FIELDS = [
  "PAYU_KEY",
  "PAYU_SALT",
  "PAYU_SURL",
  "PAYU_FURL",
  "PAYU_URL",
] as const;

/**
 * Loads database credentials from AWS Secrets Manager (production)
 * or returns DATABASE_URL from environment (development).
 */
interface LoadedProductionConfig {
  databaseUrl: string;
  payu: Record<(typeof REQUIRED_PAYU_FIELDS)[number], string> | null;
}

async function loadProductionConfig(): Promise<LoadedProductionConfig> {
  const isProduction = process.env.NODE_ENV === "production";

  // Development: use DATABASE_URL from environment
  if (!isProduction) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL must be set in development environment. " +
        "Set it in .env or process.env.",
      );
    }
    return { databaseUrl, payu: null };
  }

  // Production: load from AWS Secrets Manager
  const secretName = process.env.DATABASE_SECRET_NAME || "pagewoga/prod/database";

  try {
    const client = new SecretsManagerClient({ region: process.env.AWS_REGION || "ap-south-1" });

    const response = await client.send(
      new GetSecretValueCommand({ SecretId: secretName }),
    );

    if (!response.SecretString) {
      throw new Error(
        `Secret ${secretName} does not contain SecretString. ` +
        "Verify the secret is stored in JSON format.",
      );
    }

    let secret: ProductionSecret;
    try {
      secret = JSON.parse(response.SecretString) as ProductionSecret;
    } catch {
      throw new Error("secret JSON is malformed");
    }

    const databaseName = secret.database || secret.dbname;
    if (!secret.host || !secret.port || !databaseName || !secret.username || !secret.password) {
      throw new Error(
        "database configuration is incomplete; expected host, port, database or dbname, username, and password",
      );
    }

    const missingPayUField = REQUIRED_PAYU_FIELDS.find((field) => !secret[field]);
    if (missingPayUField) {
      throw new Error(`PayU configuration is incomplete; missing ${missingPayUField}`);
    }

    const port = Number(secret.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error("database configuration has an invalid port");
    }

    // Construct DATABASE_URL from secret components
    // Handle special characters in password using percent-encoding
    const encodedPassword = encodeURIComponent(secret.password);
    const databaseUrl = `postgresql://${encodeURIComponent(secret.username)}:${encodedPassword}@${secret.host}:${port}/${encodeURIComponent(databaseName)}`;

    return {
      databaseUrl,
      payu: Object.fromEntries(
        REQUIRED_PAYU_FIELDS.map((field) => [field, secret[field]]),
      ) as LoadedProductionConfig["payu"],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(
      `Failed to load production configuration from AWS Secrets Manager (${secretName}): ${message}`,
    );
  }
}

/**
 * Initialize production secrets at startup.
 *
 * This function must complete before importing any module that uses the
 * database or PayU configuration.
 */
export async function initializeSecrets(): Promise<void> {
  try {
    const config = await loadProductionConfig();
    process.env.DATABASE_URL = config.databaseUrl;
    if (config.payu) {
      for (const [field, value] of Object.entries(config.payu)) {
        process.env[field] = value;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Secrets initialization failed: ${message}`);
  }
}

/**
 * For testing: get the loaded database URL without modifying process.env
 */
export async function getDatabaseUrl(): Promise<string> {
  const config = await loadProductionConfig();
  return config.databaseUrl;
}
