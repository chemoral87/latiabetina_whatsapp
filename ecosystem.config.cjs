module.exports = {
  apps: [
    {
      name: "WhatsappBot",
      script: "server.js",
      cwd: "/var/www/whatsapbot/current",
      watch: false,
      instances: 1,
      autorestart: true,
      max_restarts: 5,
      env: {
        PORT: 3007,
        NODE_ENV: "production",
      },
    },
  ],
}
