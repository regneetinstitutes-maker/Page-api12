# AWS RDS PostgreSQL SSL Audit

## Scope

Audited the runtime database initialization, production secret loading, PM2
configuration, and Drizzle migration configuration for AWS RDS PostgreSQL TLS.

## Findings and resolution

The API server imports `@workspace/db` only after production secrets are
loaded. The shared package creates one `pg.Pool`, and Drizzle uses that pool.
Authentication requests and scheduler jobs therefore share the same TLS
configuration.

Previously, the pool set `rejectUnauthorized: true` but supplied an RDS CA only
when `PGSSLROOTCERT` happened to be present. On an EC2 host without that CA,
Node used its default trust store and could reject the RDS certificate chain.

The pool now:

- Reads a PEM CA bundle from `PGSSLROOTCERT` (a filesystem path), or from
  `PGSSLROOTCERT_CONTENT` (PEM content supplied by an environment manager).
- Passes the CA as `ssl.ca` to `pg`.
- Always sets `ssl.rejectUnauthorized: true`.
- Throws during production pool initialization if neither CA source exists.

The PM2 production environment sets `PGSSLROOTCERT` to
`/etc/ssl/certs/rds-global-bundle.pem`. Deployment documentation installs the
current AWS RDS global CA bundle at that path.

This follows the AWS RDS and Node PostgreSQL pattern: trust the AWS-issued RDS
certificate chain explicitly and verify the server certificate. It does not
use `sslmode=require` as a verification substitute, disable TLS validation, or
set `NODE_TLS_REJECT_UNAUTHORIZED=0`.

## Files modified

- `lib/db/src/index.ts`: secure CA loading and production fail-closed behavior.
- `artifacts/api-server/src/lib/db-connection.test.ts`: tests for PEM CA input
  and production CA enforcement.
- `ecosystem.config.cjs`: PM2 production CA bundle path.
- `PRODUCTION_DEPLOYMENT.md`: EC2 CA installation and environment instructions.
- `docs/database-ssl-audit.md`: this audit report.

## EC2 deployment

From the application checkout on EC2:

```bash
cd /home/ec2-user/Page-api12
git pull origin main
sudo mkdir -p /etc/ssl/certs
sudo curl --fail --location --output /etc/ssl/certs/rds-global-bundle.pem \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
sudo chmod 0644 /etc/ssl/certs/rds-global-bundle.pem
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-server build
pm2 restart pagewoga-backend --update-env
pm2 save
```

If the process does not exist yet, use `pm2 start ecosystem.config.cjs` instead
of the restart command. Verify the result with:

```bash
pm2 status
pm2 logs pagewoga-backend --lines 100
curl --fail http://localhost:3000/health
```

The PM2 configuration must be the source of `PGSSLROOTCERT`; do not rely on an
interactive shell export that PM2 may not inherit. The RDS security group,
endpoint, port, and EC2 IAM permission for Secrets Manager remain separate
operational prerequisites.

## Validation

Editor diagnostics report no errors in the changed TypeScript files. The
focused Vitest command was attempted but could not start because the local
terminal wrapper reported its `rg` sandbox prerequisite as unavailable. Run
this command on the development or EC2 host after dependencies are available:

```bash
pnpm --filter @workspace/api-server test -- src/lib/db-connection.test.ts
```
