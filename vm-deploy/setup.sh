#!/bin/bash
# ============================================================
# Oracle Cloud VM Setup Script
# Run once after creating the VM to install all dependencies
# Usage: chmod +x setup.sh && sudo ./setup.sh
# ============================================================
set -e

echo "=== QuikStrike Scraper VM Setup ==="

# ── 1. System packages ──
echo "[1/6] Installing system packages..."
apt-get update -y
apt-get install -y \
    python3 python3-pip python3-venv \
    git wget curl unzip \
    fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 \
    libnss3 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
    xdg-utils

# ── 2. Google Chrome ──
echo "[2/6] Installing Google Chrome..."
if ! command -v google-chrome &> /dev/null; then
    wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    dpkg -i google-chrome-stable_current_amd64.deb || apt-get install -f -y
    rm -f google-chrome-stable_current_amd64.deb
    echo "Chrome installed: $(google-chrome --version)"
else
    echo "Chrome already installed: $(google-chrome --version)"
fi

# ── 3. Create app user (if not exists) ──
APP_USER="scraper"
echo "[3/6] Setting up app user: $APP_USER..."
if ! id "$APP_USER" &>/dev/null; then
    useradd -m -s /bin/bash "$APP_USER"
    echo "Created user: $APP_USER"
else
    echo "User $APP_USER already exists"
fi

# ── 4. Clone repo ──
REPO_DIR="/home/$APP_USER/vacant-exoplanet"
echo "[4/6] Setting up repository..."
if [ ! -d "$REPO_DIR" ]; then
    su - "$APP_USER" -c "git clone https://github.com/kitkonsss/vacant-exoplanet.git $REPO_DIR"
    echo "Cloned repo to $REPO_DIR"
else
    echo "Repo already exists at $REPO_DIR"
fi

# ── 5. Python venv + dependencies ──
echo "[5/6] Setting up Python environment..."
su - "$APP_USER" -c "
    cd $REPO_DIR
    python3 -m venv venv
    source venv/bin/activate
    pip install --upgrade pip
    pip install -r scraper/requirements.txt
"

# ── 6. Setup credentials & git config ──
echo "[6/6] Final setup..."
su - "$APP_USER" -c "
    cd $REPO_DIR
    git config user.name 'scraper-vm[bot]'
    git config user.email 'scraper-vm[bot]@users.noreply.github.com'
"

echo ""
echo "============================================"
echo "  Setup complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Set credentials:"
echo "     sudo -u $APP_USER nano /home/$APP_USER/.env"
echo "     (add CME_EMAIL=xxx and CME_PASSWORD=xxx)"
echo ""
echo "  2. Set up GitHub push authentication:"
echo "     sudo -u $APP_USER bash"
echo "     cd $REPO_DIR"
echo "     git remote set-url origin https://<PAT>@github.com/kitkonsss/vacant-exoplanet.git"
echo ""
echo "  3. Install cron:"
echo "     sudo -u $APP_USER bash $REPO_DIR/vm-deploy/install_cron.sh"
echo ""
echo "  4. Test run:"
echo "     sudo -u $APP_USER bash $REPO_DIR/vm-deploy/scrape_and_push.sh"
echo ""
