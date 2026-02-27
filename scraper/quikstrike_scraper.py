# QuikStrike Vol2Vol Scraper v4 — Multi-Asset (GC + NQ)
# Scrapes options Vol2Vol data from CME QuikStrike
#
# Supports:
#   - GC (Gold)  : pid=40, pf=6
#   - NQ (Nasdaq): pid=54, pf=6
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
from datetime import datetime
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
    'nq': {
        'name': 'Nasdaq (NQ)',
        'short': 'NQ',
        'pid': 54,
        'pf': 6,
        'yahoo_symbol': 'NQ=F',
        'min_price': 5000,          # NQ futures price > 5000
        'data_subfolder': 'nq',     # data/nq/
        # Contract symbol patterns for NQ (from screenshot):
        #   NQH6   = quarterly  (NQ + month_letter + year)
        #   NEG6   = EOM        (NE + month_letter + year)
        #   QN1H6  = friday     (QN + digit + month + year)
        #   Q1AH6  = monday     (Q + digit + A = Mon, B = Tue, C = Wed, D = Thu)
        #   QN3H6  = 3rd friday etc.
        'contract_pattern': r'^(NQ|NE|QN|Q[0-9])',
        'monthly_check': lambda sym: (
            # NQH6 = quarterly (NQ + letter + digit)
            (len(sym) >= 4 and sym[:2] == 'NQ' and sym[2].isalpha()) or
            # NEG6 = EOM (NE + letter + digit)
            (len(sym) >= 4 and sym[:2] == 'NE' and sym[2].isalpha())
        ),
        'friday_check': lambda sym: (
            # QN1H6 = friday (QN + digit + letter + digit)
            len(sym) >= 5 and sym[:2] == 'QN' and sym[2].isdigit()
        ),
    },
}

# ============================================================
# CONFIG
# ============================================================
CME_EMAIL = os.environ.get('CME_EMAIL', '')
CME_PASSWORD = os.environ.get('CME_PASSWORD', '')
BASE_OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
DATA_REPO_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'atas-data')

# Which assets to scrape (can be overridden via CLI args)
# Default: scrape both GC and NQ
ASSETS_TO_SCRAPE = ['gc', 'nq']

def get_quikstrike_url(asset_id):
    """Build QuikStrike URL for a given asset."""
    p = ASSET_PROFILES[asset_id]
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
    driver.implicitly_wait(5)
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
    time.sleep(4)

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
            time.sleep(3)
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
            time.sleep(3)
            continue

        # Unknown — wait
        time.sleep(3)

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
                time.sleep(1)
                
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
            time.sleep(3)
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
                time.sleep(3)
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
    time.sleep(2)


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
            var txt = a.textContent.replace(/\s+/g,' ').trim().split(' ')[0];
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
            var txt = a.textContent.replace(/\s+/g,' ').trim().split(' ')[0];
            if (contractPattern.test(txt) && txt.length < 15) {
                var title = a.title || '';
                var dte = null;
                var match = title.match(/([\d.]+)\s*DTE/i);
                if (match) dte = parseFloat(match[1]);
                if (!result.find(c => c.text === txt)) {
                    result.push({text: txt, id: id, title: title, dte: dte});
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
                    time.sleep(2)
                    print(f'[EXPIRY] Clicked: {sel}')
                    break
            except:
                continue
        
        popup2 = driver.execute_script("""
            var result = [];
            var contractPattern = new RegExp(arguments[0]);
            document.querySelectorAll('a[id*="lbExpiration"]').forEach(function(a) {
                var id = a.id || '';
                var txt = a.textContent.replace(/\s+/g,' ').trim().split(' ')[0];
                if (contractPattern.test(txt) && txt.length < 15) {
                    var title = a.title || '';
                    var dte = null;
                    var match = title.match(/([\d.]+)\s*DTE/i);
                    if (match) dte = parseFloat(match[1]);
                    if (!result.find(c => c.text === txt)) {
                        result.push({text: txt, id: id, title: title, dte: dte});
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
        time.sleep(0.5)
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
                    time.sleep(2)
                    break
            except:
                continue

    # Strategy 1: Click by exact ID (most reliable)
    if contract_id:
        try:
            el = driver.find_element(By.ID, contract_id)
            driver.execute_script('arguments[0].click();', el)
            print(f'[SELECT] ✅ Clicked: {contract_text} (by ID)')
            wait_ready(driver, timeout=10)
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
                driver.execute_script('arguments[0].click();', link)
                print(f'[SELECT] ✅ Clicked: {contract_text} (by text+ID)')
                wait_ready(driver, timeout=10)
                return True
            except Exception as e:
                print(f'[SELECT] Click failed: {e}')

    # Strategy 3: Any link with matching text
    for link in links:
        if link.text.strip() == contract_text:
            try:
                driver.execute_script('arguments[0].click();', link)
                print(f'[SELECT] ✅ Clicked: {contract_text} (fallback)')
                wait_ready(driver, timeout=10)
                return True
            except:
                continue

    print(f'[SELECT] ❌ Not found: {contract_text}')
    return False


# ============================================================
# CONTRACT CLASSIFICATION
# ============================================================

def classify_contracts(contracts, asset_profile):
    """
    Classify contracts into current/friday/monthly using asset-specific symbol patterns + DTE.
    
    Rules:
      current = lowest DTE overall (nearest expiry, could be Daily, Friday, or Monthly)
      friday  = lowest DTE Friday contract
      monthly = lowest DTE Monthly contract
    """
    monthly_check = asset_profile['monthly_check']
    friday_check = asset_profile['friday_check']
    result = {'current': None, 'friday': None, 'monthly': None, 'friday_is_current': False}

    # Sort by DTE
    with_dte = [c for c in contracts if c.get('dte') is not None]
    sorted_c = sorted(with_dte, key=lambda c: c['dte'])

    if not sorted_c:
        print('[CLASSIFY] No DTE data — using first contracts')
        if len(contracts) >= 1: result['current'] = contracts[0]
        if len(contracts) >= 2: result['friday'] = contracts[1]
        if len(contracts) >= 3: result['monthly'] = contracts[2]
        return result

    # Current = lowest DTE overall (could be Daily, Friday, or Monthly)
    result['current'] = sorted_c[0]

    # Separate Friday vs Monthly based on symbol pattern
    fridays = [c for c in sorted_c if friday_check(c['text'])]
    monthlies = [c for c in sorted_c if monthly_check(c['text'])]

    print(f'[CLASSIFY] Found {len(fridays)} Friday and {len(monthlies)} Monthly contracts')

    if fridays: result['friday'] = fridays[0]
    if monthlies: result['monthly'] = monthlies[0]

    # LOGGING
    print(f'[CLASSIFY] Current candidate: {result["current"].get("text", "?") if result["current"] else "None"} (DTE={result["current"].get("dte") if result["current"] else "?"})')
    print(f'[CLASSIFY] Friday candidate:  {result["friday"].get("text", "?") if result["friday"] else "None"} (DTE={result["friday"].get("dte") if result["friday"] else "?"})')
    print(f'[CLASSIFY] Monthly candidate: {result["monthly"].get("text", "?") if result["monthly"] else "None"} (DTE={result["monthly"].get("dte") if result["monthly"] else "?"})')

    # Check for overlap: if current and friday are the same contract
    if result['current'] and result['friday']:
        if result['current']['text'] == result['friday']['text']:
            result['friday_is_current'] = True
            print(f'[CLASSIFY] Note: Current contract is also the Friday contract ({result["current"]["text"]})')

    return result


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
        time.sleep(0.5)
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

        # Select by value
        sel.select_by_value(target_value)
        print(f'[VIEW] ✅ Selected dropdown option: {target_label} (value={target_value})')
        
        # Wait for ASP.NET Postback
        time.sleep(1)
        wait_ready(driver)
        
        # Verify header update
        expected = 'Open Interest' if view_type == 'oi' else 'Volume'
        for _ in range(20):
            time.sleep(0.5)
            hdr = extract_header(driver)
            if expected in hdr:
                print(f'[VIEW] Verified header updated to: {hdr}')
                return True
        
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
                    # Try native click first
                    try:
                        el.click()
                        print(f'[VIEW] ✅ Native Click via XPath: "{el.text}" ({xpath})')
                    except:
                        driver.execute_script('arguments[0].click();', el)
                        print(f'[VIEW] ✅ JS Click via XPath: "{el.text}" ({xpath})')
                    
                    # WAIT FOR HEADER TO UPDATE
                    expected = 'Open Interest' if view_type == 'oi' else 'Volume'
                    for _ in range(20):  # Wait up to 10 seconds
                        time.sleep(0.5)
                        hdr = extract_header(driver)
                        if expected in hdr:
                            print(f'[VIEW] Verified header updated to: {hdr}')
                            return True
                    
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
    time.sleep(2)
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
# MAIN
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
    print(f'[NAV] Loading {profile["short"]} page: {url}')
    driver.get(url)
    time.sleep(5)
    wait_ready(driver)
    time.sleep(3)

    # Debug current state
    page_info = debug_page(driver, f'{profile["short"]} PAGE')

    # Get contracts
    contracts = get_expiration_contracts(driver, profile)

    if not contracts:
        print(f'[WARN] No contracts found for {profile["short"]}.')
        save_debug(driver, f'no_contracts_{asset_id}', output_dir=output_dir)

        # Fallback: scrape whatever is currently shown
        print('[FALLBACK] Scraping current view...')
        scrape_view(driver, 'intraday', 'current', skip_switch=True, output_dir=output_dir, asset_id=asset_id)
        scrape_view(driver, 'oi', 'current', output_dir=output_dir, asset_id=asset_id)
        return True

    # Classify
    classified = classify_contracts(contracts, profile)

    print(f'\n[PLAN] {profile["short"]} contract assignments:')
    for k in ['current', 'friday', 'monthly']:
        c = classified.get(k)
        if c:
            print(f'  OK {k}: {c.get("text", c.get("value", "?"))}')
        else:
            print(f'  -- {k}: NOT FOUND')

    # Scrape each contract type
    for key in ['current', 'friday', 'monthly']:
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

    return True


# ============================================================
# MAIN
# ============================================================

def main():
    # Parse CLI args
    import argparse
    parser = argparse.ArgumentParser(description='QuikStrike Vol2Vol Scraper v4 — Multi-Asset')
    parser.add_argument('--asset', choices=['gc', 'nq', 'all'], default='all',
                        help='Which asset to scrape (default: all)')
    args = parser.parse_args()

    if args.asset == 'all':
        assets = ASSETS_TO_SCRAPE
    else:
        assets = [args.asset]

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
        time.sleep(3)

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
            txt_files = [f for f in os.listdir(out_dir) if f.endswith('.txt') and 'debug' not in f]
            if txt_files:
                print(f'\n  {ASSET_PROFILES[asset_id]["name"]} files:')
                for f in sorted(txt_files):
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
        # Destination mirrors the source structure: data/ for GC, data/nq/ for NQ
        if profile['data_subfolder']:
            dst_dir = os.path.join(DATA_REPO_DIR, profile['data_subfolder'])
        else:
            dst_dir = DATA_REPO_DIR
        os.makedirs(dst_dir, exist_ok=True)

        data_files = [f for f in os.listdir(src_dir) if f.endswith('.txt') and 'debug' not in f]
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
