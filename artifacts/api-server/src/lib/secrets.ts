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
interface DatabaseSecret {
  engine: string;
  host: string;
  port: number;
  dbname: string;
  username: string;
  password: string;
}

/**
 * Loads database credentials from AWS Secrets Manager (production)
 * or returns DATABASE_URL from environment (development).
 */
async function loadDatabaseUrl(): Promise<string> {
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
    return databaseUrl;
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

    const secret = JSON.parse(response.SecretString) as DatabaseSecret;

    // Validate required fields
    if (!secret.host || !secret.port || !secret.dbname || !secret.username || !secret.password) {
      throw new Error(
        `Secret ${secretName} is missing required fields. ` +
        "Expected: engine, host, port, dbname, username, password",
      );
    }

    // Construct DATABASE_URL from secret components
    // Handle special characters in password using percent-encoding
    const encodedPassword = encodeURIComponent(secret.password);
    const databaseUrl = `postgresql://${secret.username}:${encodedPassword}@${secret.host}:${secret.port}/${secret.dbname}`;

    return databaseUrl;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load database credentials from AWS Secrets Manager (${secretName}): ${message}`,
    );
  }
}

/**
 * Initialize production secrets at startup.
 *
 * This function MUST be called before any module that uses DATABASE_URL.
 * Typically called in index.ts before importing the database module.
 */
export async function initializeSecrets(): Promise<void> {
  try {
    const databaseUrl = await loadDatabaseUrl();
    process.env.DATABASE_URL = databaseUrl;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Secrets initialization failed: ${message}`);
  }
}

/**
 * For testing: get the loaded database URL without modifying process.env
 */
export async function getDatabaseUrl(): Promise<string> {
  return loadDatabaseUrl();
}
