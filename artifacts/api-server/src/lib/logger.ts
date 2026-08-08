import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    // Request headers that carry authentication credentials.
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
    // Sensitive request body fields. These are redacted so that if an
    // unhandled error causes the request body to be logged (e.g. by the
    // pino-http serializer or a debug middleware), full account numbers and
    // other PII are never written to the log stream.
    "req.body.bankAccountNumber",
    "req.body.snapshotBankAccountNumber",
    "req.body.password",
    "req.body.passwordHash",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
