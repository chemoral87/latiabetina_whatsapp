#!/bin/bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

APP_DIR="/var/www/whatsapbot"
RELEASES_DIR="$APP_DIR/releases"
CURRENT_LINK="$APP_DIR/current"
REPO_URL="https://github.com/chemoral87/latiabetina_whatsapp.git"
RELEASE_NAME="${1:-$(date +%Y%m%d%H%M%S)}"
RELEASE_PATH="$RELEASES_DIR/$RELEASE_NAME"
KEEP_RELEASES=5

error_exit() {
  echo -e "${RED}❌ Error: $1${NC}"
  exit 1
}

echo -e "${YELLOW}🚀 Starting deployment: $RELEASE_NAME${NC}"

mkdir -p "$RELEASES_DIR"

# Clone repo at specific commit into new release folder
echo -e "${YELLOW}📦 Cloning repository...${NC}"
git clone --depth 1 "$REPO_URL" "$RELEASE_PATH" || error_exit "Git clone failed"

cd "$RELEASE_PATH" || error_exit "Cannot enter release directory"

if [ -f "$APP_DIR/.env.production" ]; then
  echo -e "${YELLOW}📄 Copying .env.production file...${NC}"
  cp -f "$APP_DIR/.env.production" "$RELEASE_PATH/.env.production" || error_exit "Failed to copy .env.production"
else
  echo -e "${YELLOW}⚠️ No .env.production file found at $APP_DIR/.env.production${NC}"
fi

# Checkout specific commit if provided
if [ -n "$1" ]; then
  git fetch --depth 1 origin "$1" || true
  git checkout "$1" 2>/dev/null || true
fi

# Install dependencies
echo -e "${YELLOW}📦 Installing dependencies...${NC}"
npm install || error_exit "npm install failed"

# Update current symlink atomically (zero downtime)
echo -e "${YELLOW}🔗 Updating current symlink...${NC}"
ln -sfn "$RELEASE_PATH" "$CURRENT_LINK" || error_exit "Symlink update failed"

# Restart app with pm2 using ecosystem config
echo -e "${YELLOW}🔄 Restarting app...${NC}"
cd "$CURRENT_LINK"
pm2 delete WhatsappBot || true
pm2 start ecosystem.config.cjs --update-env || error_exit "pm2 start failed"
pm2 save

# Reload nginx if needed (uncomment if you have nginx proxying to this bot)
# echo -e "${YELLOW}🔄 Reloading nginx...${NC}"
# nginx -t && systemctl reload nginx || error_exit "nginx reload failed"

# Keep only last $KEEP_RELEASES
echo -e "${YELLOW}🧹 Cleaning old releases (keeping last $KEEP_RELEASES)...${NC}"
cd "$RELEASES_DIR"
ls -1dt */ | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf

echo -e "${GREEN}✅ Deployment $RELEASE_NAME completed successfully!${NC}"
