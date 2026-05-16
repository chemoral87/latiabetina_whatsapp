module.exports = {
  apps: [
    {
      name: "WhatsappBot",
      script: "server.js",
      cwd: "/home/pi/latiabetina_whatsapp",
      watch: false,
      instances: 1,
      autorestart: true,
      max_restarts: 5,
      env: {
        PORT: 3007,
        NODE_ENV: "production",
        CHROME_BIN: "/usr/bin/chromium",
      },
    },
  ],
}
