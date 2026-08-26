/**
 * PM2 configuration for the production backend.
 *
 * Run `pm2 start ecosystem.config.cjs`, then `pm2 save` and `pm2 startup`
 * once on the EC2 host to persist the process across reboots.
 */
module.exports = {
  apps: [
    {
      name: "pagewoga-backend",
      cwd: "/home/ec2-user/Page-api12",
      script: "./artifacts/api-server/dist/index.mjs",
      interpreter: "node",
      node_args: "--enable-source-maps",
      env: {
        NODE_ENV: "production",
        AWS_REGION: "ap-south-1",
        PORT: "3000",
        PGSSLROOTCERT: "/etc/ssl/certs/rds-global-bundle.pem",
      },
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      max_memory_restart: "500M",
      kill_timeout: 5000,
      listen_timeout: 5000,
      merge_logs: false,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};