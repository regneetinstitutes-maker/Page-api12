# Pagewoga Backend Production Deployment Guide

This guide explains how to deploy the Pagewoga backend on AWS EC2 after pulling the updated repository.

---

## Prerequisites

Before deploying, ensure:

1. **EC2 instance** is running (Ubuntu 24.04 or similar)
2. **AWS Secrets Manager** contains the database secret at `pagewoga/prod/database`:
   ```json
   {
     "engine": "postgresql",
     "host": "pagewoga-db.cvm6yc6wit1b.ap-south-1.rds.amazonaws.com",
     "port": 5432,
     "dbname": "pagewoga-db",
     "username": "postgres",
     "password": "your-actual-password"
   }
   ```
3. **EC2 IAM role** has permission to read the Secrets Manager secret
4. **AWS RDS PostgreSQL** is running and network-accessible from EC2
5. **Nginx** is installed and configured as a reverse proxy (listening on port 443 HTTPS)
6. **Node.js 24+** and **pnpm** are installed on EC2

---

## Prerequisites Setup (First Time Only)

### Install Node.js and pnpm

```bash
# Install Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install pnpm
npm install -g pnpm
```

### Install PM2 Globally

```bash
sudo npm install -g pm2
```

### Create Application Directory

```bash
# Create the directory where the backend will run
sudo mkdir -p /home/ec2-user/pagewoga
sudo chown ec2-user:ec2-user /home/ec2-user/pagewoga

# Set proper permissions
chmod 755 /home/ec2-user/pagewoga
```

---

## Deployment Steps

Run these commands on EC2 after pulling the repository:

### 1. Navigate to the Application Directory

```bash
cd /home/ec2-user/pagewoga
```

### 2. Pull/Update the Repository

```bash
# If first time:
# git clone <repository-url> .

# If updating existing deployment:
git pull origin main
git checkout <release-branch-or-tag>
```

### 3. Install Dependencies

```bash
pnpm install --frozen-lockfile
```

**What this does:**
- Installs all npm dependencies defined in `package.json`
- Uses `--frozen-lockfile` to ensure exact versions match what was tested
- Creates `node_modules/` directory

### 4. Build the Application

```bash
pnpm run build
```

**What this does:**
- Runs TypeScript type checking across all packages
- Compiles TypeScript to JavaScript using esbuild
- Creates `/artifacts/api-server/dist/index.mjs` (the production entry point)
- Bundles external dependencies appropriately

### 5. Stop the Running Process (If Already Running)

```bash
pm2 stop pagewoga-backend || true
```

**Note:** `|| true` prevents errors if the process isn't running (on first deployment)

### 6. Start with PM2

```bash
pm2 start ecosystem.config.mjs
```

**What this does:**
- Reads the ecosystem configuration
- Starts the Node.js backend on port 3000 (internally)
- Sets up logging to `/var/log/pm2/pagewoga-backend-*.log`
- Configures restart policies

**Verify the process is running:**

```bash
pm2 status
pm2 logs pagewoga-backend
```

### 7. Save PM2 State (Persistence on EC2 Reboot)

```bash
pm2 save
```

**One-time setup for autostart on EC2 reboot:**

```bash
pm2 startup
# Copy and run the output command (it looks like):
# sudo env PATH=$PATH:/usr/bin /usr/local/lib/node_modules/pm2/bin/pm2 startup systemd -u ec2-user --hp /home/ec2-user
```

### 8. Verify Nginx Configuration (Reverse Proxy)

Nginx should be configured to forward requests to the backend:

```nginx
server {
    listen 443 ssl http2;
    server_name pagewoga.online;

    ssl_certificate /path/to/certificate.crt;
    ssl_certificate_key /path/to/private.key;

    location /api {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Reload Nginx:

```bash
sudo systemctl reload nginx
```

---

## Environment Variables

**In Production:**

- **DATABASE_URL** is loaded automatically from AWS Secrets Manager at startup
- All other required variables must be set either:
  - In the PM2 ecosystem configuration (`ecosystem.config.mjs`)
  - In EC2 environment variables
  - In a `.env` file on EC2 (not committed to the repository)

**Example: Set additional variables on EC2**

```bash
# Create/edit ~/.bashrc or /etc/environment
export PORT=3000
export NODE_ENV=production
export AWS_REGION=ap-south-1
export CORS_ORIGINS=https://pagewoga.online,https://admin.pagewoga.online
export S3_BUCKET=pagewoga-uploads
export PAYU_KEY=your_payu_key
export PAYU_SALT=your_payu_salt
export PAYU_SURL=https://pagewoga.online/api/deposits/payu-success
export PAYU_FURL=https://pagewoga.online/api/deposits/payu-failure
export PAYU_ENV=production
export PAYU_PAYOUT_KEY=your_payout_key
export PAYU_PAYOUT_SALT=your_payout_salt
export PAYU_PAYOUT_ENV=production
export BANK_ACCOUNT_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
export PUSH_PROVIDER_URL=https://push-provider.example.com
export FIREBASE_PROJECT_ID=your-firebase-project
```

---

## Database Migrations

**First-time deployment only:**

```bash
# Push database schema to RDS (uses DATABASE_URL from Secrets Manager)
cd /home/ec2-user/pagewoga
pnpm --filter @workspace/db run push
```

**On subsequent deployments:**

- If there are schema changes in the repository, run the same command
- If no schema changes, this step can be skipped

---

## Verification Checklist

After deployment, verify:

- [ ] `pm2 status` shows `pagewoga-backend` as `online`
- [ ] `curl http://localhost:3000/health` returns 200 OK (or appropriate response)
- [ ] `pm2 logs pagewoga-backend` shows no ERROR messages
- [ ] Logs show: "Secrets: successfully loaded from AWS Secrets Manager"
- [ ] Logs show: "Server listening" with the correct port
- [ ] Logs show: "Scheduler: background jobs starting"
- [ ] Nginx is forwarding requests to the backend
- [ ] `curl https://pagewoga.online/api/health` returns 200 OK

---

## Troubleshooting

### "DATABASE_URL must be set"

**Cause:** AWS Secrets Manager credentials are not available or the secret is not readable.

**Solution:**
1. Verify EC2 IAM role has permission to read `pagewoga/prod/database`
2. Verify the secret exists in AWS Secrets Manager
3. Check logs: `pm2 logs pagewoga-backend`

### "getaddrinfo ENOTFOUND postgres"

**Cause:** The application is trying to connect to a Docker hostname "postgres" which doesn't exist in production.

**Solution:**
- This should NOT happen after applying this update
- The new version loads DATABASE_URL from AWS Secrets Manager (which points to RDS, not "postgres")
- Verify DATABASE_URL is correctly loaded from Secrets Manager

### Process Crashes

**Check logs:**

```bash
pm2 logs pagewoga-backend
```

**Common issues:**
- Missing required environment variables (check `.env.example`)
- PayU credentials invalid or missing
- S3 bucket not accessible
- Port 3000 already in use

### High Memory Usage

If PM2 shows memory restarts:

```bash
# Check memory
pm2 monit

# Increase limit if needed (edit ecosystem.config.mjs)
# max_memory_restart: "1000M"

# Restart
pm2 restart pagewoga-backend
```

---

## Rolling Back to Previous Version

If deployment fails:

### Option 1: Revert Git History

```bash
cd /home/ec2-user/pagewoga
git checkout <previous-tag-or-commit>
pnpm install --frozen-lockfile
pnpm run build
pm2 restart pagewoga-backend
```

### Option 2: Use PM2 Snapshot

If you saved PM2 state before deployment:

```bash
# PM2 keeps history of recent runs
pm2 describe pagewoga-backend

# If the process is dead, restart with the last known good version
pm2 start ecosystem.config.mjs
```

### Option 3: Re-deploy from Backup

If neither option works:

1. Restore the EC2 from a previous snapshot (if available)
2. Or manually re-deploy the last known good version

---

## Ongoing Maintenance

### Daily Operations

```bash
# Check status
pm2 status

# View logs
pm2 logs pagewoga-backend

# View real-time monitoring
pm2 monit
```

### Weekly Maintenance

```bash
# Check for updates
cd /home/ec2-user/pagewoga
git fetch origin
git log origin/main --oneline -5

# If updates available, deploy (follow deployment steps above)
```

### Monthly Maintenance

```bash
# Review logs for errors
pm2 logs pagewoga-backend | grep ERROR

# Check database backups in AWS RDS
# Verify S3 bucket contents
# Review CloudWatch metrics
```

---

## Emergency Procedures

### Stop the Backend

```bash
pm2 stop pagewoga-backend
# OR
pm2 kill  # Stops all PM2 processes
```

### Restart the Backend

```bash
pm2 restart pagewoga-backend
```

### Kill Hung Process

```bash
pm2 delete pagewoga-backend
# Then redeploy:
pm2 start ecosystem.config.mjs
```

---

## Security Checklist

- [ ] Repository does NOT contain `.env` files with secrets
- [ ] `.gitignore` protects all `.env*` files
- [ ] AWS Secrets Manager secret is in JSON format with all required fields
- [ ] EC2 IAM role has minimal required permissions (read-only on Secrets Manager)
- [ ] DATABASE_URL is never logged in plain text
- [ ] Port 3000 is NOT exposed to the internet (only Nginx port 443)
- [ ] Nginx uses TLS 1.2+ with strong ciphers
- [ ] PayU credentials are stored in Secrets Manager or EC2 environment, not in code
- [ ] S3 bucket permissions are restrictive (only EC2 can access)

---

## Additional Resources

- PM2 Documentation: https://pm2.keymetrics.io/
- AWS Secrets Manager: https://docs.aws.amazon.com/secretsmanager/
- Nginx Reverse Proxy: https://nginx.org/en/docs/http/ngx_http_proxy_module.html
- Node.js Production Practices: https://nodejs.org/en/docs/guides/nodejs-docker-webapp/

---

## Support

For issues:

1. Check logs: `pm2 logs pagewoga-backend`
2. Check PM2 status: `pm2 status`
3. Verify AWS permissions and secrets
4. Review this guide's troubleshooting section
5. Contact the development team with logs and error messages
