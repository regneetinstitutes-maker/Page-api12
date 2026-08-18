/**
 * PM2 Ecosystem Configuration for Pagewoga Backend
 * 
 * This configuration manages the production Node.js backend process using PM2.
 * 
 * Usage:
 *   pm2 start ecosystem.config.mjs
 *   pm2 restart pagewoga-backend
 *   pm2 stop pagewoga-backend
 *   pm2 logs pagewoga-backend
 *   pm2 save               # Save PM2 state for reboot persistence
 *   pm2 startup            # Generate startup hook for EC2 reboot
 * 
 * After deployment, on EC2:
 *   pm2 start ecosystem.config.mjs
 *   pm2 startup           # Enable PM2 autostart on reboot
 *   pm2 save              # Save the process list
 */

export default {
  apps: [
    {
      // Process identifier within PM2
      name: "pagewoga-backend",

      // Start command - runs from the repository root
      // NODE_ENV=production enables Secrets Manager integration
      script: "node",
      args: "--enable-source-maps ./artifacts/api-server/dist/index.mjs",

      // Working directory for the process
      cwd: "/home/ec2-user/pagewoga",

      // Environment variables provided to the process
      // In production, DATABASE_URL will be loaded from AWS Secrets Manager at startup
      env: {
        NODE_ENV: "production",
        AWS_REGION: "ap-south-1",
        PORT: "3000",
      },

      // Restart policies
      watch: false,                  // Do not auto-restart on file changes (production)
      ignore_watch: ["node_modules", "dist", "tmp"],
      max_memory_restart: "500M",    // Restart if memory exceeds 500MB
      
      // Instance management
      instances: 1,                  // Run a single instance
      exec_mode: "fork",            // Use fork mode (not cluster mode)

      // Graceful shutdown
      kill_timeout: 5000,           // Give 5 seconds for graceful shutdown
      listen_timeout: 5000,         // Allow 5 seconds for app to listen

      // Logging
      output: "/var/log/pm2/pagewoga-backend-out.log",
      error: "/var/log/pm2/pagewoga-backend-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      // Startup hooks for EC2 reboot persistence
      autorestart: true,            // Auto-restart on unexpected exit
      max_restarts: 10,             // Limit restart attempts
      min_uptime: "10s",            // Minimum uptime before considering a restart loop

      // Error handling
      merge_logs: false,            // Keep stdout and stderr separate
      events: {
        restart: "echo 'App restarted'",
        reload: "echo 'App reloaded'",
        stop: "echo 'App stopped'",
        exit: "echo 'App exited'",
        "restart overlimit": "echo 'Restart limit exceeded'",
      },
    },
  ],

  // Deploy configuration (optional, used for pm2 deploy)
  deploy: {
    production: {
      user: "ec2-user",
      host: "pagewoga.online",          // Update with actual EC2 IP/hostname
      ref: "origin/main",
      repo: "https://github.com/your-org/pagewoga-backend.git",  // Update with actual repo
      path: "/home/ec2-user/pagewoga",
      "post-deploy": [
        "pnpm install --frozen-lockfile",
        "pnpm run build",
        "pm2 restart pagewoga-backend",
      ].join(" && "),
    },
  },
};
