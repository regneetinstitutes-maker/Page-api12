import app from "./app";
import { logger } from "./lib/logger";
import { startScheduler } from "./lib/scheduler";
import { initializeSecrets } from "./lib/secrets";

/**
 * Application entry point with secrets initialization.
 * 
 * This IIFE ensures that DATABASE_URL is loaded from AWS Secrets Manager
 * (in production) before any module that imports the database is initialized.
 */
(async () => {
  try {
    // ── Initialize secrets ──────────────────────────────────────────────
    // Must be first: loads DATABASE_URL from AWS Secrets Manager in production.
    if (process.env.NODE_ENV === "production") {
      logger.info("Secrets: loading from AWS Secrets Manager.");
      await initializeSecrets();
      logger.info("Secrets: successfully loaded from AWS Secrets Manager.");
    }

    // ── PORT ──────────────────────────────────────────────────────────────────────

    const rawPort = process.env["PORT"];

    if (!rawPort) {
      throw new Error("PORT environment variable is required but was not provided.");
    }

    const port = Number(rawPort);

    if (Number.isNaN(port) || port <= 0) {
      throw new Error(`Invalid PORT value: "${rawPort}"`);
    }

    // ── PayU deposit startup validation ──────────────────────────────────────────
    // All required PayU variables are checked before the server begins accepting
    // requests.  Only variable *names* are ever passed to the logger — secret
    // values (PAYU_KEY, PAYU_SALT) are never read or printed here.

    const PAYU_REQUIRED = ["PAYU_KEY", "PAYU_SALT", "PAYU_SURL", "PAYU_FURL"] as const;

    for (const varName of PAYU_REQUIRED) {
      if (!process.env[varName]) {
        logger.fatal(
          "PayU configuration invalid.\n" +
            `Missing environment variable: ${varName}\n` +
            "Server startup aborted.",
        );
        process.exit(1);
      }
    }

    // PAYU_ENV is optional but, when present, must be one of the two known values.
    // Its value is not a secret — logging it on misconfiguration is safe.
    const payuEnv = process.env["PAYU_ENV"] ?? "test";
    if (payuEnv !== "test" && payuEnv !== "production") {
      logger.fatal(
        "PayU configuration invalid.\n" +
          `PAYU_ENV must be "test" or "production", got "${payuEnv}".\n` +
          "Server startup aborted.",
      );
      process.exit(1);
    }

    // ── Graceful shutdown ─────────────────────────────────────────────────────────
    // Signal handlers are registered before listen() so they are in place even
    // if startup validation fails (though that exits immediately anyway).

    let schedulerHandles: { stop(): void } | null = null;

    function gracefulShutdown(signal: string) {
      logger.info({ signal }, "Server shutting down gracefully.");
      schedulerHandles?.stop();
      // Allow in-flight requests a brief moment to complete before exiting.
      setTimeout(() => process.exit(0), 200).unref();
    }

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));

    // ── Start ─────────────────────────────────────────────────────────────────────

    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }

      logger.info({ port }, "Server listening");

      // Start withdrawal background jobs now that the server is accepting requests.
      // startScheduler() is a no-op when NODE_ENV === 'test'.
      schedulerHandles = startScheduler();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.fatal({ err: message }, "Fatal error during startup. Server cannot start.");
    process.exit(1);
  }
})();
