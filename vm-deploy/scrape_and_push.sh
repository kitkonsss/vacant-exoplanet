#!/bin/bash
# ============================================================
# Scrape & Push Script
# Called by cron every minute during trading hours
# ============================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="/home/scraper/logs"
LOG_FILE="$LOG_DIR/scrape_$(date +%Y%m%d).log"
LOCK_FILE="/tmp/quikstrike_scraper.lock"

# Create log dir
mkdir -p "$LOG_DIR"

# ── Prevent overlapping runs ──
if [ -f "$LOCK_FILE" ]; then
    PID=$(cat "$LOCK_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "[$(date '+%H:%M:%S')] Skipped — previous run (PID $PID) still running" >> "$LOG_FILE"
        exit 0
    else
        rm -f "$LOCK_FILE"
    fi
fi
echo $$ > "$LOCK_FILE"
trap "rm -f $LOCK_FILE" EXIT

# ── Load credentials ──
if [ -f /home/scraper/.env ]; then
    export $(grep -v '^#' /home/scraper/.env | xargs)
fi

# ── Activate venv ──
source "$REPO_DIR/venv/bin/activate"

echo "" >> "$LOG_FILE"
echo "=== [$(date '+%Y-%m-%d %H:%M:%S')] Scrape started ===" >> "$LOG_FILE"

# ── Pull latest (in case workflow or manual edit updated something) ──
cd "$REPO_DIR"
git pull --rebase --quiet 2>> "$LOG_FILE" || true

# ── Run scraper (GC + NQ) ──
cd "$REPO_DIR/scraper"
python quikstrike_scraper.py --asset all >> "$LOG_FILE" 2>&1
SCRAPE_EXIT=$?

if [ $SCRAPE_EXIT -ne 0 ]; then
    echo "[$(date '+%H:%M:%S')] Scraper exited with code $SCRAPE_EXIT" >> "$LOG_FILE"
    exit $SCRAPE_EXIT
fi

# Keep one Position Bias dashboard snapshot per Bangkok-time scrape.
cd "$REPO_DIR"
python scraper/bias_snapshot.py >> "$LOG_FILE" 2>&1 || true

# ── Commit & Push (data/ includes data/nq/ for NQ) ──
cd "$REPO_DIR"
if [ -n "$(git status --porcelain data/)" ]; then
    BRANCH="$(git rev-parse --abbrev-ref HEAD)"
    git add data/
    git commit -m "auto-update data $(date '+%Y-%m-%d %H:%M') [skip ci]" --quiet
    git pull --rebase --quiet origin "$BRANCH" 2>> "$LOG_FILE"
    git push --quiet origin HEAD:"$BRANCH" 2>> "$LOG_FILE"
    echo "[$(date '+%H:%M:%S')] ✅ Pushed data update" >> "$LOG_FILE"
else
    echo "[$(date '+%H:%M:%S')] No changes in data/" >> "$LOG_FILE"
fi

# ── Cleanup old logs (keep 7 days) ──
find "$LOG_DIR" -name "scrape_*.log" -mtime +7 -delete 2>/dev/null || true

echo "=== [$(date '+%H:%M:%S')] Done ===" >> "$LOG_FILE"
