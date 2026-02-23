#!/bin/bash
# ============================================================
# Install Cron Jobs
# Schedule: Every 1 minute during trading hours (ICT)
#
# Trading hours (ICT → UTC):
#   12:00-21:30 ICT = 05:00-14:30 UTC  (main session)
#   22:00 ICT       = 15:00 UTC        (end-of-day snapshot)
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
# QuikStrike Scraper — every 1 minute during Gold futures trading hours
# Times in UTC (server should be UTC)
# 05:00-11:59 UTC = 12:00-18:59 ICT (Asian + London session)
* 5-11 * * 1-5   /home/scraper/vacant-exoplanet/vm-deploy/scrape_and_push.sh

# 12:00-14:30 UTC = 19:00-21:30 ICT (US session)
* 12-13 * * 1-5   /home/scraper/vacant-exoplanet/vm-deploy/scrape_and_push.sh
0-30 14 * * 1-5    /home/scraper/vacant-exoplanet/vm-deploy/scrape_and_push.sh

# 15:00 UTC = 22:00 ICT (end-of-day snapshot)
0 15 * * 1-5       /home/scraper/vacant-exoplanet/vm-deploy/scrape_and_push.sh
EOF
)

echo "$CRON_CONTENT" | crontab -

echo "✅ Cron installed! Current crontab:"
echo ""
crontab -l
echo ""
echo "Schedule: every 1 min, Mon-Fri, 12:00-21:30 ICT + 22:00 ICT"
echo "Logs: /home/scraper/logs/scrape_YYYYMMDD.log"
