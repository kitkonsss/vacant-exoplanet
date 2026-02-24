#!/bin/bash
# ============================================================
# Install Cron Jobs
# Schedule: Every 5 minutes during trading hours (ICT)
#
# Trading hours (ICT → UTC):
#   12:00-22:59 ICT = 05:00-15:59 UTC
#
# Run as the scraper user:
#   bash /home/scraper/vacant-exoplanet/vm-deploy/install_cron.sh
# ============================================================

REPO_DIR="/home/scraper/vacant-exoplanet"
SCRIPT="$REPO_DIR/vm-deploy/scrape_and_push.sh"

# Make script executable
chmod +x "$SCRIPT"

# Build crontab
CRON_CONTENT=$(cat <<'EOF'
# QuikStrike Scraper — every 5 minutes during Gold futures trading hours
# Times in UTC (server should be UTC)
# 05:00-15:59 UTC = 12:00-22:59 ICT
*/5 5-15 * * 1-5   /home/scraper/vacant-exoplanet/vm-deploy/scrape_and_push.sh
EOF
)

echo "$CRON_CONTENT" | crontab -

echo "✅ Cron installed! Current crontab:"
echo ""
crontab -l
echo ""
echo "Schedule: every 5 min, Mon-Fri, 12:00-22:59 ICT (05:00-15:59 UTC)"
echo "Logs: /home/scraper/logs/scrape_YYYYMMDD.log"
