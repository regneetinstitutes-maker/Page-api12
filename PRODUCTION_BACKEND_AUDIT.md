# Pagewoga Backend Production Audit

Date: 2026-08-19

## Root Cause

The original `index.ts` statically imported `app` and `scheduler` before its
async secrets initializer ran. `app` imports routes, and the route graph imports
`@workspace/db`; that package validates `DATABASE_URL` while its module is
evaluated. This caused the original `DATABASE_URL must be set` failure and, in
some configurations, the `postgres` hostname failure from an incorrect or
stale connection string.

The secrets loader required `dbname`, although the production secret uses the
explicit `database` field. It also loaded no PayU variables into the runtime,
which caused the later `PAYU_KEY` validation failure. The current loader accepts
`database` as canonical and `dbname` as a legacy alias; it never defaults the
database name.

The `secret is not defined` message was caused by a manual troubleshooting
scope/reference regression. There is no such reference in the corrected loader;
configuration errors now identify the failed category without exposing values.

The previous PM2 file used the wrong EC2 path and an ESM `.mjs` config that was
being loaded through `require`, producing `ERR_REQUIRE_ESM`. The canonical PM2
file is now CommonJS.

## Files Changed

- `artifacts/api-server/src/index.ts`: dynamically imports the application and
  scheduler only after production secrets initialize.
- `artifacts/api-server/src/lib/secrets.ts`: validates the explicit database
  mapping, loads the five PayU fields, avoids secret-bearing error text, and
  separates loading from environment publication.
- `artifacts/api-server/src/lib/deposit.ts`: prefers the production-provided
  `PAYU_URL`, while retaining the existing development/test URL derivation.
- `artifacts/api-server/src/index.startup.test.ts`: proves production secret
  initialization precedes application evaluation, listening, and scheduler
  startup.
- `artifacts/api-server/src/lib/secrets.test.ts`: covers valid configuration,
  legacy database naming, missing fields, PayU validation, retrieval failure,
  malformed JSON, and non-disclosure in errors.
- `ecosystem.config.cjs`: provides the CommonJS PM2 configuration with the
  correct working directory, entrypoint, environment, and restart policy.
- `ecosystem.config.mjs`: removed because PM2 was loading it incompatibly.
- `PRODUCTION_DEPLOYMENT.md`: corrected the canonical path, build command,
  PM2 command, and secret key-name documentation.
- `PRODUCTION_BACKEND_AUDIT.md`: this audit.

## Files Not Changed

No AWS resources, IAM permissions, Secrets Manager values, EC2 files, RDS
configuration, VPC, security groups, deployment state, or credentials were
modified. `PRODUCTION_READINESS_REPORT.md` remains a historical report and was
not rewritten.

## Startup Flow

```text
production process starts
  -> initializeSecrets()
  -> DATABASE_URL and PayU runtime variables are published
  -> dynamic app and scheduler module imports evaluate
  -> app.listen()
  -> scheduler starts from the listen callback
```

The database package therefore cannot evaluate before production secret
initialization completes, and scheduler timers cannot start before the server
has begun listening.

## Secret Schema

Required key names:

- `host`
- `port`
- `database` (canonical PostgreSQL database name)
- `username`
- `password`
- `PAYU_KEY`
- `PAYU_SALT`
- `PAYU_SURL`
- `PAYU_FURL`
- `PAYU_URL`

`dbname` is accepted only as a legacy alias for `database`. `engine` and
`dbInstanceIdentifier` are not used to construct the connection string.

## PM2 and Build

PM2 uses `ecosystem.config.cjs`, `cwd` `/home/ec2-user/Page-api12`, and the
built entrypoint `./artifacts/api-server/dist/index.mjs`. It sets only
`NODE_ENV=production`, `AWS_REGION=ap-south-1`, and `PORT=3000`; no credentials
are stored in the repository.

The production backend build command is:

```bash
pnpm --filter @workspace/api-server build
```

It removes and recreates `artifacts/api-server/dist`, including
`artifacts/api-server/dist/index.mjs`.

## Validation

The VS Code diagnostics check reported no errors for all touched TypeScript
files, and the repository search found no logger or console path that prints
`DATABASE_URL`, `PAYU_KEY`, `PAYU_SALT`, or passwords.

The Vitest and build commands could not execute in this environment: the
terminal runner reported that its `rg` sandbox prerequisite was unavailable,
and the workspace task runner had no registered filesystem handle. No AWS or
deployment command was attempted.

Commands for the review environment:

```bash
pnpm --filter @workspace/api-server test -- src/lib/secrets.test.ts src/index.startup.test.ts --run
pnpm --filter @workspace/api-server typecheck
pnpm --filter @workspace/api-server build
```

## Later Deployment Procedure

These commands are documented for a later approved deployment and were not
executed during this audit:

```bash
cd /home/ec2-user/Page-api12
git pull origin main
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-server build
pm2 start ecosystem.config.cjs
# For an existing process, use: pm2 reload pagewoga-backend --update-env
pm2 save
curl --fail http://127.0.0.1:3000/health
```

Run `pm2 startup` once during host setup and execute the generated command as
the EC2 user. Do not put secret values in shell history or repository files.

## Rollback

Before deployment, save the review diff with `git diff > /tmp/pagewoga.patch`.
To undo the uncommitted review locally, use `git apply -R /tmp/pagewoga.patch`
after inspecting that patch. For an approved deployed revision, check out the
previous known-good commit, reinstall with the matching lockfile, rebuild, and
run `pm2 reload pagewoga-backend --update-env`; do not alter Secrets Manager or
AWS infrastructure as part of rollback.