# QuikStrike Vol2Vol Scraper v4 — GC (Gold) only
# Scrapes options Vol2Vol data from CME QuikStrike
#
# Supports:
#   - GC (Gold)  : pid=40, pf=6
#
# From screenshots, QuikStrike UI has:
#   - EXPIRATION dropdown: custom popup grid (not standard <select>)
#   - Sidebar links: Volume > Intraday, EOD | Open Interest > OI, OI Change, Churn
#   - Highcharts charts with Put/Call/Vol Settle/Ranges series
#
# Requirements: pip install selenium webdriver-manager

import os
import sys
import json
import time
import re
import shutil
import subprocess
import csv
import io
from datetime import datetime, timezone
try:
    from zoneinfo import ZoneInfo
except ImportError:
    ZoneInfo = None
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait, Select
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException, ElementClickInterceptedException
from webdriver_manager.chrome import ChromeDriverManager

try:
    import yfinance as yf
    HAS_YFINANCE = True
except ImportError:
    HAS_YFINANCE = False
    print('[WARN] yfinance not installed — futures price fallback unavailable. pip install yfinance')

# ============================================================
# ASSET PROFILES
# ============================================================
ASSET_PROFILES = {
    'gc': {
        'name': 'Gold (GC)',
        'short': 'GC',
        'pid': 40,
        'pf': 6,
        'yahoo_symbol': 'GC=F',
        'min_price': 1000,          # plotLine filter: futures price must be > this
        'data_subfolder': '',       # data/ (root)
        # Contract symbol patterns for GC:
        #   OGH6  = monthly (OG + month_letter + year)
        #   OG4G6 = friday  (OG + digit + month + year)
        #   G4MG6 = daily   (G + digit + ...)
        'contract_pattern': r'^(OG|G[0-9])',
        'monthly_check': lambda sym: len(sym) >= 4 and sym[:2] == 'OG' and sym[2].isalpha(),
        'friday_check': lambda sym: len(sym) >= 4 and sym[:2] == 'OG' and sym[2].isdigit(),
    },
}

# ============================================================
# CONFIG
# ============================================================
CME_EMAIL = os.environ.get('CME_EMAIL', '')
CME_PASSWORD = os.environ.get('CME_PASSWORD', '')
BASE_OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
DATA_REPO_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'atas-data')
HEATMAP_STRIKE_WINDOW = os.environ.get('QS_HEATMAP_STRIKES', '50').strip()

# QuikStrike's heatmap dropdown values are strikes above/below ATM,
# so 15 => 31 rows, 25 => 51 rows, and 50 => 101 rows.
if HEATMAP_STRIKE_WINDOW not in {'10', '15', '25', '50', '-1'}:
    print(f'[WARN] Invalid QS_HEATMAP_STRIKES={HEATMAP_STRIKE_WINDOW!r} — falling back to 50')
    HEATMAP_STRIKE_WINDOW = '50'

# Which assets to scrape (can be overridden via CLI args)
ASSETS_TO_SCRAPE = ['gc']

def get_quikstrike_url(asset_id):
    """Build QuikStrike URL for a given asset."""
    p = ASSET_PROFILES[asset_id]
    if p['pid'] is None:
        return None
    return f'https://cmegroup-sso.quikstrike.net/User/QuikStrikeView.aspx?pid={p["pid"]}&pf={p["pf"]}'

def get_output_dir(asset_id):
    """Get output directory for a given asset."""
    p = ASSET_PROFILES[asset_id]
    if p['data_subfolder']:
        return os.path.join(BASE_OUTPUT_DIR, p['data_subfolder'])
    return BASE_OUTPUT_DIR

# ============================================================

def create_driver():
    options = Options()
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--headless=new')
    options.add_argument('--window-size=1920,1080')
    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=options)
    driver.implicitly_wait(2)
    return driver


def save_debug(driver, label='', output_dir=None):
    """Save page source + screenshot for debugging."""
    try:
        d = output_dir or BASE_OUTPUT_DIR
        os.makedirs(d, exist_ok=True)
        suffix = f'_{label}' if label else ''
        html_path = os.path.join(d, f'debug{suffix}.html')
        png_path = os.path.join(d, f'debug{suffix}.png')
        with open(html_path, 'w', encoding='utf-8') as f:
            f.write(driver.page_source)
        driver.save_screenshot(png_path)
        print(f'[DEBUG] Saved: {html_path}')
        print(f'[DEBUG] Saved: {png_path}')
    except Exception as e:
        print(f'[DEBUG] Error saving debug: {e}')


# ============================================================
# LOGIN
# ============================================================

def login_cme(driver, quikstrike_url, max_wait=120):
    """Navigate to QuikStrike → handle SSO login → handle disclaimer."""
    print(f'[LOGIN] Opening QuikStrike URL: {quikstrike_url}')
    driver.get(quikstrike_url)
    time.sleep(2)

    # Poll until we reach the Vol2Vol page
    start = time.time()
    logged_in = False
    credentials_entered = False

    while time.time() - start < max_wait:
        url = driver.current_url

        # ✅ On QuikStrike Vol2Vol page
        if 'quikstrike.net' in url and 'QuikStrikeView' in url and 'Disclaimer' not in url:
            print(f'[LOGIN] ✅ On Vol2Vol page!')
            return True

        # 📋 Disclaimer page — MUST check BEFORE QuikStrikeView!
        # Because Disclaimer URL contains 'QuikStrikeView' in the ret= query param:
        #   .../Disclaimer.aspx?ret=%2fUser%2fQuikStrikeView.aspx%3fpid%3d40%26pf%3d6
        is_disclaimer = 'disclaimer' in url.lower() or 'Disclaimer' in url
        if not is_disclaimer:
            try:
                title = driver.title or ''
                if 'disclaimer' in title.lower():
                    is_disclaimer = True
            except:
                pass
        
        if is_disclaimer:
            print('[LOGIN] Disclaimer page detected — auto-accepting...')
            _handle_disclaimer(driver)
            time.sleep(1.5)
            continue

        # ✅ On QuikStrike Vol2Vol page (not disclaimer)
        if 'quikstrike.net' in url and 'QuikStrikeView' in url:
            print(f'[LOGIN] ✅ On Vol2Vol page!')
            return True

        # 🔐 SSO Login page
        if 'login.cmegroup.com' in url:
            if not credentials_entered:
                if CME_EMAIL and CME_PASSWORD:
                    _try_auto_login(driver)
                    credentials_entered = True
                else:
                    if not logged_in:
                        print(f'[LOGIN] ⚠ Manual login required. You have {max_wait}s...')
                        logged_in = True
            time.sleep(2)
            continue

        # Unknown — wait
        time.sleep(2)

    print('[LOGIN] ❌ Timed out.')
    return False


def _try_auto_login(driver):
    try:
        user = WebDriverWait(driver, 10).until(EC.presence_of_element_located((By.ID, 'user')))
        user.clear()
        user.send_keys(CME_EMAIL)
        pwd = driver.find_element(By.ID, 'pwd')
        pwd.clear()
        pwd.send_keys(CME_PASSWORD)
        driver.find_element(By.ID, 'loginBtn').click()
        print('[LOGIN] Submitted credentials...')
    except Exception as e:
        print(f'[LOGIN] Auto-login failed: {e}')


def _handle_disclaimer(driver):
    """Accept the QuikStrike disclaimer page.
    
    The disclaimer page has:
      - A checkbox: "I have read and agree with the above disclaimer"
      - A "Continue" button (input[type="submit"] value="Continue")
    The checkbox MUST be checked before the Continue button works.
    """
    # ── Step 1: Check the agreement checkbox ──
    checkbox_checked = False
    try:
        # First check for checkbox (some disclaimers require checking a box first)
        # Added #chkAccept for specific targeting
        checkboxes = driver.find_elements(By.CSS_SELECTOR, 'input[type="checkbox"], #chkAccept')
        for cb in checkboxes:
            if not cb.is_selected():
                # Use JavaScript click — more reliable on ASP.NET pages
                driver.execute_script('arguments[0].click();', cb)
                print('[DISCLAIMER] Checked checkbox')
                time.sleep(0.5)
                
                # Verify and fallback if needed
                if not cb.is_selected():
                    try:
                        driver.execute_script('arguments[0].checked = true;', cb)
                        print('[DISCLAIMER] Forced check via attribute')
                    except:
                        pass
    except:
        pass

    # ── Step 2: Click the Continue/Accept/Submit button ──
    # Try specific selectors in priority order
    button_selectors = [
        '#btnContinue', '[id*="btnContinue"]',
        'input[value="Continue"]', 'input[value="continue"]',
        'input[type="submit"]', 'button[type="submit"]',
        'input[value*="ccept"]', 'input[value*="gree"]',
        '[id*="ccept"]', '[id*="gree"]', '[id*="btnOK"]',
        '#btnAccept', '#btnAgree', '#submit',
    ]
    for sel in button_selectors:
        try:
            btn = driver.find_element(By.CSS_SELECTOR, sel)
            driver.execute_script('arguments[0].click();', btn)
            print(f'[DISCLAIMER] ✅ Clicked button: {sel} (value="{btn.get_attribute("value") or btn.text}")')
            time.sleep(1.5)
            return
        except:
            continue

    # Fallback: click any submit/button element
    for el in driver.find_elements(By.CSS_SELECTOR, 'input[type="submit"], input[type="button"], button'):
        val = el.get_attribute('value') or el.text or ''
        if val:
            print(f'[DISCLAIMER] Found button: "{val}" — clicking...')
            try:
                driver.execute_script('arguments[0].click();', el)
                time.sleep(1.5)
                return
            except:
                continue

    print('[DISCLAIMER] ⚠ Could not auto-accept. Please click manually...')


# ============================================================
# PAGE INTERACTION
# ============================================================

def wait_ready(driver, timeout=15):
    """Wait for page to be fully loaded (ASP.NET postback complete)."""
    try:
        WebDriverWait(driver, timeout).until(
            lambda d: d.execute_script('return document.readyState') == 'complete'
        )
    except:
        pass
    # Wait for ASP.NET async postback to finish
    try:
        WebDriverWait(driver, timeout).until(
            lambda d: d.execute_script("""
                if (typeof Sys !== 'undefined' && Sys.WebForms && Sys.WebForms.PageRequestManager) {
                    return !Sys.WebForms.PageRequestManager.getInstance().get_isInAsyncPostBack();
                }
                return true;
            """)
        )
    except:
        pass
    time.sleep(0.5)


# ─────────────────────────────────────────────────────────────
# CHART-AWARE CONDITION WAITS
# Replaces blind time.sleep() after chart-changing actions.
# Safer than wait_ready alone: wait_ready returns when ASP.NET
# postback flag is false, but Highcharts redraws via a separate
# async callback that can complete LATER. Fingerprint-based wait
# subsumes both signals — it only returns when the chart has
# actually re-rendered with new data.
# ─────────────────────────────────────────────────────────────

_CHART_FP_JS = """
    if (typeof Highcharts === 'undefined') return 'no-hc';
    var charts = (Highcharts.charts || []).filter(c => c != null);
    if (!charts.length) return 'no-charts';
    var c = null;
    for (var i = 0; i < charts.length; i++) {
        if (charts[i].series && charts[i].series.length > 0) { c = charts[i]; break; }
    }
    if (!c) return 'no-series';
    var title = (c.title && c.title.textStr) || '';
    var sub = (c.subtitle && c.subtitle.textStr) || '';
    var sLen = c.series.length;
    var pts = (c.series[0] && c.series[0].data) ? c.series[0].data.length : 0;
    return title + '|' + sub + '|' + sLen + '|' + pts;
"""

_FP_NOT_READY = {'no-hc', 'no-charts', 'no-series', 'error', ''}


def _chart_fingerprint(driver):
    """Cheap snapshot of current Highcharts state. Returns 'no-*' sentinels when not ready."""
    try:
        return driver.execute_script(_CHART_FP_JS) or 'error'
    except Exception:
        return 'error'


def _fp_has_data(fp):
    """True when fingerprint represents a rendered chart with ≥1 data point."""
    if fp in _FP_NOT_READY:
        return False
    parts = fp.rsplit('|', 1)
    if len(parts) != 2:
        return False
    try:
        return int(parts[-1]) > 0
    except ValueError:
        return False


def wait_for_chart_ready(driver, timeout=10, poll=0.15):
    """Wait until Highcharts has rendered at least one data point. Returns True on success."""
    end = time.time() + timeout
    while time.time() < end:
        if _fp_has_data(_chart_fingerprint(driver)):
            return True
        time.sleep(poll)
    return False


def wait_for_chart_change(driver, baseline, timeout=15, poll=0.15):
    """Wait until chart fingerprint differs from baseline AND has data.

    Requires non-empty data in the new state to avoid returning during the
    transient empty window mid-postback. Returns new fingerprint or None
    on timeout — caller may proceed anyway (matches prior blind-sleep
    behavior) but the timeout itself is loud and debuggable.
    """
    end = time.time() + timeout
    while time.time() < end:
        current = _chart_fingerprint(driver)
        if current != baseline and _fp_has_data(current):
            return current
        time.sleep(poll)
    return None


def debug_page(driver, label=''):
    """Print comprehensive debug info about current page."""
    print(f'\n{"─"*50}')
    print(f'[DEBUG {label}]')
    print(f'  URL: {driver.current_url}')
    print(f'  Title: {driver.title}')

    info = driver.execute_script("""
        var result = {
            selects: [],
            relevantLinks: [],
            highchartsCount: -1,
            allLinksCount: document.querySelectorAll('a').length,
            bodyTextPreview: document.body ? document.body.innerText.substring(0, 500) : ''
        };

        // All <select> elements with options
        document.querySelectorAll('select').forEach(function(s) {
            var opts = Array.from(s.options).map(o => ({
                text: o.text.trim().substring(0, 50),
                value: o.value.substring(0, 50)
            }));
            result.selects.push({
                id: s.id || '(none)',
                name: s.name || '(none)',
                optionCount: s.options.length,
                options: opts.slice(0, 5)
            });
        });

        // Links with relevant text
        var keywords = ['intraday', 'volume', 'open interest', 'oi', 'eod', 'churn', 'expir'];
        document.querySelectorAll('a').forEach(function(a) {
            var txt = a.textContent.trim().toLowerCase();
            var id = a.id || '';
            for (var k of keywords) {
                if (txt.indexOf(k) >= 0 || id.toLowerCase().indexOf(k) >= 0) {
                    result.relevantLinks.push({
                        id: id,
                        text: a.textContent.trim().substring(0, 60),
                        href: a.href ? a.href.substring(0, 100) : ''
                    });
                    break;
                }
            }
        });

        // Highcharts
        if (typeof Highcharts !== 'undefined' && Highcharts.charts) {
            result.highchartsCount = Highcharts.charts.filter(c => c != null).length;
        }

        return result;
    """)

    print(f'  Highcharts charts: {info["highchartsCount"]}')
    print(f'  Total links: {info["allLinksCount"]}')

    if info['selects']:
        print(f'  SELECT elements ({len(info["selects"])}):')
        for s in info['selects']:
            print(f'    id="{s["id"]}" name="{s["name"]}" options={s["optionCount"]}')
            for o in s['options']:
                print(f'      → "{o["text"]}" (val={o["value"]})')
    else:
        print('  No <select> elements found')

    if info['relevantLinks']:
        print(f'  Relevant links ({len(info["relevantLinks"])}):')
        for l in info['relevantLinks']:
            print(f'    <a id="{l["id"]}">{l["text"]}</a>')
    else:
        print('  No relevant links found')

    # Show first 300 chars of body text
    body_preview = info.get('bodyTextPreview', '')[:300].replace('\n', ' | ')
    print(f'  Body preview: {body_preview}')
    print(f'{"─"*50}\n')

    return info


# ============================================================
# EXPIRATION SELECTION
# ============================================================

def get_expiration_contracts(driver, asset_profile):
    """
    Get all contracts including Daily, Friday, and Monthly.
    
    Strategy: scan links with 'lbExpiration' in id using CSS selector.
    The popup grid (ucSelector) contains daily contracts (G4WG6 etc.)
    The tab bar (ExpirationTabs) contains only the active set.
    We need BOTH sources to find all contract types.
    """
    contract_pattern = asset_profile['contract_pattern']
    # DO NOT call wait_ready() here — it can cause the popup grid to auto-close!
    
    # Step 1: Raw debug — how many lbExpiration links exist right now?
    raw_count = driver.execute_script("""
        var links = document.querySelectorAll('a[id*="lbExpiration"]');
        var result = [];
        links.forEach(function(a) {
            var txt = a.textContent.replace(/\\s+/g,' ').trim().split(' ')[0];
            result.push({id: a.id.slice(-40), txt: txt, vis: a.offsetParent !== null});
        });
        return result;
    """)
    print(f'[EXPIRY] Raw lbExpiration links found: {len(raw_count or [])}')
    for r in (raw_count or [])[:5]:
        print(f'  txt="{r["txt"]}" id=...{r["id"]} vis={r["vis"]}')
    if len(raw_count or []) > 5:
        print(f'  ... and {len(raw_count) - 5} more')
    
    # Step 2: Grab contracts from popup grid (ucSelector/lvGroupsExpirations)
    popup_contracts = driver.execute_script("""
        var result = [];
        var contractPattern = new RegExp(arguments[0]);
        document.querySelectorAll('a[id*="lbExpiration"]').forEach(function(a) {
            var id = a.id || '';
            // Get just the first line of text (popup links have lots of whitespace)
            var txt = a.textContent.replace(/\\s+/g,' ').trim().split(' ')[0];
            if (contractPattern.test(txt) && txt.length < 15) {
                var title = a.title || '';
                var dte = null;
                var match = title.match(/([\\d.]+)\\s*DTE/i);
                if (match) dte = parseFloat(match[1]);
                var dateStr = null;
                var dateMatch = title.match(/(\\d{1,2}\\/\\d{1,2}\\/\\d{4})/);
                if (dateMatch) dateStr = dateMatch[1];
                if (!result.find(c => c.text === txt)) {
                    result.push({text: txt, id: id, title: title, dte: dte, date_str: dateStr});
                }
            }
        });
        return result;
    """, contract_pattern)
    
    monthly_check = asset_profile['monthly_check']
    friday_check = asset_profile['friday_check']
    is_daily = lambda sym: not monthly_check(sym) and not friday_check(sym)
    daily_found = any(is_daily(c['text']) for c in (popup_contracts or []))
    print(f'[EXPIRY] Scan 1 (no click): {len(popup_contracts or [])} contracts, daily={daily_found}')
    
    contracts = popup_contracts or []
    
    # Step 3: If no daily contracts found, try toggling popup open
    if not daily_found:
        print('[EXPIRY] No daily contracts — trying to open popup...')
        for sel in ['[id*="hlExpiration"]']:
            try:
                el = driver.find_element(By.CSS_SELECTOR, sel)
                if el.tag_name == 'a' and el.is_displayed():
                    driver.execute_script('arguments[0].click();', el)
                    time.sleep(1)
                    print(f'[EXPIRY] Clicked: {sel}')
                    break
            except:
                continue
        
        popup2 = driver.execute_script("""
            var result = [];
            var contractPattern = new RegExp(arguments[0]);
            document.querySelectorAll('a[id*="lbExpiration"]').forEach(function(a) {
                var id = a.id || '';
                var txt = a.textContent.replace(/\\s+/g,' ').trim().split(' ')[0];
                if (contractPattern.test(txt) && txt.length < 15) {
                    var title = a.title || '';
                    var dte = null;
                    var match = title.match(/([\\d.]+)\\s*DTE/i);
                    if (match) dte = parseFloat(match[1]);
                    var dateStr = null;
                    var dateMatch = title.match(/(\\d{1,2}\\/\\d{1,2}\\/\\d{4})/);
                    if (dateMatch) dateStr = dateMatch[1];
                    if (!result.find(c => c.text === txt)) {
                        result.push({text: txt, id: id, title: title, dte: dte, date_str: dateStr});
                    }
                }
            });
            return result;
        """, contract_pattern)
        daily_found2 = any(is_daily(c['text']) for c in (popup2 or []))
        print(f'[EXPIRY] Scan 2 (after click): {len(popup2 or [])} contracts, daily={daily_found2}')
        
        if len(popup2 or []) > len(contracts) or (daily_found2 and not daily_found):
            contracts = popup2
    
    # Log results
    if contracts:
        print(f'[EXPIRY] Final: {len(contracts)} contracts:')
        for c in contracts[:20]:
            dte_str = f'{c["dte"]:.1f} DTE' if c.get('dte') is not None else 'no DTE'
            sym = c['text']
            if friday_check(sym):
                ctype = 'Friday'
            elif monthly_check(sym):
                ctype = 'Monthly'
            else:
                ctype = 'Daily'
            print(f'  {sym:8s} ({dte_str}) [{ctype}] id=...{c["id"][-25:]}')
        return contracts
    
    print('[EXPIRY] No contracts found')
    return []

def select_contract(driver, contract):
    """Click a contract tab link using JavaScript click."""
    contract_text = contract['text']
    contract_id = contract.get('id', '')
    
    # Close any open popup first
    from selenium.webdriver.common.keys import Keys
    try:
        driver.find_element(By.TAG_NAME, 'body').send_keys(Keys.ESCAPE)
        time.sleep(0.2)
    except:
        pass

    is_in_popup = 'ExpirationTab' not in contract_id

    if is_in_popup:
        print(f'[SELECT] Contract {contract_text} is in popup. Opening popup...')
        for sel in ['[id*="hlExpiration"]', '[id*="Expiration"]']:
            try:
                el = driver.find_element(By.CSS_SELECTOR, sel)
                if el.tag_name == 'a' and el.is_displayed():
                    driver.execute_script('arguments[0].click();', el)
                    time.sleep(1)
                    break
            except:
                continue

    # Strategy 1: Click by exact ID (most reliable)
    if contract_id:
        try:
            el = driver.find_element(By.ID, contract_id)
            baseline_fp = _chart_fingerprint(driver)
            driver.execute_script('arguments[0].click();', el)
            print(f'[SELECT] ✅ Clicked: {contract_text} (by ID)')
            wait_ready(driver, timeout=10)
            if wait_for_chart_change(driver, baseline_fp, timeout=15) is None:
                print(f'[SELECT] ⚠ Chart did not change after click (baseline_fp={baseline_fp!r})')
            return True
        except Exception as e:
            print(f'[SELECT] ID click failed: {e}')

    # Strategy 2: Find by text + ExpirationTab pattern (if it is a tab)
    links = driver.find_elements(By.TAG_NAME, 'a')
    for link in links:
        txt = link.text.strip()
        link_id = link.get_attribute('id') or ''
        if txt == contract_text and 'ExpirationTab' in link_id:
            try:
                baseline_fp = _chart_fingerprint(driver)
                driver.execute_script('arguments[0].click();', link)
                print(f'[SELECT] ✅ Clicked: {contract_text} (by text+ID)')
                wait_ready(driver, timeout=10)
                if wait_for_chart_change(driver, baseline_fp, timeout=15) is None:
                    print(f'[SELECT] ⚠ Chart did not change after click (baseline_fp={baseline_fp!r})')
                return True
            except Exception as e:
                print(f'[SELECT] Click failed: {e}')

    # Strategy 3: Any link with matching text
    for link in links:
        if link.text.strip() == contract_text:
            try:
                baseline_fp = _chart_fingerprint(driver)
                driver.execute_script('arguments[0].click();', link)
                print(f'[SELECT] ✅ Clicked: {contract_text} (fallback)')
                wait_ready(driver, timeout=10)
                if wait_for_chart_change(driver, baseline_fp, timeout=15) is None:
                    print(f'[SELECT] ⚠ Chart did not change after click (baseline_fp={baseline_fp!r})')
                return True
            except:
                continue

    print(f'[SELECT] ❌ Not found: {contract_text}')
    return False


# ============================================================
# CONTRACT CLASSIFICATION
# ============================================================

def _today_ny():
    """CME trading date in US/Eastern. GC (COMEX) closes at 5pm ET; after
    that the next trading session has begun, so the "trading date" rolls to
    the next calendar day. This ensures an evening scrape (e.g. 9pm ET,
    which is 8am next-day Thai time) correctly drops the previous day's
    expired contract rather than re-selecting it as "current".

    Fallback to plain UTC date when tzdata is unavailable.
    """
    from datetime import timedelta
    if ZoneInfo is not None:
        try:
            now_et = datetime.now(ZoneInfo('America/New_York'))
            # After 5pm ET → trading date is the next calendar day
            if now_et.hour >= 17:
                return (now_et + timedelta(days=1)).date()
            return now_et.date()
        except Exception:
            pass
    return datetime.now(timezone.utc).date()


def classify_contracts(contracts, asset_profile):
    """
    Classify contracts into current/tomorrow/friday/monthly using asset-specific symbol patterns + DTE.

    Rules:
      current = nearest non-expired daily/Monday contract (DTE >= 0); fallback to any active
      tomorrow = next daily/Monday contract after current (skipped when next expiry is already Friday)
      friday  = nearest Friday (OG+digit) contract with DTE > current's DTE
      monthly = nearest Monthly (OG+letter) contract with DTE > friday's DTE (or > current's)
    """
    # Skip contracts QuikStrike reports as already expired (DTE < 0).
    # We keep DTE >= 0 so the day-of-expiry contract is still considered "current"
    # while it is trading (e.g. G3MK6 with 0.4 DTE on its expiration day).
    MIN_DTE = 0.1

    # Primary filter: drop contracts whose listed expiration date is strictly
    # before "today" in NY time. This handles the case where DTE alone is
    # ambiguous: GC settles 1:30pm ET, so its same-day contract still reports a
    # small positive DTE after settlement and would otherwise be read as today's
    # contract when it is logically already expired.
    today_ny = _today_ny()

    def _parse_date(c):
        s = c.get('date_str')
        if not s:
            return None
        try:
            return datetime.strptime(s, '%m/%d/%Y').date()
        except (ValueError, TypeError):
            return None

    for c in contracts:
        c['exp_date'] = _parse_date(c)

    monthly_check = asset_profile['monthly_check']
    friday_check = asset_profile['friday_check']
    is_daily = lambda sym: not friday_check(sym) and not monthly_check(sym)
    result = {key: None for key in CONTRACT_KEYS}
    result['friday_is_current'] = False

    with_dte = [c for c in contracts if c.get('dte') is not None]
    sorted_c = sorted(with_dte, key=lambda c: c['dte'])

    if not sorted_c:
        print('[CLASSIFY] No DTE data — using first contracts')
        raw_dailies = [c for c in contracts if is_daily(c['text'])]
        raw_fridays = [c for c in contracts if friday_check(c['text'])]
        raw_monthlies = [c for c in contracts if monthly_check(c['text'])]

        if raw_dailies:
            result['current'] = raw_dailies[0]
            result['tomorrow'] = next(
                (c for c in raw_dailies if c['text'] != result['current']['text']),
                None,
            )
        elif contracts:
            result['current'] = contracts[0]

        if raw_fridays:
            result['friday'] = raw_fridays[0]
        if raw_monthlies:
            result['monthly'] = raw_monthlies[0]
        return result

    # A contract is "active" (eligible to be picked as current/tomorrow/etc.) when:
    #   - its expiration is not before today in NY time, AND
    #   - it is not in the MIN_DTE floor *unless* it still expires today.
    #
    # The NY-date check is the primary filter: it drops the previous-day daily
    # that is still in its post-trade settlement window (DTE 0..1) so we don't
    # pick yesterday's contract as "current".
    #
    # The MIN_DTE floor must NOT evict a contract that still expires *today*.
    # GC settles 1:30pm ET, so its same-day contract dips under MIN_DTE from
    # ~11:06am ET onward. Applying the floor unconditionally
    # made "current" wrongly jump to *tomorrow's* contract every day around
    # 11:19am ET (and Friday -> Monday). We keep a same-day contract eligible
    # until QuikStrike marks it actually expired (DTE < 0). The floor still
    # applies to undated / future-dated contracts to skip an unparseable
    # post-settlement leftover.
    def _is_active(c):
        exp = c.get('exp_date')
        if exp is not None and exp < today_ny:
            return False
        if exp == today_ny:
            return c['dte'] >= 0  # keep today's contract through its final hours
        return c['dte'] >= MIN_DTE

    active = [c for c in sorted_c if _is_active(c)]
    if not active:
        # Everything is expiring — fall back to taking them as-is
        print('[CLASSIFY] Warning: all contracts below MIN_DTE threshold, using raw sort')
        active = sorted_c
    print(f'[CLASSIFY] today_ny={today_ny.isoformat()}, {len(active)}/{len(sorted_c)} contracts pass active filter')

    # Current = lowest-DTE active contract overall, regardless of type.
    # On Mon-Thu the nearest daily wins (it has the lowest DTE). On Fridays,
    # today's expiring Friday weekly (e.g. OG4K6 with ~0.3 DTE) has a lower
    # DTE than any future daily, so it correctly becomes CURRENT instead of
    # being skipped in favour of next week's Wed/Thu daily.
    dailies = [c for c in active if is_daily(c['text'])]
    result['current'] = active[0]

    current_dte = result['current']['dte']

    # Tomorrow = next daily/Monday contract after current. This intentionally
    # skips Friday/weeklies so Thursday does not duplicate the dedicated Friday slot.
    future_dailies = [
        c for c in dailies
        if c['dte'] > current_dte and c['text'] != result['current']['text']
    ]
    if future_dailies:
        result['tomorrow'] = future_dailies[0]

    # Friday = nearest OG+digit contract with DTE strictly > current's DTE
    fridays = [c for c in active if friday_check(c['text']) and c['dte'] > current_dte]
    if fridays:
        result['friday'] = fridays[0]
    else:
        # Fallback: any friday >= MIN_DTE
        fridays_any = [c for c in sorted_c if friday_check(c['text']) and c['dte'] >= MIN_DTE]
        if fridays_any:
            result['friday'] = fridays_any[0]

    friday_dte = result['friday']['dte'] if result['friday'] else current_dte

    # Monthly = nearest OG+letter contract with DTE strictly > friday's DTE
    monthlies = [c for c in active if monthly_check(c['text']) and c['dte'] > friday_dte]
    if monthlies:
        result['monthly'] = monthlies[0]
    else:
        # Fallback: any monthly >= MIN_DTE
        monthlies_any = [c for c in sorted_c if monthly_check(c['text']) and c['dte'] >= MIN_DTE]
        if monthlies_any:
            result['monthly'] = monthlies_any[0]

    print(f'[CLASSIFY] Found {len(fridays)} Friday and {len(monthlies)} Monthly active contracts')
    print(f'[CLASSIFY] Current candidate: {result["current"].get("text", "?") if result["current"] else "None"} (DTE={result["current"].get("dte") if result["current"] else "?"})')
    print(f'[CLASSIFY] Tomorrow candidate: {result["tomorrow"].get("text", "?") if result["tomorrow"] else "None"} (DTE={result["tomorrow"].get("dte") if result["tomorrow"] else "?"})')
    print(f'[CLASSIFY] Friday candidate:  {result["friday"].get("text", "?") if result["friday"] else "None"} (DTE={result["friday"].get("dte") if result["friday"] else "?"})')
    print(f'[CLASSIFY] Monthly candidate: {result["monthly"].get("text", "?") if result["monthly"] else "None"} (DTE={result["monthly"].get("dte") if result["monthly"] else "?"})')

    if result['current'] and result['friday']:
        if result['current']['text'] == result['friday']['text']:
            result['friday_is_current'] = True
            print(f'[CLASSIFY] Note: Current contract is also the Friday contract ({result["current"]["text"]})')

    return result


def _saved_current_exp(output_dir):
    """Expiration date of the last successfully-saved 'current' contract,
    parsed from the existing current_OIData.txt header. Returns a date or
    None (no prior file / unparseable)."""
    path = os.path.join(output_dir, 'current_OIData.txt')
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as fh:
            header = fh.readline()
    except OSError:
        return None
    m = re.search(r'Expiration:\s*(\d{1,2}/\d{1,2}/\d{4})', header)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), '%m/%d/%Y').date()
    except (ValueError, TypeError):
        return None


# A holiday-adjusted "long weekend" front contract is at most +3 calendar days
# ahead of today (e.g. Good Friday -> the Monday contract). Anything farther on
# a regular scrape means the near-dated contracts simply were not listed yet.
MAX_FRONT_GAP_DAYS = 4


def current_pick_looks_incomplete(classified, output_dir):
    """Detect a truncated/incomplete contract listing (common in the overnight
    and early-morning hours when QuikStrike has not yet published the near-dated
    contracts). In that state `current` points at a far contract instead of
    today's expiry, e.g. a +5d daily on a Friday morning.

    Returns a human-readable reason string when the pick looks wrong (caller
    should skip the overwrite to preserve last-good data), or None when it
    looks fine. Conservative by design: it only fires on high-confidence
    signals so legitimate holidays are never skipped.
    """
    cur = classified.get('current')
    if not cur:
        return None  # nothing picked — handled elsewhere
    new_exp = cur.get('exp_date')
    if new_exp is None:
        return None  # no date info → cannot judge, let it through

    today = _today_ny()

    # (A) Regression check: the previously-saved current contract has NOT
    #     expired yet (its expiry is today or later) but this scrape picked a
    #     *later* expiry. That means a still-valid nearer contract was missing
    #     from the list — e.g. the early-Monday transient that briefly showed
    #     Tuesday's contract before the Monday one reappeared.
    old_exp = _saved_current_exp(output_dir)
    if old_exp is not None and old_exp >= today and new_exp > old_exp:
        return (f'picked {cur.get("text","?")} exp {new_exp} but last-good '
                f'contract exp {old_exp} has not expired yet')

    # (B) Absolute sanity: the front contract is implausibly far ahead. Allows
    #     single market holidays (up to +3 over a Good-Friday long weekend) and
    #     fires only beyond that.
    gap = (new_exp - today).days
    if gap >= MAX_FRONT_GAP_DAYS:
        return (f'front contract {cur.get("text","?")} exp {new_exp} is {gap} '
                f'days ahead of today {today} — near contracts not listed yet')

    # (C) No-daily check: if the front contract expires strictly after today
    #     AND no classified contract expires today, daily options are not
    #     listed yet (typical after 5pm ET / before 6pm ET when CME has
    #     closed the current session but not yet opened the next). Let
    #     promotion handle the day roll instead of overwriting current with
    #     a weekly/monthly.
    if new_exp > today:
        has_today = any(
            c is not None and c.get('exp_date') == today
            for c in (classified.get(k) for k in ('current', 'tomorrow', 'friday', 'monthly'))
        )
        if not has_today:
            return (f'no contract expiring today ({today}) — daily contracts '
                    f'not listed yet; front is {cur.get("text","?")} exp {new_exp}')

    return None


# Data file suffixes used for each contract slot.
_SLOT_SUFFIXES = (
    '_IntradayData.txt',
    '_OIData.txt',
    '_GammaHeatmap.json',
    '_OIHeatmap.json',
    '_PositionBias.json',
)


def _promote_slots(output_dir):
    """Shift saved slot files forward: tomorrow → current, friday → tomorrow.

    Called when the guard skips a scrape AND the saved current contract has
    already expired.  The "tomorrow" file from the last successful daytime
    scrape IS today's current contract.

    Idempotent: if tomorrow already has the same expiration as current
    (a previous run already promoted), this is a no-op.
    """
    # Idempotency: parse expirations from tomorrow vs current headers.
    # If they match, a prior promote already ran — skip.
    def _exp_from(slot):
        path = os.path.join(output_dir, f'{slot}_OIData.txt')
        try:
            with open(path, 'r', encoding='utf-8', errors='replace') as fh:
                hdr = fh.readline()
            m = re.search(r'Expiration:\s*(\d{1,2}/\d{1,2}/\d{4})', hdr)
            return m.group(1) if m else None
        except OSError:
            return None

    cur_exp = _exp_from('current')
    tom_exp = _exp_from('tomorrow')
    if cur_exp and tom_exp and cur_exp == tom_exp:
        print(f'[PROMOTE] Already promoted (current & tomorrow both exp {cur_exp}) — skipping')
        return

    promotions = [
        ('tomorrow', 'current'),
        ('friday', 'tomorrow'),
    ]
    for src_slot, dst_slot in promotions:
        for suffix in _SLOT_SUFFIXES:
            src = os.path.join(output_dir, f'{src_slot}{suffix}')
            dst = os.path.join(output_dir, f'{dst_slot}{suffix}')
            if os.path.exists(src):
                try:
                    shutil.copy2(src, dst)
                    print(f'[PROMOTE] {src_slot}{suffix} → {dst_slot}{suffix}')
                except Exception as e:
                    print(f'[PROMOTE] ⚠ Failed {src_slot}→{dst_slot}{suffix}: {e}')
            else:
                print(f'[PROMOTE] skip {src_slot}{suffix} (not found)')


# ============================================================
# VIEW SWITCHING
# ============================================================

def switch_to_view(driver, view_type):
    """
    Switch between Intraday Volume and Open Interest.
    
    Key insight from screenshots:
    - Vol2Vol page DEFAULT = Intraday Volume (no click needed)
    - Sidebar has plain text links: Intraday, EOD, OI, OI Change, Churn
    - These sidebar links may NOT have IDs!
    """
    # Close any open popup first
    from selenium.webdriver.common.keys import Keys
    try:
        driver.find_element(By.TAG_NAME, 'body').send_keys(Keys.ESCAPE)
        time.sleep(0.2)
    except:
        pass

    # Strategy 0: Dropdown Selection (ddlV2V) - Primary Method
    try:
        # Find the View/Vol2Vol dropdown
        select_el = driver.find_element(By.XPATH, "//select[contains(@id, 'ddlV2V')]")
        sel = Select(select_el)
        
        target_value = 'OI' if view_type == 'oi' else 'IntradayVolume'
        target_label = 'Open Interest' if view_type == 'oi' else 'Intraday Volume'

        # Check if already selected
        if sel.first_selected_option.get_attribute('value') == target_value:
             print(f'[VIEW] Already on {target_label}')
             return True

        # Snapshot chart before triggering postback so we can detect re-render.
        baseline_fp = _chart_fingerprint(driver)

        # Select by value
        sel.select_by_value(target_value)
        print(f'[VIEW] ✅ Selected dropdown option: {target_label} (value={target_value})')

        # Wait for chart re-render (subsumes blind sleep + wait_ready since
        # Highcharts only updates AFTER the ASP.NET postback completes).
        if wait_for_chart_change(driver, baseline_fp, timeout=15) is None:
            print(f'[VIEW] ⚠ Chart did not change after dropdown select (baseline_fp={baseline_fp!r})')

        # Verify header update — tighter poll, generous total budget.
        expected = 'Open Interest' if view_type == 'oi' else 'Volume'
        end_t = time.time() + 5
        hdr = ''
        while time.time() < end_t:
            hdr = extract_header(driver)
            if expected in hdr:
                print(f'[VIEW] Verified header updated to: {hdr}')
                return True
            time.sleep(0.15)

        print(f'[VIEW] ⚠ Header did not update after dropdown select (Got: {hdr})')
        save_debug(driver, f'header_fail_dropdown_{view_type}')
        # Fallthrough to other strategies if verification failed (though unlikely if dropdown worked)

    except Exception as e:
        print(f'[VIEW] Dropdown strategy failed: {e}')

    # Strategy 1: XPath text match (Fallback)
    target_texts = []
    if view_type == 'intraday':
        target_texts = ['Intraday Volume', 'Intraday']
    else:  # 'oi'
        target_texts = ['Open Interest', 'OI']

    xpaths = []
    if view_type == 'oi':
        xpaths = [
            "//a[normalize-space(text())='OI']",
            "//a[normalize-space(text())='Open Interest']",
            "//a[contains(text(), 'Open Interest')]",
            "//*[normalize-space(text())='OI']",
            "//*[normalize-space(text())='Open Interest']",
            "//*[contains(text(), 'Open Interest')]"
        ]
    else: # intraday
        xpaths = [
            "//a[normalize-space(text())='Intraday']",
            "//a[contains(text(), 'Intraday')]",
            "//*[normalize-space(text())='Intraday']"
        ]

    for xpath in xpaths:
        try:
            els = driver.find_elements(By.XPATH, xpath)
            for el in els:
                if el.is_displayed() and len(el.text.strip()) < 30:
                    baseline_fp = _chart_fingerprint(driver)
                    # Try native click first
                    try:
                        el.click()
                        print(f'[VIEW] ✅ Native Click via XPath: "{el.text}" ({xpath})')
                    except:
                        driver.execute_script('arguments[0].click();', el)
                        print(f'[VIEW] ✅ JS Click via XPath: "{el.text}" ({xpath})')

                    # Wait for chart re-render before reading header.
                    if wait_for_chart_change(driver, baseline_fp, timeout=15) is None:
                        print(f'[VIEW] ⚠ Chart did not change after click (baseline_fp={baseline_fp!r})')

                    expected = 'Open Interest' if view_type == 'oi' else 'Volume'
                    end_t = time.time() + 5
                    hdr = ''
                    while time.time() < end_t:
                        hdr = extract_header(driver)
                        if expected in hdr:
                            print(f'[VIEW] Verified header updated to: {hdr}')
                            return True
                        time.sleep(0.15)

                    print(f'[VIEW] ⚠ Header did not update to "{expected}" (Got: {hdr})')
                    save_debug(driver, f'header_fail_{view_type}')
        except Exception as e:
            print(f'[VIEW] XPath click failed for {xpath}: {e}')
            continue
    
    # Save debug info if we failed
    save_debug(driver, f'view_switch_fail_{view_type}')
    return False


# ============================================================
# DATA EXTRACTION
# ============================================================

def extract_chart(driver, min_price=1000):
    """Extract data from all Highcharts charts on the page."""
    wait_for_chart_ready(driver, timeout=10)
    return driver.execute_script("""
        if (typeof Highcharts === 'undefined') return {error: 'No Highcharts'};
        var charts = (Highcharts.charts || []).filter(c => c != null);
        if (!charts.length) return {error: 'No charts'};

        var results = [];
        for (var chart of charts) {
            var info = {
                title: chart.title ? chart.title.textStr : '',
                subtitle: chart.subtitle ? chart.subtitle.textStr : '',
                series: [],
                futurePrice: null
            };
            for (var ser of chart.series) {
                if (!ser.visible) continue;
                var pts = ser.data.map(p => ({
                    x: p.x !== undefined ? p.x : (p.category || 0),
                    y: p.y !== undefined ? p.y : 0
                }));
                info.series.push({name: ser.name || '', type: ser.type || '', data: pts});
            }
            // Extract futures price from xAxis plotLines (vertical reference line)
            var minPrc = arguments[0];
            if (chart.xAxis && chart.xAxis.length > 0) {
                var ax = chart.xAxis[0];
                // Check rendered plotLines
                if (ax.plotLinesAndBands) {
                    for (var pl of ax.plotLinesAndBands) {
                        if (pl.options && pl.options.value && pl.options.value > minPrc) {
                            info.futurePrice = pl.options.value;
                            break;
                        }
                    }
                }
                // Fallback: check options.plotLines config
                if (!info.futurePrice && ax.options && ax.options.plotLines) {
                    for (var pl of ax.options.plotLines) {
                        if (pl.value && pl.value > minPrc) {
                            info.futurePrice = pl.value;
                            break;
                        }
                    }
                }
            }
            results.push(info);
        }
        return {charts: results};
    """, min_price)


def extract_header(driver):
    """Get the header/subtitle text, with HTML tags stripped."""
    raw = driver.execute_script("""
        // Get both Title (contract info) and Subtitle (stats)
        var text = '';
        if (typeof Highcharts !== 'undefined' && Highcharts.charts) {
            var charts = Highcharts.charts.filter(c => c != null);
            for (var c of charts) {
                var parts = [];
                if (c.title && c.title.textStr) {
                    var t = document.createElement('div');
                    t.innerHTML = c.title.textStr;
                    parts.push(t.textContent || t.innerText || '');
                }
                if (c.subtitle && c.subtitle.textStr) {
                    var s = document.createElement('div');
                    s.innerHTML = c.subtitle.textStr;
                    parts.push(s.textContent || s.innerText || '');
                }
                if (parts.length > 0) {
                    return parts.join(' - ');
                }
            }
        }
        // Fallback
        var selectors = ['span[id*="lblHeader"]', '[id*="lblTitle"]', '.highcharts-subtitle'];
        for (var s of selectors) {
            var el = document.querySelector(s);
            if (el && el.textContent.trim().length > 5) return el.textContent.trim();
        }
        return '';
    """) or ''
    # Clean up any remaining whitespace
    return ' '.join(raw.split())


_price_cache = {}  # {asset_id: {'price': ..., 'ts': ...}}

def get_futures_price(asset_id):
    """Fetch futures price from yfinance for any asset (cached 60s)."""
    global _price_cache
    if not HAS_YFINANCE:
        return None
    profile = ASSET_PROFILES[asset_id]
    now = time.time()
    cached = _price_cache.get(asset_id)
    if cached and (now - cached['ts']) < 60:
        return cached['price']
    try:
        ticker = yf.Ticker(profile['yahoo_symbol'])
        price = ticker.fast_info.get('lastPrice') or ticker.fast_info.get('last_price')
        if price and price > profile['min_price']:
            price = round(float(price), 1)
            _price_cache[asset_id] = {'price': price, 'ts': now}
            print(f'[PRICE] {profile["short"]} futures from yfinance: ${price}')
            return price
    except Exception as e:
        print(f'[PRICE] yfinance error ({profile["short"]}): {e}')
    return None


def _backadjust_rollovers(candles, threshold_pct):
    """Detect futures rollover gaps and back-adjust earlier candles to remove them.

    Yahoo's `GC=F` is a front-month future, *unadjusted* — when the
    front contract rolls (e.g. June -> August), the price series shows a large
    overnight gap that isn't a real price move. Standard fix (what TradingView,
    Stooq continuous, etc. do): shift everything before the rollover by the
    gap so the series joins smoothly at the rollover point.

    Walks newest -> oldest. Any open-vs-prior-close gap above `threshold_pct`
    is treated as a rollover. Applying from latest to earliest avoids double
    counting when there are multiple rollovers in the window.
    """
    if len(candles) < 2:
        return 0
    rollovers = []                           # list of (index, gap_value)
    for i in range(1, len(candles)):
        prev_close = candles[i - 1]['close']
        cur_open   = candles[i]['open']
        if prev_close <= 0:
            continue
        gap = cur_open - prev_close
        if abs(gap) / prev_close > threshold_pct:
            rollovers.append((i, gap))
    rollovers.sort(reverse=True)             # apply latest first
    for idx, gap in rollovers:
        for j in range(idx):
            for k in ('open', 'high', 'low', 'close'):
                candles[j][k] = round(candles[j][k] + gap, 2)
    return len(rollovers)


def _fetch_ohlc_candles(symbol, period, interval):
    """Fetch yfinance OHLC and return list of candle dicts, or None on failure."""
    if not HAS_YFINANCE:
        return None
    ticker = yf.Ticker(symbol)
    df = ticker.history(period=period, interval=interval, auto_adjust=False)
    if df is None or df.empty:
        return None
    candles = []
    for ts, row in df.iterrows():
        o, h, l, c = row.get('Open'), row.get('High'), row.get('Low'), row.get('Close')
        if None in (o, h, l, c):
            continue
        try:
            if any(map(lambda x: x != x, (o, h, l, c))):  # NaN check (NaN != NaN)
                continue
        except Exception:
            pass
        # Lightweight Charts wants seconds-since-epoch for intraday bars,
        # 'YYYY-MM-DD' for daily — give it whichever matches the interval.
        if interval.endswith('d') or interval.endswith('wk') or interval.endswith('mo'):
            time_val = ts.strftime('%Y-%m-%d')
        else:
            time_val = int(ts.timestamp())
        candle = {
            'time': time_val,
            'open': round(float(o), 2),
            'high': round(float(h), 2),
            'low':  round(float(l), 2),
            'close': round(float(c), 2),
        }
        vol = row.get('Volume')
        if vol is not None and vol == vol:
            try:
                candle['volume'] = int(vol)
            except Exception:
                pass
        candles.append(candle)
    return candles


def save_ohlc(asset_id, output_dir):
    """Fetch daily + hourly OHLC for the asset's futures, back-adjust rollover gaps,
    and write OHLC.json (1d) + OHLC_1h.json (1h).

    Both files share shape: { asset, symbol, interval, period, generated_at,
                              rollovers_adjusted, candles: [...] }
    """
    if not HAS_YFINANCE:
        print(f'[OHLC] yfinance not installed — skipping {asset_id}')
        return False
    profile = ASSET_PROFILES[asset_id]
    symbol = profile['yahoo_symbol']
    success = False

    # (interval, yfinance period, rollover threshold, output filename)
    jobs = [
        ('1d', '3mo', 0.025, 'OHLC.json'),
        ('1h', '60d', 0.015, 'OHLC_1h.json'),
    ]
    for interval, period, threshold, fname in jobs:
        try:
            candles = _fetch_ohlc_candles(symbol, period, interval)
            if not candles:
                print(f'[OHLC] {profile["short"]} {interval}: no data returned')
                continue
            adjusted = _backadjust_rollovers(candles, threshold)
            payload = {
                'asset': asset_id,
                'symbol': symbol,
                'interval': interval,
                'period': period,
                'generated_at': datetime.now().isoformat(timespec='seconds'),
                'rollovers_adjusted': adjusted,
                'candles': candles,
            }
            out_path = os.path.join(output_dir, fname)
            with open(out_path, 'w', encoding='utf-8') as f:
                json.dump(payload, f, separators=(',', ':'))
            note = f' (back-adjusted {adjusted} rollover{"s" if adjusted != 1 else ""})' if adjusted else ''
            print(f'[OHLC] {profile["short"]} {interval}: wrote {len(candles)} candles{note} -> {fname}')
            success = True
        except Exception as e:
            print(f'[OHLC] {profile["short"]} {interval} error: {e}')
    return success


def chart_to_text(chart_data, header_line, asset_id='gc'):
    """Convert chart data to text format compatible with the dashboard."""
    if not chart_data or 'charts' not in chart_data:
        return None

    # Find the chart with bar/column series (the Vol2Vol chart)
    target = None
    for chart in chart_data['charts']:
        for s in chart['series']:
            if s['type'] in ('column', 'bar'):
                target = chart
                break
        if target:
            break
    if not target and chart_data['charts']:
        target = chart_data['charts'][0]
    if not target:
        return None

    # Append futures price to header (yfinance primary, plotLine fallback)
    future_price = get_futures_price(asset_id)
    if not future_price or future_price <= 0:
        future_price = target.get('futurePrice')
    if future_price and future_price > 0:
        header_line = f"{header_line} FutPrc: {future_price}"

    call_d, put_d, vol_d = {}, {}, {}
    for s in target['series']:
        nm = s['name'].lower()
        if 'call' in nm:
            for p in s['data']:
                call_d[p['x']] = abs(int(p['y'])) if p['y'] else 0
        elif 'put' in nm:
            for p in s['data']:
                put_d[p['x']] = abs(int(p['y'])) if p['y'] else 0
        elif 'vol' in nm and 'settle' in nm:
            for p in s['data']:
                vol_d[p['x']] = p['y'] if p['y'] else 0

    strikes = sorted(set(list(call_d.keys()) + list(put_d.keys())))
    if not strikes:
        return None

    lines = [header_line, 'Strike,Call,Put,Vol Settle']
    for st in strikes:
        lines.append(f'{int(st)},{call_d.get(st,0)},{put_d.get(st,0)},{vol_d.get(st,0)}')
    return '\n'.join(lines)


# ============================================================
# POSITION BIAS ANALYSIS (Vol2Vol -> position map, no trade setup)
# ============================================================

CONTRACT_KEYS = ('current', 'tomorrow', 'friday', 'monthly')
CONTRACT_WEIGHTS = {
    'current': 0.4,
    'tomorrow': 0.2,
    'friday': 0.2,
    'monthly': 0.2,
}
POSITION_BIAS_VERSION = 2

# Strikes shown in the position-bias chart. OI and intraday volume live on very
# different scales, so we rank each axis independently and display the UNION of
# the top strikes from both. This guarantees a tall intraday-volume wall is shown
# even when its resting OI is small (and vice-versa) instead of being dropped by
# an OI-only ranking.
POSITION_MAP_TOP_OI = 18
POSITION_MAP_TOP_VOL = 12


def _to_float(value, default=None):
    try:
        if value is None:
            return default
        if isinstance(value, (int, float)):
            return float(value)
        cleaned = str(value).replace(',', '').strip()
        if cleaned == '':
            return default
        return float(cleaned)
    except (TypeError, ValueError):
        return default


def _to_int(value, default=0):
    num = _to_float(value, None)
    if num is None:
        return default
    return int(round(num))


def _extract_header_number(header, label):
    match = re.search(rf'{re.escape(label)}:\s*([-+]?\d[\d,]*(?:\.\d+)?)', header, re.I)
    return _to_float(match.group(1), None) if match else None


def _safe_div(numerator, denominator, default=0.0):
    if not denominator:
        return default
    return numerator / denominator


def _clamp(value, low, high):
    return max(low, min(high, value))


def _round_or_none(value, digits=2):
    if value is None:
        return None
    return round(float(value), digits)


def parse_vol2vol_file(path):
    """Parse one dashboard-compatible Vol2Vol text file."""
    if not path or not os.path.isfile(path):
        return None

    with open(path, encoding='utf-8') as f:
        raw = f.read().strip()
    if not raw:
        return None

    lines = [line.strip() for line in raw.splitlines() if line.strip()]
    if len(lines) < 2:
        return None

    header = ' '.join(lines[0].split())
    reader = csv.DictReader(io.StringIO('\n'.join(lines[1:])))
    strikes = []
    for row in reader:
        strike = _to_float(row.get('Strike'), None)
        if strike is None:
            continue
        strikes.append({
            'strike': strike,
            'call': _to_int(row.get('Call')),
            'put': _to_int(row.get('Put')),
            'vol_settle': _to_float(row.get('Vol Settle'), 0.0) or 0.0,
        })

    option_symbol = None
    symbol_match = re.search(r'Option Symbol:\s*([A-Z0-9]+)', header, re.I)
    if symbol_match:
        option_symbol = symbol_match.group(1)

    dte = None
    dte_match = re.search(r'\(([\d.]+)\s*DTE\)', header, re.I)
    if dte_match:
        dte = _to_float(dte_match.group(1), None)

    data_type = 'intraday' if 'Intraday Volume' in header else 'open_interest'
    total_put = _extract_header_number(header, 'Put')
    total_call = _extract_header_number(header, 'Call')

    return {
        'path': path,
        'header': header,
        'data_type': data_type,
        'contract': option_symbol,
        'dte': dte,
        'future_price': _extract_header_number(header, 'FutPrc'),
        'future_change': _extract_header_number(header, 'Future Chg'),
        'vol': _extract_header_number(header, 'Vol'),
        'vol_change': _extract_header_number(header, 'Vol Chg'),
        'total_put': _to_int(total_put, sum(s['put'] for s in strikes)),
        'total_call': _to_int(total_call, sum(s['call'] for s in strikes)),
        'strikes': strikes,
    }


def _distance_payload(strike, price):
    if strike is None or price is None:
        return {'points': None, 'pct': None, 'side': 'unknown'}
    points = strike - price
    if abs(points) < 1e-9:
        side = 'at_price'
    elif points > 0:
        side = 'above'
    else:
        side = 'below'
    return {
        'points': round(points, 2),
        'pct': round(_safe_div(points, price) * 100, 3) if price else None,
        'side': side,
    }


def _level_payload(row, price, oi_key, intraday_by_strike=None):
    if not row:
        return None
    strike = row['strike']
    intraday = (intraday_by_strike or {}).get(strike, {})
    call_oi = row.get('call', 0)
    put_oi = row.get('put', 0)
    total_oi = call_oi + put_oi
    call_vol = intraday.get('call', 0)
    put_vol = intraday.get('put', 0)
    total_vol = call_vol + put_vol
    if call_oi > put_oi * 1.25:
        side = 'call_wall'
    elif put_oi > call_oi * 1.25:
        side = 'put_wall'
    else:
        side = 'mixed'
    return {
        'strike': _round_or_none(strike, 2),
        'side': side,
        oi_key: total_oi,
        'call_oi': call_oi,
        'put_oi': put_oi,
        'net_call_minus_put': call_oi - put_oi,
        'intraday_volume': total_vol,
        'call_volume': call_vol,
        'put_volume': put_vol,
        'activity_vs_oi': round(_safe_div(total_vol, total_oi), 4) if total_oi else None,
        'distance': _distance_payload(strike, price),
    }


def _best(rows, key, predicate=None):
    candidates = [r for r in rows if (predicate(r) if predicate else True) and r.get(key, 0) > 0]
    if not candidates:
        return None
    return max(candidates, key=lambda r: r.get(key, 0))


def _nearest(rows, key, price, side):
    if price is None:
        return None
    if side == 'above':
        candidates = [r for r in rows if r['strike'] > price and r.get(key, 0) > 0]
        return min(candidates, key=lambda r: r['strike'] - price) if candidates else None
    candidates = [r for r in rows if r['strike'] < price and r.get(key, 0) > 0]
    return min(candidates, key=lambda r: price - r['strike']) if candidates else None


def _bias_label(score):
    if score >= 35:
        return 'strong_bullish'
    if score >= 12:
        return 'bullish'
    if score <= -35:
        return 'strong_bearish'
    if score <= -12:
        return 'bearish'
    return 'neutral'


def _confidence_label(analysis):
    total_oi = analysis['totals']['open_interest']
    if total_oi <= 0:
        return 'low'
    concentration = analysis['structure'].get('top5_oi_share') or 0
    wall_gap = abs((analysis['walls'].get('dominant_call') or {}).get('call_oi', 0) -
                   (analysis['walls'].get('dominant_put') or {}).get('put_oi', 0))
    wall_gap_share = _safe_div(wall_gap, total_oi)
    if concentration >= 0.35 or wall_gap_share >= 0.12:
        return 'high'
    if concentration >= 0.20 or wall_gap_share >= 0.06:
        return 'medium'
    return 'low'


def analyze_contract_position(asset_id, contract_key, oi_data, intraday_data=None):
    """Build a position map and directional market bias from one contract's Vol2Vol data."""
    if not oi_data or not oi_data.get('strikes'):
        return None

    price = oi_data.get('future_price') or (intraday_data or {}).get('future_price')
    oi_rows = sorted(oi_data['strikes'], key=lambda r: r['strike'])
    intraday_by_strike = {
        r['strike']: r
        for r in (intraday_data or {}).get('strikes', [])
    }

    total_call_oi = oi_data.get('total_call') or sum(r['call'] for r in oi_rows)
    total_put_oi = oi_data.get('total_put') or sum(r['put'] for r in oi_rows)
    total_oi = total_call_oi + total_put_oi
    total_call_vol = (intraday_data or {}).get('total_call') or sum(r.get('call', 0) for r in intraday_by_strike.values())
    total_put_vol = (intraday_data or {}).get('total_put') or sum(r.get('put', 0) for r in intraday_by_strike.values())
    total_vol = total_call_vol + total_put_vol

    dominant_call = _best(oi_rows, 'call')
    dominant_put = _best(oi_rows, 'put')
    max_position = _best(
        [{'strike': r['strike'], 'call': r['call'], 'put': r['put'], 'total': r['call'] + r['put']} for r in oi_rows],
        'total'
    )
    nearest_call_above = _nearest(oi_rows, 'call', price, 'above')
    nearest_put_below = _nearest(oi_rows, 'put', price, 'below')
    strongest_call_above = _best(oi_rows, 'call', lambda r: price is not None and r['strike'] > price)
    strongest_put_below = _best(oi_rows, 'put', lambda r: price is not None and r['strike'] < price)

    # Build the displayed strike set from the UNION of the strongest OI strikes
    # and the strongest intraday-volume strikes. Ranking each axis separately (and
    # unioning) keeps big intraday flow walls visible even when their OI is small —
    # a single combined sort would let large OI swamp them off the chart.
    candidates = {r['strike']: dict(r) for r in oi_rows}
    for strike, ir in intraday_by_strike.items():
        row = candidates.setdefault(strike, {'strike': strike, 'call': 0, 'put': 0})
        row['call_vol'] = ir.get('call', 0)
        row['put_vol'] = ir.get('put', 0)
    candidate_rows = list(candidates.values())

    def _oi_strength(r):
        return r.get('call', 0) + r.get('put', 0)

    def _vol_strength(r):
        return r.get('call_vol', 0) + r.get('put_vol', 0)

    top_by_oi = sorted(candidate_rows, key=_oi_strength, reverse=True)[:POSITION_MAP_TOP_OI]
    top_by_vol = sorted(candidate_rows, key=_vol_strength, reverse=True)[:POSITION_MAP_TOP_VOL]
    keep_strikes = {r['strike'] for r in top_by_oi if _oi_strength(r) > 0}
    keep_strikes |= {r['strike'] for r in top_by_vol if _vol_strength(r) > 0}
    levels = sorted(
        (r for r in candidate_rows if r['strike'] in keep_strikes),
        key=lambda r: r['strike']
    )

    top5_oi = sum(_oi_strength(r) for r in top_by_oi[:5])
    support_oi = sum(r['put'] for r in oi_rows if price is not None and r['strike'] < price)
    resistance_oi = sum(r['call'] for r in oi_rows if price is not None and r['strike'] > price)
    call_vol_above = sum(r.get('call', 0) for s, r in intraday_by_strike.items() if price is not None and s > price)
    put_vol_below = sum(r.get('put', 0) for s, r in intraday_by_strike.items() if price is not None and s < price)

    score = 0.0
    drivers = []

    if support_oi or resistance_oi:
        pressure_score = _clamp(_safe_div(support_oi - resistance_oi, support_oi + resistance_oi) * 38, -38, 38)
        score += pressure_score
        drivers.append({
            'name': 'position_pressure',
            'score': round(pressure_score, 2),
            'detail': 'put OI below price as support vs call OI above price as resistance',
        })

    if max_position and price:
        magnet_dist = max_position['strike'] - price
        magnet_score = _clamp(_safe_div(magnet_dist, price) * 1000, -14, 14)
        score += magnet_score
        drivers.append({
            'name': 'largest_position_magnet',
            'score': round(magnet_score, 2),
            'detail': f'largest combined OI at {max_position["strike"]:g}',
        })

    pcr = _safe_div(total_put_oi, total_call_oi, None)
    if pcr is not None:
        if pcr >= 1.25:
            pcr_score = -8
        elif pcr <= 0.80:
            pcr_score = 8
        else:
            pcr_score = 0
        score += pcr_score
        drivers.append({
            'name': 'oi_put_call_ratio',
            'score': pcr_score,
            'detail': f'OI P/C {pcr:.2f}',
        })

    if total_vol:
        flow_score = _clamp(_safe_div(call_vol_above - put_vol_below, total_vol) * 30, -18, 18)
        score += flow_score
        drivers.append({
            'name': 'intraday_flow_location',
            'score': round(flow_score, 2),
            'detail': 'call volume above price vs put volume below price',
        })

    if price and dominant_call and price > dominant_call['strike']:
        breakout_score = min(18, _safe_div(dominant_call['call'], total_oi) * 90)
        score += breakout_score
        drivers.append({
            'name': 'above_dominant_call_wall',
            'score': round(breakout_score, 2),
            'detail': f'price is above dominant call wall {dominant_call["strike"]:g}',
        })
    if price and dominant_put and price < dominant_put['strike']:
        breakdown_score = -min(18, _safe_div(dominant_put['put'], total_oi) * 90)
        score += breakdown_score
        drivers.append({
            'name': 'below_dominant_put_wall',
            'score': round(breakdown_score, 2),
            'detail': f'price is below dominant put wall {dominant_put["strike"]:g}',
        })

    score = round(_clamp(score, -100, 100), 2)
    analysis = {
        'version': POSITION_BIAS_VERSION,
        'asset': ASSET_PROFILES[asset_id]['short'],
        'contract_key': contract_key,
        'contract': oi_data.get('contract') or (intraday_data or {}).get('contract'),
        'dte': oi_data.get('dte') if oi_data.get('dte') is not None else (intraday_data or {}).get('dte'),
        'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
        'future_price': _round_or_none(price, 2),
        'position_bias': {
            'score': score,
            'label': _bias_label(score),
            'drivers': drivers,
        },
        'totals': {
            'open_interest': total_oi,
            'call_oi': total_call_oi,
            'put_oi': total_put_oi,
            'oi_put_call_ratio': round(pcr, 3) if pcr is not None else None,
            'intraday_volume': total_vol,
            'call_volume': total_call_vol,
            'put_volume': total_put_vol,
            'volume_put_call_ratio': round(_safe_div(total_put_vol, total_call_vol), 3) if total_call_vol else None,
            'volume_vs_oi': round(_safe_div(total_vol, total_oi), 4) if total_oi else None,
        },
        'structure': {
            'support_oi_below_price': support_oi,
            'resistance_oi_above_price': resistance_oi,
            'top5_oi_share': round(_safe_div(top5_oi, total_oi), 4) if total_oi else None,
            'call_volume_above_price': call_vol_above,
            'put_volume_below_price': put_vol_below,
        },
        'walls': {
            'dominant_call': _level_payload(dominant_call, price, 'total_oi', intraday_by_strike),
            'dominant_put': _level_payload(dominant_put, price, 'total_oi', intraday_by_strike),
            'largest_combined_position': _level_payload(max_position, price, 'total_oi', intraday_by_strike),
            'nearest_call_above': _level_payload(nearest_call_above, price, 'total_oi', intraday_by_strike),
            'nearest_put_below': _level_payload(nearest_put_below, price, 'total_oi', intraday_by_strike),
            'strongest_call_above': _level_payload(strongest_call_above, price, 'total_oi', intraday_by_strike),
            'strongest_put_below': _level_payload(strongest_put_below, price, 'total_oi', intraday_by_strike),
        },
        'position_map': [_level_payload(row, price, 'total_oi', intraday_by_strike) for row in levels],
        'note': 'Position-bias read only. No entry, stop, target, or trade setup is produced.',
    }
    analysis['confidence'] = _confidence_label(analysis)
    return analysis


def build_asset_position_bias(asset_id):
    """Generate per-contract and aggregate position bias JSON files for an asset."""
    out_dir = get_output_dir(asset_id)
    os.makedirs(out_dir, exist_ok=True)

    contract_analyses = []
    for key in CONTRACT_KEYS:
        oi_path = os.path.join(out_dir, f'{key}_OIData.txt')
        intraday_path = os.path.join(out_dir, f'{key}_IntradayData.txt')
        oi_data = parse_vol2vol_file(oi_path)
        intraday_data = parse_vol2vol_file(intraday_path)
        analysis = analyze_contract_position(asset_id, key, oi_data, intraday_data)
        if not analysis:
            print(f'[BIAS] {ASSET_PROFILES[asset_id]["short"]}/{key}: no OI data, skipped')
            continue

        out_path = os.path.join(out_dir, f'{key}_PositionBias.json')
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(analysis, f, indent=2, ensure_ascii=False)
            f.write('\n')
        print(f'[BIAS] Saved {os.path.basename(out_path)} ({analysis["position_bias"]["label"]}, score={analysis["position_bias"]["score"]})')
        contract_analyses.append(analysis)

    if not contract_analyses:
        return None

    seen_contracts = set()
    weighted = []
    for item in contract_analyses:
        identity = item.get('contract') or item['contract_key']
        if identity in seen_contracts:
            continue
        seen_contracts.add(identity)
        weighted.append((item, CONTRACT_WEIGHTS.get(item['contract_key'], 0.2)))

    weight_sum = sum(w for _, w in weighted) or 1
    aggregate_score = round(sum(item['position_bias']['score'] * w for item, w in weighted) / weight_sum, 2)
    summary = {
        'version': POSITION_BIAS_VERSION,
        'asset': ASSET_PROFILES[asset_id]['short'],
        'asset_name': ASSET_PROFILES[asset_id]['name'],
        'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
        'position_bias': {
            'score': aggregate_score,
            'label': _bias_label(aggregate_score),
            'method': 'weighted unique contract position bias',
        },
        'contracts': [
            {
                'contract_key': item['contract_key'],
                'contract': item.get('contract'),
                'dte': item.get('dte'),
                'future_price': item.get('future_price'),
                'score': item['position_bias']['score'],
                'label': item['position_bias']['label'],
                'confidence': item.get('confidence'),
                'dominant_call_wall': (item['walls'].get('dominant_call') or {}).get('strike'),
                'dominant_put_wall': (item['walls'].get('dominant_put') or {}).get('strike'),
                'largest_position': (item['walls'].get('largest_combined_position') or {}).get('strike'),
            }
            for item in contract_analyses
        ],
        'note': 'Aggregates Vol2Vol position placement only; this intentionally excludes trade setup fields.',
    }

    summary_path = os.path.join(out_dir, 'position_bias_summary.json')
    with open(summary_path, 'w', encoding='utf-8') as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(f'[BIAS] Saved {os.path.basename(summary_path)} ({summary["position_bias"]["label"]}, score={aggregate_score})')
    return summary


# ============================================================
# SCRAPING
# ============================================================

def scrape_view(driver, view_type, prefix, header_prefix='', skip_switch=False, output_dir=None, asset_id='gc'):
    """Scrape one view and save to file."""
    out_dir = output_dir or get_output_dir(asset_id)
    min_price = ASSET_PROFILES[asset_id]['min_price']
    suffix = 'IntradayData' if view_type == 'intraday' else 'OIData'
    label = 'Intraday Volume' if view_type == 'intraday' else 'Open Interest'

    if not skip_switch and not switch_to_view(driver, view_type):
        print(f'[SCRAPE] ❌ Failed to switch to {view_type}')
        # Continue anyway, might be on correct page

    # Extract
    chart_data = extract_chart(driver, min_price=min_price)
    header_line = extract_header(driver)

    if header_prefix:
        header_line = f"{header_prefix} - {header_line}"

    if isinstance(chart_data, dict) and 'error' in chart_data:
        print(f'[SCRAPE] Chart error ({view_type}): {chart_data["error"]}')
        return None

    # header = extract_header(driver) or f'Gold (OG|GC) - {label}' # Original line
    # text = chart_to_text(chart, header) # Original line
    text = chart_to_text(chart_data, header_line, asset_id=asset_id)
    if not text:
        print(f'[SCRAPE] No data for {view_type}')
        return None

    filepath = os.path.join(out_dir, f'{prefix}_{suffix}.txt')
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(text)

    nlines = len(text.strip().split('\n'))
    print(f'[SAVE] ✅ {os.path.basename(filepath)} ({nlines} lines, {len(text)} bytes)')
    return filepath


_CLICK_HELPERS_JS = """
function _directText(el) {
    let t = '';
    for (const n of el.childNodes) {
        if (n.nodeType === 3) t += n.textContent;
    }
    return t.trim();
}
function _norm(s) { return (s || '').toLowerCase().replace(/\\s+/g, ' ').trim(); }
function _clickClosestClickable(el) {
    let t = el;
    while (t && t !== document.body) {
        if (t.tagName === 'A' || t.onclick ||
            (t.getAttribute && (t.getAttribute('onclick') || t.getAttribute('href')))) {
            t.click();
            return 'clicked:' + t.tagName;
        }
        t = t.parentElement;
    }
    el.click();
    return 'clicked:leaf';
}
"""


def _click_qs_top_tab(driver, label):
    """
    Click a QuikStrike top-nav tab by visible label (e.g. 'Open Interest').
    QuikStrike top tabs often live in markup like
        <td><span>OPEN</span><br/><span>INTEREST</span></td>
    so textContent collapses to 'OPENINTEREST' with no spaces. We strip
    ALL whitespace from both target and candidate before comparing.
    """
    js = _CLICK_HELPERS_JS + """
        const stripAll = s => (s || '').toLowerCase().replace(/\\s+/g, '');
        const target = stripAll(arguments[0]);

        // Strategy A: prefer <a> tags so the ASP.NET postback fires reliably
        const anchors = Array.from(document.querySelectorAll('a'));
        for (const a of anchors) {
            if (!a.offsetParent) continue;
            if (stripAll(a.textContent) === target) { a.click(); return 'A'; }
        }
        // Strategy B: any visible element whose total text matches
        const all = Array.from(document.querySelectorAll('a, span, td, th, button, li, div'));
        for (const el of all) {
            if (!el.offsetParent) continue;
            if (stripAll(el.textContent) === target) return _clickClosestClickable(el);
        }
        return null;
    """
    return driver.execute_script(js, label)


def _click_sidebar_heatmap_oi(driver):
    """
    On the Open Interest page, click 'OI' under the 'Heatmap' sidebar.

    Primary strategy: find an <a> whose href/onclick attribute mentions
    'heatmap' AND whose visible text is 'OI'. This is much more specific
    than text-only matching — anchors that target the heatmap landing
    page are uniquely identifiable by their handler.

    Fallback: DOM-order proximity to a 'Heatmap' section header.
    """
    js = _CLICK_HELPERS_JS + """
        function _describe(el) {
            return {
                tag: el.tagName,
                text: (el.textContent || '').trim().slice(0, 40),
                href: (el.getAttribute && el.getAttribute('href')) || '',
                onclick: ((el.getAttribute && el.getAttribute('onclick')) || '').slice(0, 100),
                id: el.id || '',
                cls: (el.className && typeof el.className === 'string') ? el.className.slice(0, 60) : ''
            };
        }

        // STRATEGY 1: href/onclick contains 'heatmap' AND text is 'OI'
        const anchors = Array.from(document.querySelectorAll('a'));
        const heatmapAnchors = anchors.filter(a => {
            if (!a.offsetParent) return false;
            const href = (a.getAttribute('href') || '').toLowerCase();
            const oc = (a.getAttribute('onclick') || '').toLowerCase();
            return href.includes('heatmap') || oc.includes('heatmap');
        });
        const oiHeatmap = heatmapAnchors.find(a => (a.textContent || '').trim() === 'OI');
        if (oiHeatmap) {
            oiHeatmap.click();
            return {ok: true, via: 'href-heatmap', clicked: _describe(oiHeatmap)};
        }

        // STRATEGY 2: DOM-order proximity to 'Heatmap' section header
        const SECTIONS = ['charts','reports','heatmap','history','futures'];
        const all = Array.from(document.querySelectorAll('*')).filter(el => el.offsetParent !== null);
        const sectionAnchors = [];
        all.forEach((el, idx) => {
            const direct = _norm(_directText(el));
            if (SECTIONS.includes(direct)) {
                sectionAnchors.push({el: el, name: direct, index: idx});
            }
        });
        const heatmapHeaders = sectionAnchors.filter(a => a.name === 'heatmap');
        const oiCandidates = all.filter(el => _norm(_directText(el)) === 'oi');

        if (heatmapHeaders.length === 0 || oiCandidates.length === 0) {
            return {
                ok: false,
                error: 'no-anchors',
                heatmapHeaders: heatmapHeaders.length,
                oiCandidates: oiCandidates.length,
                sections: sectionAnchors.map(a => a.name),
                heatmapAnchorsWithHref: heatmapAnchors.length
            };
        }
        const heatmapAnchor = heatmapHeaders[heatmapHeaders.length - 1];
        const nextSection = sectionAnchors.find(a => a.index > heatmapAnchor.index);
        const nextIndex = nextSection ? nextSection.index : Infinity;

        for (const c of oiCandidates) {
            const idx = all.indexOf(c);
            if (idx > heatmapAnchor.index && idx < nextIndex) {
                const res = _clickClosestClickable(c);
                return {ok: true, via: 'dom-order', clicked: _describe(c), result: res};
            }
        }
        return {ok: false, error: 'no-oi-after-heatmap', oiCandidates: oiCandidates.map(_describe).slice(0, 5)};
    """
    return driver.execute_script(js)


def _dump_sidebar_diagnostics(driver):
    """Return a structured snapshot of sidebar-ish links for debugging."""
    return driver.execute_script("""
        const items = [];
        Array.from(document.querySelectorAll('a, span, div, td')).forEach(el => {
            if (!el.offsetParent) return;
            let direct = '';
            for (const n of el.childNodes) if (n.nodeType === 3) direct += n.textContent;
            direct = direct.trim();
            if (!direct || direct.length > 30) return;
            const href = el.getAttribute && el.getAttribute('href');
            const onclick = el.getAttribute && el.getAttribute('onclick');
            if (el.tagName === 'A' || href || onclick ||
                ['Charts','Reports','Heatmap','History','Futures','OI','OI Change','Volume','Summary','Most Actives','Settlements'].includes(direct)) {
                items.push({tag: el.tagName, text: direct, href: href || '', onclick: onclick ? onclick.slice(0, 80) : ''});
            }
        });
        return items.slice(0, 60);
    """)


def _click_heatmap_expiration_tab(driver, contract_text):
    """
    Click an expiration tab (e.g. 'OGM6') on the OI Matrix page.

    The default view after the sidebar click is the 'PRODUCT' tab — its
    table has futures-contract columns, not date columns. We MUST click
    an individual expiration tab to get the strike × date heatmap.

    These tabs are ASP.NET LinkButtons that emit __doPostBack — so we
    filter <a> tags whose href contains __doPostBack to avoid clicking
    a non-interactive label that just happens to share the text.
    """
    js = _CLICK_HELPERS_JS + """
        const target = arguments[0];
        const anchors = Array.from(document.querySelectorAll('a'));
        const visExact = anchors.filter(a =>
            a.offsetParent && (a.textContent || '').trim() === target
        );

        if (!visExact.length) {
            // Diagnostic: any anchor whose text contains the symbol
            const partial = anchors.filter(a =>
                a.offsetParent && (a.textContent || '').includes(target)
            ).slice(0, 8).map(a => ({
                text: (a.textContent || '').trim().slice(0, 40),
                href: (a.getAttribute('href') || '').slice(0, 120),
                id: a.id || ''
            }));
            return {ok: false, error: 'no-exact-anchor', partial: partial};
        }

        // Prefer anchors with __doPostBack href, then ones whose id mentions
        // an expiration control name (lbExpiration / Expirations / Tab).
        visExact.sort((a, b) => {
            const ah = (a.getAttribute('href') || '');
            const bh = (b.getAttribute('href') || '');
            const aPost = ah.includes('__doPostBack') ? 0 : 1;
            const bPost = bh.includes('__doPostBack') ? 0 : 1;
            if (aPost !== bPost) return aPost - bPost;
            const aTab = /Expirat|Tab/i.test(a.id || '') ? 0 : 1;
            const bTab = /Expirat|Tab/i.test(b.id || '') ? 0 : 1;
            return aTab - bTab;
        });

        const target_a = visExact[0];
        target_a.click();
        return {
            ok: true,
            via: 'a-postback',
            clicked: {
                text: (target_a.textContent || '').trim(),
                href: (target_a.getAttribute('href') || '').slice(0, 120),
                id: target_a.id || ''
            },
            siblingCount: visExact.length
        };
    """
    return driver.execute_script(js, contract_text)


def _ensure_call_put_combined(driver):
    """
    On the Heatmap → OI page, make sure the 'Call/Put Combined' checkbox
    is checked. When unchecked, QuikStrike renders each date header as a
    colspan=2 cell with two sub-columns (C, P) under it, which breaks the
    by-date-index extraction in _extract_heatmap_table and ends up reading
    only the Put column.

    Returns a small dict {ok, action, ...} describing what was done.
    Triggers the ASP.NET postback if the checkbox state changed.
    """
    return driver.execute_script("""
        // Find a checkbox whose nearby label text contains 'Call/Put Combined'
        const boxes = Array.from(document.querySelectorAll('input[type=checkbox]'));
        function labelText(cb) {
            // Try <label for=id>
            if (cb.id) {
                const lab = document.querySelector('label[for="' + cb.id + '"]');
                if (lab) return (lab.textContent || '').trim();
            }
            // Try parent label, then next sibling text
            const p = cb.closest('label');
            if (p) return (p.textContent || '').trim();
            const sib = cb.nextSibling;
            if (sib && sib.textContent) return sib.textContent.trim();
            // Walk up a couple levels and grab text
            let n = cb.parentElement;
            for (let i = 0; i < 3 && n; i++) {
                const t = (n.textContent || '').trim();
                if (t) return t.slice(0, 120);
                n = n.parentElement;
            }
            return '';
        }
        const target = boxes.find(cb => /call\\s*\\/?\\s*put\\s+combined/i.test(labelText(cb)));
        if (!target) {
            return {ok: false, error: 'checkbox-not-found',
                    candidates: boxes.slice(0, 8).map(cb => ({id: cb.id, name: cb.name, label: labelText(cb).slice(0, 80), checked: cb.checked}))};
        }
        if (target.checked) {
            return {ok: true, action: 'already-checked', id: target.id, name: target.name};
        }
        target.click();
        return {ok: true, action: 'clicked', id: target.id, name: target.name, nowChecked: target.checked};
    """)


def _set_heatmap_strike_window(driver, strike_window):
    """
    On the Heatmap → OI page, set the visible strike window around ATM.

    QuikStrike exposes this as a simple <select> whose values represent the
    number of strikes above and below ATM to render. For example, value 25
    yields 51 total strike rows.
    """
    return driver.execute_script("""
        const targetValue = arguments[0];
        const selects = Array.from(document.querySelectorAll('select')).filter(sel => {
            if (sel.offsetParent === null) return false;
            const id = sel.id || '';
            const name = sel.name || '';
            return id.includes('ddlStrikes') || name.includes('ddlStrikes');
        });

        if (!selects.length) {
            return {ok: false, error: 'strike-select-not-found'};
        }

        const target = selects[0];
        const options = Array.from(target.options).map(opt => ({
            value: opt.value,
            text: (opt.textContent || '').trim()
        }));
        if (!options.some(opt => opt.value === targetValue)) {
            return {ok: false, error: 'strike-option-not-found', current: target.value, options: options};
        }
        if (target.value === targetValue) {
            return {ok: true, action: 'already-selected', value: target.value};
        }

        target.value = targetValue;
        if (typeof target.onchange === 'function') {
            target.onchange();
        } else {
            target.dispatchEvent(new Event('change', {bubbles: true}));
        }
        return {ok: true, action: 'changed', value: target.value};
    """, strike_window)


def _set_heatmap_greek(driver, greek_label):
    """
    On the Heatmap → OI page, set the 'Greek:' dropdown by visible option label.

    Match is case-insensitive substring on each option's trimmed text — so
    'Gamma (1 Pct)' matches the QuikStrike option '* Gamma (1 Pct)'. Pass
    'None' to revert the table to plain open-interest counts.

    Triggers the ASP.NET postback if the selection changed.
    """
    return driver.execute_script("""
        const target = (arguments[0] || '').trim().toLowerCase();
        if (!target) return {ok: false, error: 'no-target'};

        const selects = Array.from(document.querySelectorAll('select')).filter(sel => {
            if (sel.offsetParent === null) return false;
            const id = (sel.id || '').toLowerCase();
            const name = (sel.name || '').toLowerCase();
            return id.includes('greek') || name.includes('greek');
        });
        if (!selects.length) {
            return {ok: false, error: 'greek-select-not-found'};
        }

        const dd = selects[0];
        const options = Array.from(dd.options).map(opt => ({
            value: opt.value,
            text: (opt.textContent || '').trim()
        }));
        const match = options.find(opt => opt.text.toLowerCase().includes(target));
        if (!match) {
            return {ok: false, error: 'greek-option-not-found', target: target, options: options};
        }
        if (dd.value === match.value) {
            return {ok: true, action: 'already-selected', value: dd.value, text: match.text};
        }
        dd.value = match.value;
        if (typeof dd.onchange === 'function') {
            dd.onchange();
        } else {
            dd.dispatchEvent(new Event('change', {bubbles: true}));
        }
        return {ok: true, action: 'changed', value: dd.value, text: match.text};
    """, greek_label)


def _extract_heatmap_table(driver):
    """
    Find the strike × column heatmap/matrix table on the page and extract it.

    Two layouts are handled:

    1. PRODUCT (matrix) view — strike × expiration. Each header cell looks
       like ``<span>CODE<br><span>N</span> DTE</span>`` (e.g. "G3MK6" plus
       inner span "0" plus " DTE"). textContent collapses these with no
       separator ("G3MK60 DTE"), so we parse the DOM directly: the inner
       <span>'s text is the DTE digit, the outer <span>'s leading text
       node is the option code.

    2. Single-expiration view — strike × historical day. Header cells are
       just dates like ``5/15/2026`` — match the standard date pattern.

    Data rows often have a strike cell with ``colspan=2`` while header
    cells don't, so we expand both rows to a visual-column layout to
    align them correctly.

    On failure returns ``{error, tables: [...summary...]}`` for diagnosis.
    """
    return driver.execute_script("""
        const dateRe = /^\\s*\\d{1,2}[\\/\\-]\\d{1,2}([\\/\\-]\\d{2,4})?\\s*$/;

        // For matrix header cells: detect by inner <span> with digit text
        // and trailing ' DTE'. Returns {code, dte} or null.
        function parseMatrixHeader(cell) {
            const innerSpan = cell.querySelector('span > span');
            if (!innerSpan) return null;
            const dte = (innerSpan.textContent || '').trim();
            if (!/^\\d+$/.test(dte)) return null;
            const outer = innerSpan.parentNode;
            if (!outer) return null;
            // The cell text must end with ' DTE' for this to be a
            // matrix-style header cell (vs. just any nested span).
            const full = (outer.textContent || '').trim();
            if (!/\\bDTE\\s*$/i.test(full)) return null;
            // Option code = text nodes of `outer` BEFORE the inner span.
            let code = '';
            for (const node of outer.childNodes) {
                if (node === innerSpan) break;
                if (node.nodeType === 3) code += node.textContent || '';
                else if (node.nodeType === 1 && node !== innerSpan) {
                    code += node.textContent || '';
                }
            }
            return {code: code.trim(), dte: dte};
        }

        // Expand a row to one entry per VISUAL column (handles colspan).
        // Each entry: {cell, text, isLeader} — only the first visual
        // column for a colspanned cell has isLeader=true.
        function expandRow(row) {
            const out = [];
            for (const cell of row.cells) {
                const span = parseInt(cell.getAttribute('colspan') || '1', 10);
                const text = (cell.textContent || '').trim();
                for (let i = 0; i < span; i++) {
                    out.push({cell: cell, text: text, isLeader: i === 0});
                }
            }
            return out;
        }

        const allTables = Array.from(document.querySelectorAll('table'))
            .filter(t => t.offsetParent !== null && t.rows && t.rows.length > 2);

        // For each candidate table, find the best header row.
        // Header row = the row with the highest count of date-pattern OR
        // matrix-pattern cells. Tie-broken in favor of matrix (since the
        // matrix view is what the user actually wants when present).
        function findHeaderRow(table) {
            const limit = Math.min(5, table.rows.length);
            let best = null;
            for (let i = 0; i < limit; i++) {
                const expanded = expandRow(table.rows[i]);
                let dateCount = 0;
                let matrixCount = 0;
                const labels = new Array(expanded.length).fill(null);
                for (let v = 0; v < expanded.length; v++) {
                    const e = expanded[v];
                    if (!e.isLeader) continue;
                    if (dateRe.test(e.text)) {
                        dateCount++;
                        labels[v] = {kind: 'date', label: e.text.trim()};
                        continue;
                    }
                    const m = parseMatrixHeader(e.cell);
                    if (m) {
                        matrixCount++;
                        labels[v] = {kind: 'matrix', label: m.code + ' ' + m.dte + ' DTE'};
                    }
                }
                const kind = matrixCount >= dateCount ? 'matrix' : 'date';
                const count = Math.max(matrixCount, dateCount);
                if (count < 3) continue;
                if (!best || count > best.count) {
                    best = {idx: i, expanded: expanded, count: count, kind: kind, labels: labels};
                }
            }
            return best;
        }

        const summary = [];
        let best = null, bestHeader = null, bestScore = 0;
        for (const t of allTables) {
            const hdr = findHeaderRow(t);
            const sample = (r) => Array.from(r.cells).map(c => (c.textContent || '').trim()).slice(0, 8);
            summary.push({
                rows: t.rows.length,
                cols: t.rows[0].cells.length,
                headerIdx: hdr ? hdr.idx : -1,
                colCount: hdr ? hdr.count : 0,
                kind: hdr ? hdr.kind : '',
                row0: sample(t.rows[0]),
                row1: t.rows.length > 1 ? sample(t.rows[1]) : [],
                row2: t.rows.length > 2 ? sample(t.rows[2]) : [],
                id: t.id || '',
                cls: (typeof t.className === 'string') ? t.className.slice(0, 50) : ''
            });
            if (hdr) {
                const score = hdr.count * t.rows.length;
                if (score > bestScore) { bestScore = score; best = t; bestHeader = hdr; }
            }
        }

        if (!best) {
            return {error: 'No table with date/DTE headers', tables: summary.slice(0, 10)};
        }

        // Collect the visual-column indices of the data columns from the
        // header row's leader cells that produced a label.
        const dataCols = [];   // [{visualIdx, label}]
        bestHeader.labels.forEach((info, v) => {
            if (info) {
                if (bestHeader.kind === 'matrix' && info.kind !== 'matrix') return;
                if (bestHeader.kind === 'date' && info.kind !== 'date') return;
                dataCols.push({visualIdx: v, label: info.label});
            }
        });

        const rows = Array.from(best.rows);
        const dataStart = bestHeader.idx + 1;
        const firstDataVIdx = dataCols[0].visualIdx;

        const strikes = [];
        for (let r = dataStart; r < rows.length; r++) {
            const dataExp = expandRow(rows[r]);
            if (!dataExp.length) continue;
            // Find strike: first leader cell with a parseable number,
            // BEFORE the first data column.
            let strike = null;
            for (let v = 0; v < firstDataVIdx && v < dataExp.length; v++) {
                if (!dataExp[v].isLeader) continue;
                const t = (dataExp[v].text || '').replace(/[, ]/g, '').trim();
                const n = parseFloat(t);
                if (Number.isFinite(n)) { strike = n; break; }
            }
            if (strike === null) continue;
            const values = [];
            for (const dc of dataCols) {
                const entry = dataExp[dc.visualIdx];
                if (!entry) { values.push(null); continue; }
                const t = (entry.text || '').replace(/[, ]/g, '').trim();
                const n = parseFloat(t);
                values.push(Number.isFinite(n) ? n : null);
            }
            strikes.push({strike: strike, values: values});
        }

        return {
            dates: dataCols.map(d => d.label),
            strikes: strikes,
            headerRowIdx: bestHeader.idx,
            kind: bestHeader.kind
        };
    """)


def scrape_oi_heatmap_phase(driver, classified, asset_id, output_dir):
    """
    After Vol2Vol scraping is done, navigate to 'Open Interest → Heatmap → OI'
    and for each classified contract (current / tomorrow / friday / monthly)
    extract two strike × historical-day heatmaps:

      {prefix}_OIHeatmap.json    — Greek = None, raw OI counts
      {prefix}_GammaHeatmap.json — Greek = Gamma (1 Pct), gamma-weighted OI

    Both are call+put combined. The Greek-change postback can un-check
    'Call/Put Combined', so it's re-asserted before every extract. The
    Greek dropdown is reverted to None at the end of each contract so the
    next contract's OI extract reads raw OI counts.

    Non-fatal throughout — a failure on one step skips the rest cleanly.
    """
    contracts = [(k, classified.get(k)) for k in CONTRACT_KEYS]
    contracts = [(k, c) for k, c in contracts if c and c.get('text')]
    if not contracts:
        print('[HEATMAP] No classified contracts — skipping historical heatmap phase')
        # Still try the matrix-view Gamma scrape below since it doesn't need
        # individual expirations.

    print(f'\n{"═"*60}')
    print(f'  OI HEATMAP PHASE: {asset_id.upper()}')
    print(f'{"═"*60}')

    from selenium.webdriver.common.keys import Keys
    try:
        driver.find_element(By.TAG_NAME, 'body').send_keys(Keys.ESCAPE)
        time.sleep(0.2)
    except Exception:
        pass

    # 1. Click 'OPEN INTEREST' top tab
    print('[HEATMAP] Clicking OPEN INTEREST top tab...')
    res = _click_qs_top_tab(driver, 'Open Interest')
    if not res:
        print('[HEATMAP] ⚠ Could not click OPEN INTEREST top tab')
        save_debug(driver, f'heatmap_topnav_fail_{asset_id}', output_dir=output_dir)
        return
    print(f'[HEATMAP] Top-tab click: {res}')
    time.sleep(4.0)
    try:
        wait_ready(driver, timeout=20)
    except Exception:
        pass
    time.sleep(1.0)

    # 2. Click 'OI' under Heatmap sidebar
    print('[HEATMAP] Clicking Heatmap → OI in sidebar...')
    res = _click_sidebar_heatmap_oi(driver)
    if not res or not res.get('ok'):
        print(f'[HEATMAP] ⚠ Could not click Heatmap → OI: {res}')
        try:
            items = _dump_sidebar_diagnostics(driver) or []
            print(f'[HEATMAP] === Sidebar diagnostics ({len(items)} items) ===')
            for it in items:
                print(f'  [{it.get("tag")}] "{it.get("text")}" href={it.get("href")!r} onclick={it.get("onclick")!r}')
        except Exception as ee:
            print(f'[HEATMAP] diagnostics dump failed: {ee}')
        save_debug(driver, f'heatmap_sidebar_fail_{asset_id}', output_dir=output_dir)
        return
    clicked = res.get('clicked', {})
    print(f'[HEATMAP] Sidebar click ({res.get("via")}): tag={clicked.get("tag")} '
          f'text={clicked.get("text")!r} href={clicked.get("href")!r} '
          f'onclick={clicked.get("onclick")!r}')
    time.sleep(2.0)
    try:
        wait_ready(driver, timeout=15)
    except Exception:
        pass
    time.sleep(1.0)

    # 2b. Ensure 'Call/Put Combined' checkbox is checked.
    print('[HEATMAP] Ensuring Call/Put Combined checkbox is checked...')
    try:
        cb_res = _ensure_call_put_combined(driver)
        print(f'[HEATMAP] Call/Put Combined: {cb_res}')
        if cb_res and cb_res.get('action') == 'clicked':
            time.sleep(2.5)
            try:
                wait_ready(driver, timeout=15)
            except Exception:
                pass
            time.sleep(0.5)
    except Exception as e:
        print(f'[HEATMAP] ⚠ Call/Put Combined toggle raised: {e}')

    underlying = get_futures_price(asset_id)

    # 3. Per-contract historical OI heatmap (strike × historical day).
    #    These feed the OI Heatmap tab and the Conviction tab.
    for prefix, contract in contracts:
        contract_text = contract.get('text', '')
        print(f'\n[HEATMAP] {prefix}: selecting expiration {contract_text}...')

        res = _click_heatmap_expiration_tab(driver, contract_text)
        if not res or not res.get('ok'):
            print(f'[HEATMAP] ⚠ Could not select expiration {contract_text}: {res}')
            if res and res.get('partial'):
                print(f'[HEATMAP]   Partial-match anchors ({len(res["partial"])}):')
                for p in res['partial']:
                    print(f'    text={p.get("text")!r} href={p.get("href")!r} id={p.get("id")!r}')
            save_debug(driver, f'heatmap_exp_fail_{prefix}', output_dir=output_dir)
            continue
        c = res.get('clicked', {})
        print(f'[HEATMAP] Expiration click: text={c.get("text")!r} '
              f'href={c.get("href")!r} id={c.get("id")!r} '
              f'siblings={res.get("siblingCount")}')

        time.sleep(2.0)
        try:
            wait_ready(driver, timeout=15)
        except Exception:
            pass
        time.sleep(1.0)

        # Monthly heatmap covers a much wider strike range than weeklies/dailies,
        # so ±50 clips the wings. Use 'All' (-1) for monthly; default for the rest.
        strike_target = '-1' if prefix == 'monthly' else HEATMAP_STRIKE_WINDOW
        strike_label = 'All' if strike_target == '-1' else f'±{strike_target}'
        print(f'[HEATMAP] Ensuring strike window is set to {strike_label}...')
        try:
            strike_res = _set_heatmap_strike_window(driver, strike_target)
            print(f'[HEATMAP] Strike window: {strike_res}')
            if strike_res and strike_res.get('action') == 'changed':
                time.sleep(2.5)
                try:
                    wait_ready(driver, timeout=15)
                except Exception:
                    pass
                time.sleep(0.5)
        except Exception as e:
            print(f'[HEATMAP] ⚠ Strike window change raised: {e}')

        data = _extract_heatmap_table(driver)
        if not data or 'error' in data:
            print(f'[HEATMAP] ⚠ Extract failed for {prefix}: {data.get("error") if data else "no-data"}')
            if data and data.get('tables'):
                print(f'[HEATMAP] === Tables on page ({len(data["tables"])}) ===')
                for ti, ts in enumerate(data['tables']):
                    print(f'  table[{ti}] rows={ts.get("rows")} cols={ts.get("cols")} '
                          f'headerIdx={ts.get("headerIdx")} cols={ts.get("dateCols")} '
                          f'id={ts.get("id")!r} cls={ts.get("cls")!r}')
                    print(f'    row0={ts.get("row0")}')
                    print(f'    row1={ts.get("row1")}')
                    print(f'    row2={ts.get("row2")}')
            save_debug(driver, f'heatmap_extract_fail_{prefix}', output_dir=output_dir)
            continue

        payload = {
            'asset': asset_id,
            'prefix': prefix,
            'contract': contract_text,
            'header': extract_header(driver) or '',
            'underlying': underlying,
            'kind': data.get('kind'),
            'dates': data['dates'],
            'strikes': data['strikes'],
            'scrapedAt': datetime.now(timezone.utc).isoformat(),
        }
        filepath = os.path.join(output_dir, f'{prefix}_OIHeatmap.json')
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(payload, f, indent=2)
        print(f'[HEATMAP] ✅ Saved {prefix}_OIHeatmap.json '
              f'({len(data["dates"])} cols × {len(data["strikes"])} strikes, kind={data.get("kind")})')

        # Same expiration, switch Greek → Gamma (1 Pct) and re-extract.
        # The Greek-change postback can un-check Call/Put Combined, so we
        # wait for the page to settle then re-assert the checkbox before
        # extracting. Revert Greek to None for the next contract's OI run.
        print(f'[HEATMAP] {prefix}: switching Greek → Gamma (1 Pct)...')
        gamma_ok = False
        try:
            greek_res = _set_heatmap_greek(driver, 'Gamma (1 Pct)')
            print(f'[HEATMAP] Greek: {greek_res}')
            if greek_res and greek_res.get('ok'):
                if greek_res.get('action') == 'changed':
                    time.sleep(3.5)
                    try:
                        wait_ready(driver, timeout=20)
                    except Exception:
                        pass
                    time.sleep(1.0)
                gamma_ok = True
        except Exception as e:
            print(f'[HEATMAP] ⚠ Greek switch raised: {e}')

        if gamma_ok:
            try:
                cb2 = _ensure_call_put_combined(driver)
                print(f'[HEATMAP] Call/Put Combined (post-Greek): {cb2}')
                if cb2 and cb2.get('action') == 'clicked':
                    time.sleep(3.0)
                    try:
                        wait_ready(driver, timeout=20)
                    except Exception:
                        pass
                    time.sleep(0.5)
            except Exception as e:
                print(f'[HEATMAP] ⚠ Call/Put Combined re-assert raised: {e}')

            gdata = _extract_heatmap_table(driver)
            if not gdata or 'error' in gdata:
                print(f'[HEATMAP] ⚠ Gamma extract failed for {prefix}: '
                      f'{gdata.get("error") if gdata else "no-data"}')
                save_debug(driver, f'heatmap_gamma_extract_fail_{prefix}', output_dir=output_dir)
            else:
                gpayload = {
                    'asset': asset_id,
                    'prefix': prefix,
                    'contract': contract_text,
                    'header': extract_header(driver) or '',
                    'underlying': underlying,
                    'greek': 'Gamma (1 Pct)',
                    'kind': gdata.get('kind'),
                    'dates': gdata['dates'],
                    'strikes': gdata['strikes'],
                    'scrapedAt': datetime.now(timezone.utc).isoformat(),
                }
                gpath = os.path.join(output_dir, f'{prefix}_GammaHeatmap.json')
                with open(gpath, 'w', encoding='utf-8') as f:
                    json.dump(gpayload, f, indent=2)
                print(f'[HEATMAP] ✅ Saved {prefix}_GammaHeatmap.json '
                      f'({len(gdata["dates"])} cols × {len(gdata["strikes"])} strikes, '
                      f'kind={gdata.get("kind")})')

            # Revert Greek back to None for the next contract.
            try:
                back = _set_heatmap_greek(driver, 'None')
                if back and back.get('action') == 'changed':
                    time.sleep(2.5)
                    try:
                        wait_ready(driver, timeout=20)
                    except Exception:
                        pass
                    time.sleep(0.3)
                    try:
                        cb3 = _ensure_call_put_combined(driver)
                        if cb3 and cb3.get('action') == 'clicked':
                            time.sleep(2.5)
                            try:
                                wait_ready(driver, timeout=20)
                            except Exception:
                                pass
                            time.sleep(0.3)
                    except Exception:
                        pass
            except Exception as e:
                print(f'[HEATMAP] ⚠ Greek revert raised: {e}')

    # Restore Vol2Vol view so the next asset's Vol2Vol scrape doesn't break.
    # QuikStrike preserves the active top tab across URL reloads, and the
    # Vol2Vol page's ddlV2V dropdown only exists on the QuikOptions Vol2Vol
    # tab — leaving us on Open Interest breaks the next asset.
    print('[HEATMAP] Restoring QuikOptions Vol2Vol top tab...')
    try:
        back = _click_qs_top_tab(driver, 'QuikOptions Vol2Vol')
        if not back:
            back = _click_qs_top_tab(driver, 'Vol2Vol')
        print(f'[HEATMAP] Vol2Vol restore: {back}')
        time.sleep(2.0)
        try:
            wait_ready(driver, timeout=15)
        except Exception:
            pass
    except Exception as e:
        print(f'[HEATMAP] ⚠ Vol2Vol restore raised: {e}')


def scrape_contract(driver, contract, prefix, output_dir=None, asset_id='gc'):
    """
    Scrape both Intraday + OI for one contract.

    IMPORTANT: After selecting a contract, Vol2Vol defaults to Intraday Volume.
    So we scrape Intraday FIRST (no extra click), then switch to OI.
    """
    dte_str = f'{contract["dte"]:.1f} DTE' if contract.get('dte') else ''
    print(f'\n{"═"*60}')
    print(f'  {prefix.upper()}: {contract["text"]}  {dte_str}')
    print(f'{"═"*60}')

    # Select contract (this reloads page to default Intraday view)
    if not select_contract(driver, contract):
        return False

    results = {}

    # Pass contract text (DTE info) to header
    # Prefer the full title attribute which has "Contract: ... (DTE) ..."
    contract_text = contract.get('title', '')
    if not contract_text or 'DTE' not in contract_text:
        contract_text = contract.get('text', '') or contract.get('value', 'Unknown')
        if contract.get('dte'):
             contract_text += f" ({contract.get('dte'):.2f} DTE)"
    
    contract_text = contract_text.replace('\n', ' ').strip()

    # 1. Intraday Volume (Default view usually)
    print(f'[SCRAPE] Explicitly switching to Intraday Volume...')
    path = scrape_view(driver, 'intraday', prefix, header_prefix=contract_text, skip_switch=False, output_dir=output_dir, asset_id=asset_id)
    if path:
        results['intraday'] = path

    # 2. Open Interest
    print(f'[SCRAPE] Switching to Open Interest...')
    path = scrape_view(driver, 'oi', prefix, header_prefix=contract_text, output_dir=output_dir, asset_id=asset_id)
    if path:
        results['oi'] = path

    return bool(results)





# ============================================================
# ERROR DETECTION & PRODUCT DISCOVERY
# ============================================================

def is_error_page(driver):
    """Check if the current page is a QuikStrike error page."""
    try:
        url = driver.current_url or ''
        title = driver.title or ''
        if 'Error/ErrorPage' in url or 'ErrorPage' in url:
            return True
        if 'error' in title.lower() and 'quikstrike' in title.lower():
            return True
    except:
        pass
    return False


def discover_product_pid(driver, asset_id):
    """
    Try to discover the correct QuikStrike product ID for an asset.
    
    Strategy 1: Navigate to the QuikStrike dashboard and scan all links
    for product references with pid= parameters.
    Strategy 2: Try common PIDs and check page content for product name.
    """
    profile = ASSET_PROFILES[asset_id]
    short = profile['short']  # e.g. 'GC'
    pf = profile['pf']

    print(f'[DISCOVER] Searching for {short} product ID...')

    # Strategy 1: Go to QuikStrike dashboard (no pid) and scan for product links
    try:
        driver.get('https://cmegroup-sso.quikstrike.net/User/QuikStrikeView.aspx')
        time.sleep(5)

        # Scan all links for pid= in href and product code in text
        found = driver.execute_script(r"""
            var code = arguments[0];
            var result = [];
            document.querySelectorAll('a').forEach(function(a) {
                var href = a.href || '';
                var text = (a.textContent || '').trim();
                var pidMatch = href.match(/pid=(\d+)/);
                if (pidMatch && text.length < 80) {
                    result.push({text: text.substring(0, 80), pid: parseInt(pidMatch[1]), href: href.substring(0, 200)});
                }
            });
            document.querySelectorAll('select option').forEach(function(opt) {
                var text = (opt.textContent || '').trim();
                var val = opt.value || '';
                if (text.toUpperCase().indexOf(code) >= 0 || val.toUpperCase().indexOf(code) >= 0) {
                    result.push({text: text.substring(0, 80), pid: null, href: val});
                }
            });
            return result;
        """, short)

        if found:
            print(f'[DISCOVER] Found {len(found)} links on dashboard:')
            for item in found[:10]:
                print(f'  pid={item["pid"]} text="{item["text"]}"')

            # Filter for links containing our product code
            matching = [f for f in found if f['pid'] and short.upper() in f['text'].upper()]
            if matching:
                pid = matching[0]['pid']
                print(f'[DISCOVER] Matched {short} -> pid={pid} ("{matching[0]["text"]}")')
                return pid

    except Exception as e:
        print(f'[DISCOVER] Dashboard scan failed: {e}')

    # Strategy 2: Try common QuikStrike product IDs and check page content
    candidate_pids = [39, 41, 42, 43, 44, 45, 50, 55, 58, 100, 134, 23, 25, 30, 35]
    print(f'[DISCOVER] Trying {len(candidate_pids)} candidate PIDs...')

    for pid in candidate_pids:
        try:
            test_url = f'https://cmegroup-sso.quikstrike.net/User/QuikStrikeView.aspx?pid={pid}&pf={pf}'
            driver.get(test_url)
            time.sleep(3)

            if is_error_page(driver):
                continue

            # Check if this page mentions our product
            body_preview = driver.execute_script(
                'return (document.body.innerText || "").substring(0, 1000).toUpperCase()'
            ) or ''

            # Look for product code in page content (e.g. "GOLD" or "(GC)")
            name_parts = profile['name'].upper().split('(')[0].strip().split()
            if f'({short.upper()})' in body_preview or f'|{short.upper()}' in body_preview or \
               any(part in body_preview for part in name_parts if len(part) > 3):
                print(f'[DISCOVER] Found {short} at pid={pid}!')
                return pid
            else:
                snippet = body_preview[:80].replace('\n', ' ')
                print(f'[DISCOVER] pid={pid} -> not {short} ({snippet}...)')

        except Exception as e:
            print(f'[DISCOVER] pid={pid} error: {e}')
            continue

    print(f'[DISCOVER] Could not find {short} in any tested pid.')
    print(f'[DISCOVER] To fix manually: open QuikStrike in browser, navigate to {short} Vol2Vol,')
    print(f'[DISCOVER] check the URL for ?pid=XX and update ASSET_PROFILES["{asset_id}"]["pid"] in this file.')
    return None


# ============================================================
# SCRAPE ASSET
# ============================================================

def scrape_asset(driver, asset_id):
    """Scrape all contracts for one asset. Returns True if any data was scraped."""
    profile = ASSET_PROFILES[asset_id]
    output_dir = get_output_dir(asset_id)
    os.makedirs(output_dir, exist_ok=True)

    print(f'\n{"="*60}')
    print(f'  SCRAPING: {profile["name"]}')
    print(f'  Output: {output_dir}')
    print(f'{"="*60}\n')

    # Navigate to asset's QuikStrike page
    url = get_quikstrike_url(asset_id)
    if url is None:
        print(f'[NAV] No known pid for {profile["short"]} — trying to discover...')
        discovered_pid = discover_product_pid(driver, asset_id)
        if discovered_pid:
            profile['pid'] = discovered_pid
            url = get_quikstrike_url(asset_id)
        else:
            print(f'[NAV] Could not discover pid for {profile["short"]}. Skipping.')
            print(f'[NAV] To fix: open QuikStrike in your browser, navigate to {profile["short"]} Vol2Vol,')
            print(f'[NAV] check the URL for ?pid=XX and update ASSET_PROFILES in quikstrike_scraper.py')
            return False

    print(f'[NAV] Loading {profile["short"]} page: {url}')
    driver.get(url)
    time.sleep(2)

    # Check for QuikStrike error page
    if is_error_page(driver):
        print(f'[NAV] QuikStrike error page — pid={profile["pid"]} is wrong for {profile["short"]}')
        print(f'[NAV] Trying to discover the correct pid...')
        discovered_pid = discover_product_pid(driver, asset_id)
        if discovered_pid:
            profile['pid'] = discovered_pid
            url = get_quikstrike_url(asset_id)
            print(f'[NAV] Retrying with pid={discovered_pid}...')
            driver.get(url)
            time.sleep(5)
            if is_error_page(driver):
                print(f'[NAV] Still error. Skipping {profile["short"]}.')
                return False
        else:
            print(f'[NAV] Could not discover pid. Skipping {profile["short"]}.')
            print(f'[NAV] To fix: open QuikStrike, go to {profile["short"]} Vol2Vol, check URL for ?pid=XX')
            return False

    wait_ready(driver)
    time.sleep(1)

    # Debug current state (skipped for performance)
    # page_info = debug_page(driver, f'{profile["short"]} PAGE')

    # Get contracts
    contracts = get_expiration_contracts(driver, profile)

    if not contracts:
        print(f'[WARN] No contracts found for {profile["short"]}.')
        save_debug(driver, f'no_contracts_{asset_id}', output_dir=output_dir)

        # Fallback: scrape whatever is currently shown
        print('[FALLBACK] Scraping current view...')
        scrape_view(driver, 'intraday', 'current', skip_switch=True, output_dir=output_dir, asset_id=asset_id)
        scrape_view(driver, 'oi', 'current', output_dir=output_dir, asset_id=asset_id)
        build_asset_position_bias(asset_id)
        save_ohlc(asset_id, output_dir)
        return True

    # Classify
    classified = classify_contracts(contracts, profile)

    # Guard: if the listing is incomplete (near contracts not yet published,
    # common overnight/early-morning) `current` points at a far contract. Skip
    # the overwrite so the last-good per-contract files are preserved rather
    # than replaced with the wrong day's data. Price data (OHLC) is independent
    # of contract selection, so it is still refreshed.
    incomplete = current_pick_looks_incomplete(classified, output_dir)
    if incomplete:
        print(f'[GUARD] Skipping {profile["short"]} contract write — {incomplete}')
        print('[GUARD] Keeping last-good contract data files untouched.')
        save_debug(driver, f'guard_incomplete_{asset_id}', output_dir=output_dir)

        # ── Slot promotion ──
        # When the saved current contract has already expired (its expiration
        # date is before the CME trading date), the "tomorrow" file from the
        # last successful scrape IS today's current contract.  Promote the
        # saved slots forward: tomorrow → current, friday → tomorrow so the
        # dashboard shows the correct day without needing daily contracts
        # from QuikStrike (which are absent after market close).
        old_exp = _saved_current_exp(output_dir)
        today = _today_ny()
        if old_exp is not None and old_exp < today:
            print(f'[PROMOTE] Saved current expired ({old_exp} < {today}) — promoting slots')
            _promote_slots(output_dir)

        save_ohlc(asset_id, output_dir)
        return True

    print(f'\n[PLAN] {profile["short"]} contract assignments:')
    for k in CONTRACT_KEYS:
        c = classified.get(k)
        if c:
            print(f'  OK {k}: {c.get("text", c.get("value", "?"))}')
        else:
            print(f'  -- {k}: NOT FOUND')

    # Scrape each contract type
    for key in CONTRACT_KEYS:
        c = classified.get(key)

        if key == 'friday' and classified.get('friday_is_current'):
            print(f'\n[SKIP] friday: same as current contract ({c.get("text")})')
            import shutil
            try:
                shutil.copy(os.path.join(output_dir, 'current_IntradayData.txt'), os.path.join(output_dir, 'friday_IntradayData.txt'))
                shutil.copy(os.path.join(output_dir, 'current_OIData.txt'), os.path.join(output_dir, 'friday_OIData.txt'))
                print('[COPY] Copied current data to friday files')
            except Exception as e:
                print(f'[WARN] Could not copy current to friday: {e}')
            continue

        if c:
            scrape_contract(driver, c, key, output_dir=output_dir, asset_id=asset_id)
        else:
            print(f'\n[SKIP] {key}: no contract')

    # OI Heatmap phase — one navigation, all three contracts
    try:
        scrape_oi_heatmap_phase(driver, classified, asset_id, output_dir)
        # Matrix view writes one file per asset (not per contract), so the
        # old friday==current mirror is no longer needed.
    except Exception as e:
        print(f'[HEATMAP] ⚠ Phase raised: {e}')
        import traceback
        traceback.print_exc()

    build_asset_position_bias(asset_id)
    save_ohlc(asset_id, output_dir)
    return True


# ============================================================
# MAIN
# ============================================================

def main():
    # Parse CLI args
    import argparse
    parser = argparse.ArgumentParser(description='QuikStrike Vol2Vol Scraper v4 — GC only')
    parser.add_argument('--asset', choices=['gc', 'all'], default='all',
                        help='Which asset to scrape (default: all = gc)')
    parser.add_argument('--analyze-only', action='store_true',
                        help='Build position-bias JSON from existing data files without opening QuikStrike')
    args = parser.parse_args()

    if args.asset == 'all':
        assets = ASSETS_TO_SCRAPE
    else:
        assets = [args.asset]

    if args.analyze_only:
        print('='*60)
        print('  Vol2Vol Position Bias Analysis')
        print('='*60)
        for asset_id in assets:
            build_asset_position_bias(asset_id)
            save_ohlc(asset_id, get_output_dir(asset_id))
        return

    print('='*60)
    print('  QuikStrike Vol2Vol Scraper v4 — Multi-Asset')
    print('='*60)
    print(f'  Assets: {", ".join(ASSET_PROFILES[a]["name"] for a in assets)}')
    if CME_EMAIL:
        print(f'  Email: {CME_EMAIL}')
    else:
        print('  Warning: No CME_EMAIL — manual login will be required')
    print()

    driver = create_driver()

    try:
        # Login with the first asset's URL (we'll navigate to others later)
        first_url = get_quikstrike_url(assets[0])
        if not login_cme(driver, first_url, max_wait=120):
            print('[ERROR] Could not reach QuikStrike.')
            save_debug(driver, 'login_fail')
            return

        wait_ready(driver)
        time.sleep(1)

        # Scrape each asset
        for asset_id in assets:
            try:
                scrape_asset(driver, asset_id)
            except Exception as e:
                print(f'\n[ERROR] Failed to scrape {asset_id}: {e}')
                import traceback
                traceback.print_exc()
                save_debug(driver, f'error_{asset_id}', output_dir=get_output_dir(asset_id))

        # Done
        print(f'\n{"="*60}')
        print('  SCRAPING COMPLETE')
        print(f'{"="*60}')

        for asset_id in assets:
            out_dir = get_output_dir(asset_id)
            data_files = [f for f in os.listdir(out_dir)
                          if (f.endswith('.txt') or f.endswith('.json')) and 'debug' not in f]
            if data_files:
                print(f'\n  {ASSET_PROFILES[asset_id]["name"]} files:')
                for f in sorted(data_files):
                    fp = os.path.join(out_dir, f)
                    lines = len(open(fp, encoding='utf-8').readlines())
                    size = os.path.getsize(fp)
                    print(f'    {f} ({lines} lines, {size:,} bytes)')

        # Push data
        push_data_to_repo(assets)

    except Exception as e:
        print(f'\n[ERROR] {e}')
        import traceback
        traceback.print_exc()
        save_debug(driver, 'error')

    finally:
        driver.quit()
        print('[CLEANUP] Chrome closed.')


def push_data_to_repo(assets=None):
    """Copy data files to atas-data repo and push to GitHub."""
    if not os.path.isdir(DATA_REPO_DIR):
        print(f'[PUSH] Data repo not found at {DATA_REPO_DIR} — skipping push')
        return

    assets = assets or ASSETS_TO_SCRAPE
    total_copied = 0

    for asset_id in assets:
        profile = ASSET_PROFILES[asset_id]
        src_dir = get_output_dir(asset_id)
        # Destination mirrors the source structure: data/ for GC
        if profile['data_subfolder']:
            dst_dir = os.path.join(DATA_REPO_DIR, profile['data_subfolder'])
        else:
            dst_dir = DATA_REPO_DIR
        os.makedirs(dst_dir, exist_ok=True)

        data_files = [f for f in os.listdir(src_dir)
                      if (f.endswith('.txt') or f.endswith('.json')) and 'debug' not in f]
        if not data_files:
            print(f'[PUSH] No data files for {profile["short"]}')
            continue

        print(f'\n[PUSH] Syncing {profile["short"]} data ({len(data_files)} files)...')
        for f in data_files:
            src = os.path.join(src_dir, f)
            dst = os.path.join(dst_dir, f)
            shutil.copy2(src, dst)
            print(f'[PUSH] Copied: {profile["short"]}/{f}')
            total_copied += 1

    if total_copied == 0:
        print('[PUSH] No data files to push')
        return

    try:
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M')
        asset_names = ', '.join(ASSET_PROFILES[a]['short'] for a in assets)
        subprocess.run(['git', 'add', '-A'], cwd=DATA_REPO_DIR, check=True,
                       capture_output=True, text=True)

        # Check if there are changes to commit
        result = subprocess.run(['git', 'diff', '--cached', '--quiet'],
                                cwd=DATA_REPO_DIR, capture_output=True)
        if result.returncode == 0:
            print('[PUSH] No changes to push (data unchanged)')
            return

        subprocess.run(['git', 'commit', '-m', f'data update ({asset_names}) {timestamp}'],
                       cwd=DATA_REPO_DIR, check=True, capture_output=True, text=True)
        subprocess.run(['git', 'push', 'origin', 'main'],
                       cwd=DATA_REPO_DIR, check=True, capture_output=True, text=True)
        print(f'[PUSH] Pushed {total_copied} files to atas-data repo')
    except subprocess.CalledProcessError as e:
        print(f'[PUSH] Git error: {e}')
        if e.stderr:
            print(f'[PUSH] {e.stderr.strip()}')
    except Exception as e:
        print(f'[PUSH] Error: {e}')


if __name__ == '__main__':
    main()
