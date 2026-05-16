module.exports = {
  apps: [
    {
      name: "WhatsappBot",
      script: "server.js",
      cwd: __dirname,
      watch: false,
      instances: 1,
      autorestart: true,
      max_restarts: 5,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
