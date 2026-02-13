# QuikStrike Vol2Vol Scraper
# Scrapes Gold options data from CME QuikStrike for 3 contract types:
# 1. Current (nearest expiry)
# 2. Friday (weekly Friday expiry)
# 3. Monthly (front month)
#
# Requirements: pip install selenium webdriver-manager

import os
import sys
import json
import time
import re
from datetime import datetime
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait, Select
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException
from webdriver_manager.chrome import ChromeDriverManager

# ============================================================
# CONFIGURATION — Edit these values or set env vars
# ============================================================
CME_EMAIL = os.environ.get('CME_EMAIL', '')
CME_PASSWORD = os.environ.get('CME_PASSWORD', '')

# Output directory for data files
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')

# ─── URLs ───
# The CME wrapper page embeds QuikStrike in an iframe.
# Going to the direct QuikStrike URL redirects to SSO login first.
CME_WRAPPER_URL = 'https://www.cmegroup.com/tools-information/quikstrike/vol2vol-expected-range.html'
QUIKSTRIKE_DIRECT_URL = 'https://cmegroup-sso.quikstrike.net/User/QuikStrikeView.aspx?pid=40&pf=6'

# ============================================================
# HELPERS
# ============================================================

def create_driver():
    """Create a Chrome WebDriver (visible for login)."""
    options = Options()
    # Do NOT use headless — CME SSO login needs visible Chrome
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--disable-gpu')
    options.add_argument('--window-size=1920,1080')
    options.add_argument('--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')

    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=options)
    driver.implicitly_wait(5)
    return driver


def login_cme(driver, max_wait=120):
    """
    Login to CME Group SSO.
    1. Navigate to QuikStrike direct URL → it redirects to login.cmegroup.com
    2. Fill email + password
    3. Submit → wait for redirect back to QuikStrike
    """
    print('[LOGIN] Navigating to QuikStrike (will redirect to SSO)...')
    driver.get(QUIKSTRIKE_DIRECT_URL)
    time.sleep(3)

    current = driver.current_url
    print(f'[LOGIN] Current URL: {current}')

    # ─── Already on QuikStrike? ───
    if 'quikstrike.net' in current and 'login' not in current.lower():
        print('[LOGIN] Already logged in!')
        return True

    # ─── On SSO login page ───
    if 'login.cmegroup.com' in current or 'sso' in current:
        print('[LOGIN] SSO login page detected.')

        if not CME_EMAIL or not CME_PASSWORD:
            print('[LOGIN] No credentials provided. Waiting for manual login...')
            print(f'[LOGIN] Please log in manually within {max_wait} seconds.')
            return _wait_for_quikstrike(driver, max_wait)

        try:
            # Wait for the email field
            user_field = WebDriverWait(driver, 15).until(
                EC.presence_of_element_located((By.ID, 'user'))
            )
            user_field.clear()
            user_field.send_keys(CME_EMAIL)
            print('[LOGIN] Entered email.')

            # Password field
            pwd_field = driver.find_element(By.ID, 'pwd')
            pwd_field.clear()
            pwd_field.send_keys(CME_PASSWORD)
            print('[LOGIN] Entered password.')

            # Click "LOG IN" button
            login_btn = driver.find_element(By.ID, 'loginBtn')
            login_btn.click()
            print('[LOGIN] Clicked LOG IN. Waiting for redirect...')

            # Wait for redirect to QuikStrike (may take a while for MFA/CAPTCHA)
            return _wait_for_quikstrike(driver, max_wait)

        except Exception as e:
            print(f'[LOGIN] Auto-login error: {e}')
            print(f'[LOGIN] Falling back to manual login. You have {max_wait}s...')
            return _wait_for_quikstrike(driver, max_wait)

    # Unknown page — try manual login
    print(f'[LOGIN] Unknown page: {current}')
    print(f'[LOGIN] Please manually navigate and log in. Waiting {max_wait}s...')
    return _wait_for_quikstrike(driver, max_wait)


def _wait_for_quikstrike(driver, timeout_sec):
    """Poll until the browser is on a QuikStrike page (not login)."""
    start = time.time()
    check_interval = 3
    while time.time() - start < timeout_sec:
        url = driver.current_url
        if 'quikstrike.net' in url and 'login' not in url.lower():
            print(f'[LOGIN] ✅ Successfully reached QuikStrike! URL: {url}')
            return True
        time.sleep(check_interval)
    print('[LOGIN] ❌ Timed out waiting for QuikStrike.')
    return False


def ensure_on_vol2vol(driver):
    """Make sure we're on the Vol2Vol page (pid=40, pf=6)."""
    current = driver.current_url
    if 'pid=40' in current and 'pf=6' in current:
        return True
    print('[NAV] Navigating to Vol2Vol page...')
    driver.get(QUIKSTRIKE_DIRECT_URL)
    time.sleep(5)
    return 'quikstrike' in driver.current_url.lower()


# ============================================================
# CONTRACT DISCOVERY
# ============================================================

def get_contracts_from_dropdown(driver):
    """
    Find the expiration dropdown and extract available contracts.
    Returns list of dicts: {value, text}
    """
    contracts = []

    # Try multiple possible selectors for the dropdown
    selectors = [
        'select[id*="ddlExpiry"]',
        'select[id*="ddlContract"]',
        'select[id*="Expiration"]',
        'select[id*="expiration"]',
        'select[id*="Contract"]',
    ]

    dropdown = None
    for sel in selectors:
        try:
            dropdown = driver.find_element(By.CSS_SELECTOR, sel)
            print(f'[DROPDOWN] Found via: {sel}')
            break
        except NoSuchElementException:
            continue

    if not dropdown:
        # Try to find ALL select elements and check their options
        print('[DROPDOWN] Trying to find any select element...')
        all_selects = driver.find_elements(By.TAG_NAME, 'select')
        print(f'[DROPDOWN] Found {len(all_selects)} select elements:')
        for i, sel_elem in enumerate(all_selects):
            sel_id = sel_elem.get_attribute('id') or '(no id)'
            sel_name = sel_elem.get_attribute('name') or '(no name)'
            try:
                opts = Select(sel_elem).options
                opt_texts = [o.text.strip()[:40] for o in opts[:3]]
                print(f'  [{i}] id={sel_id} name={sel_name} options={opt_texts}...')
                # Check if this looks like a contract dropdown
                for o in opts:
                    txt = o.text.strip()
                    if 'OG' in txt or 'GC' in txt or 'DTE' in txt:
                        dropdown = sel_elem
                        print(f'  → This looks like the contract dropdown!')
                        break
            except:
                print(f'  [{i}] id={sel_id} name={sel_name} (could not read options)')
            if dropdown:
                break

    if not dropdown:
        print('[DROPDOWN] ❌ Could not find contract dropdown.')
        # Save page source for debugging
        debug_path = os.path.join(OUTPUT_DIR, 'debug_page.html')
        with open(debug_path, 'w', encoding='utf-8') as f:
            f.write(driver.page_source)
        print(f'[DROPDOWN] Saved page source to: {debug_path}')

        # Also save a screenshot
        screenshot_path = os.path.join(OUTPUT_DIR, 'debug_screenshot.png')
        driver.save_screenshot(screenshot_path)
        print(f'[DROPDOWN] Saved screenshot to: {screenshot_path}')
        return []

    # Read all options
    select = Select(dropdown)
    for option in select.options:
        text = option.text.strip()
        value = option.get_attribute('value') or ''
        if text and value:
            contracts.append({'value': value, 'text': text})

    print(f'[DROPDOWN] Found {len(contracts)} contracts:')
    for c in contracts:
        print(f'  - {c["text"]} (value={c["value"]})')

    return contracts


def classify_contracts(contracts):
    """
    Classify contracts into current (nearest), friday (weekly), monthly.
    """
    result = {'current': None, 'friday': None, 'monthly': None}

    if not contracts:
        return result

    # Parse DTE from text if possible
    for c in contracts:
        dte_match = re.search(r'([\d.]+)\s*(?:DTE|dte)', c['text'])
        c['dte'] = float(dte_match.group(1)) if dte_match else None

    # Sort by DTE (unknown DTE at end)
    sorted_c = sorted(contracts, key=lambda c: c['dte'] if c['dte'] is not None else 9999)

    # Current = smallest DTE
    if sorted_c and sorted_c[0]['dte'] is not None:
        result['current'] = sorted_c[0]

    # Find Friday weekly (DTE between 1-7, different from current)
    for c in sorted_c:
        if c['dte'] is not None and 1 < c['dte'] <= 7:
            if result['current'] and c['value'] != result['current']['value']:
                result['friday'] = c
                break

    # Monthly = first with DTE > 14
    for c in sorted_c:
        if c['dte'] is not None and c['dte'] > 14:
            result['monthly'] = c
            break

    return result


# ============================================================
# DATA EXTRACTION
# ============================================================

def select_contract(driver, contract_value):
    """Select a contract from the dropdown."""
    selectors = [
        'select[id*="ddlExpiry"]',
        'select[id*="ddlContract"]',
        'select[id*="Expiration"]',
        'select[id*="expiration"]',
        'select[id*="Contract"]',
    ]
    for sel in selectors:
        try:
            dropdown = driver.find_element(By.CSS_SELECTOR, sel)
            select = Select(dropdown)
            select.select_by_value(contract_value)
            print(f'[SELECT] Selected contract: {contract_value}')
            time.sleep(4)  # Wait for postback
            return True
        except:
            continue

    # Fallback: find any select that has this value
    all_selects = driver.find_elements(By.TAG_NAME, 'select')
    for sel_elem in all_selects:
        try:
            select = Select(sel_elem)
            select.select_by_value(contract_value)
            time.sleep(4)
            print(f'[SELECT] Selected contract via fallback: {contract_value}')
            return True
        except:
            continue

    print(f'[SELECT] ❌ Failed to select contract: {contract_value}')
    return False


def switch_view(driver, view_type):
    """
    Switch between 'intraday' and 'oi' views.
    Clicks the appropriate link/button on the page.
    """
    if view_type == 'intraday':
        search_texts = ['Intraday', 'Volume']
        css_selectors = [
            '[id*="lbIntraday"]',
            '[id*="IntradayVolume"]',
            'a[id*="lbIntraday"]',
        ]
    else:
        search_texts = ['Open Interest', 'OI']
        css_selectors = [
            '[id*="lbOpen"]',
            '[id*="OpenInterest"]',
            'a[id*="lbOpen"]',
        ]

    # Try CSS selectors first
    for sel in css_selectors:
        try:
            el = driver.find_element(By.CSS_SELECTOR, sel)
            el.click()
            time.sleep(3)
            print(f'[VIEW] Switched to {view_type} via {sel}')
            return True
        except:
            continue

    # Try by link text
    for text in search_texts:
        try:
            el = driver.find_element(By.PARTIAL_LINK_TEXT, text)
            el.click()
            time.sleep(3)
            print(f'[VIEW] Switched to {view_type} via link text "{text}"')
            return True
        except:
            continue

    # Fallback: find all <a> tags and look for matching text
    links = driver.find_elements(By.TAG_NAME, 'a')
    for link in links:
        txt = link.text.lower()
        for search in search_texts:
            if search.lower() in txt:
                try:
                    link.click()
                    time.sleep(3)
                    print(f'[VIEW] Switched to {view_type} via <a> text match')
                    return True
                except:
                    continue

    print(f'[VIEW] ❌ Could not switch to {view_type}')
    return False


def extract_chart_data(driver):
    """
    Extract data from Highcharts chart(s) on the page.
    Returns: {title, series: [{name, type, data: [{x, y}]}]}
    """
    time.sleep(2)  # Ensure chart is fully rendered

    data = driver.execute_script("""
        if (typeof Highcharts === 'undefined') return {error: 'Highcharts not defined'};
        if (!Highcharts.charts) return {error: 'No Highcharts.charts'};

        var charts = Highcharts.charts.filter(c => c != null);
        if (charts.length === 0) return {error: 'No active charts'};

        var results = [];
        for (var ci = 0; ci < charts.length; ci++) {
            var chart = charts[ci];
            var chartResult = {
                index: ci,
                title: chart.title ? chart.title.textStr : '',
                subtitle: chart.subtitle ? chart.subtitle.textStr : '',
                seriesCount: chart.series.length,
                series: []
            };

            for (var s = 0; s < chart.series.length; s++) {
                var series = chart.series[s];
                if (!series.visible) continue;
                var points = [];
                for (var p = 0; p < series.data.length; p++) {
                    var point = series.data[p];
                    points.push({
                        x: point.x !== undefined ? point.x : (point.category || 0),
                        y: point.y !== undefined ? point.y : 0,
                        name: point.name || ''
                    });
                }
                chartResult.series.push({
                    name: series.name || '',
                    type: series.type || '',
                    color: series.color || '',
                    data: points
                });
            }
            results.push(chartResult);
        }
        return {charts: results};
    """)

    if isinstance(data, dict) and 'error' in data:
        print(f'[CHART] Error: {data["error"]}')
        return None

    if data and 'charts' in data:
        for chart in data['charts']:
            print(f'[CHART] Chart #{chart["index"]}: "{chart["title"]}" subtitle="{chart.get("subtitle","")}"')
            for s in chart['series']:
                print(f'  Series "{s["name"]}" ({s["type"]}): {len(s["data"])} points')
        return data

    return None


def extract_header_text(driver):
    """Extract the main header/info text from the page."""
    text = driver.execute_script("""
        // Try multiple approaches to find the header
        var selectors = [
            'span[id*="lblHeader"]',
            'span[id*="header"]',
            '[id*="lblTitle"]',
            '.chart-header',
            'div[id*="chartHeader"]'
        ];
        for (var i = 0; i < selectors.length; i++) {
            var el = document.querySelector(selectors[i]);
            if (el && el.textContent.trim().length > 5) {
                return el.textContent.trim();
            }
        }
        // Try the subtitle element from Highcharts
        var subtitle = document.querySelector('.highcharts-subtitle');
        if (subtitle) return subtitle.textContent.trim();
        var title = document.querySelector('.highcharts-title');
        if (title) return title.textContent.trim();
        return '';
    """)
    return text or ''


def chart_to_pageth_format(chart_data, header_line):
    """
    Convert Highcharts data into pageth-compatible text format.
    """
    if not chart_data or 'charts' not in chart_data:
        return None

    # Use the first chart (or the one with bar/column series)
    target_chart = None
    for chart in chart_data['charts']:
        for s in chart['series']:
            if s['type'] in ('column', 'bar'):
                target_chart = chart
                break
        if target_chart:
            break

    if not target_chart:
        target_chart = chart_data['charts'][0] if chart_data['charts'] else None

    if not target_chart:
        return None

    # Identify call/put/vol series
    call_data = {}
    put_data = {}
    vol_data = {}

    for s in target_chart['series']:
        name_lower = s['name'].lower()
        if 'call' in name_lower:
            for p in s['data']:
                call_data[p['x']] = abs(p['y']) if p['y'] else 0
        elif 'put' in name_lower:
            for p in s['data']:
                put_data[p['x']] = abs(p['y']) if p['y'] else 0
        elif 'vol' in name_lower and 'settle' in name_lower:
            for p in s['data']:
                vol_data[p['x']] = p['y'] if p['y'] else 0

    # Combine strikes
    all_strikes = sorted(set(list(call_data.keys()) + list(put_data.keys())))
    if not all_strikes:
        return None

    lines = [header_line, 'Strike,Call,Put,Vol Settle']
    for strike in all_strikes:
        c = int(call_data.get(strike, 0))
        p = int(put_data.get(strike, 0))
        v = vol_data.get(strike, 0)
        lines.append(f'{int(strike)},{c},{p},{v}')

    return '\n'.join(lines)


def scrape_one_view(driver, view_type, contract_info, output_prefix):
    """
    Scrape one view (intraday or oi) for a contract.
    Returns the saved filepath, or None.
    """
    label = 'Intraday Volume' if view_type == 'intraday' else 'Open Interest'
    suffix = 'IntradayData' if view_type == 'intraday' else 'OIData'

    if not switch_view(driver, view_type):
        return None

    chart_data = extract_chart_data(driver)
    header_text = extract_header_text(driver)

    if not chart_data:
        print(f'[SCRAPE] No chart data for {view_type}')
        return None

    # Build header line (try to use page header, fallback to constructed)
    if header_text:
        header_line = header_text
    else:
        dte = contract_info.get('dte', 0) or 0
        value = contract_info.get('value', 'Unknown')
        header_line = f'Gold (OG|GC) {value} ({dte:.2f} DTE) - {label}'

    formatted = chart_to_pageth_format(chart_data, header_line)
    if not formatted:
        print(f'[SCRAPE] Could not format {view_type} data')
        return None

    filepath = os.path.join(OUTPUT_DIR, f'{output_prefix}_{suffix}.txt')
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(formatted)
    
    line_count = len(formatted.strip().split('\n'))
    print(f'[SAVE] ✅ {filepath} ({line_count} lines)')
    return filepath


def scrape_contract(driver, contract_info, output_prefix):
    """Scrape both Intraday + OI for one contract."""
    print(f'\n{"="*60}')
    print(f'[SCRAPE] Contract: {contract_info["text"]} → prefix: {output_prefix}')
    print(f'{"="*60}')

    # Select the contract from dropdown
    if not select_contract(driver, contract_info['value']):
        return False

    results = {}
    for view in ['intraday', 'oi']:
        path = scrape_one_view(driver, view, contract_info, output_prefix)
        if path:
            results[view] = path

    return bool(results)


# ============================================================
# MAIN
# ============================================================

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print('='*60)
    print('  QuikStrike Vol2Vol Scraper')
    print('='*60)

    if CME_EMAIL:
        print(f'  Email: {CME_EMAIL}')
    else:
        print('  ⚠ No CME_EMAIL set — you will need to login manually')
    print()

    # Start Chrome
    print('[INIT] Starting Chrome...')
    driver = create_driver()

    try:
        # ─── LOGIN ───
        if not login_cme(driver, max_wait=120):
            print('[ERROR] Could not reach QuikStrike. Aborting.')

            # Save debug info
            debug_path = os.path.join(OUTPUT_DIR, 'debug_page.html')
            with open(debug_path, 'w', encoding='utf-8') as f:
                f.write(driver.page_source)

            screenshot_path = os.path.join(OUTPUT_DIR, 'debug_screenshot.png')
            driver.save_screenshot(screenshot_path)
            print(f'[DEBUG] Saved page & screenshot to {OUTPUT_DIR}')
            return

        # ─── NAVIGATE TO VOL2VOL ───
        ensure_on_vol2vol(driver)
        time.sleep(3)

        # ─── DISCOVER CONTRACTS ───
        contracts = get_contracts_from_dropdown(driver)
        
        if not contracts:
            print('[WARN] No contracts from dropdown. Will try scraping current view as-is...')
            # Even without dropdown, try scraping whatever is currently shown
            scrape_one_view(driver, 'intraday', {'text': 'current', 'value': 'unknown'}, 'current')
            scrape_one_view(driver, 'oi', {'text': 'current', 'value': 'unknown'}, 'current')
            return

        # ─── CLASSIFY ───
        classified = classify_contracts(contracts)
        print(f'\n[PLAN] Contract assignments:')
        for key in ['current', 'friday', 'monthly']:
            c = classified.get(key)
            if c:
                print(f'  ✅ {key}: {c["text"]}')
            else:
                print(f'  ❌ {key}: NOT FOUND')

        # ─── SCRAPE EACH ───
        for contract_type in ['current', 'friday', 'monthly']:
            contract = classified.get(contract_type)
            if contract:
                scrape_contract(driver, contract, contract_type)
            else:
                print(f'\n[SKIP] No contract for: {contract_type}')

        # ─── DONE ───
        print(f'\n{"="*60}')
        print('[DONE] ✅ Scraping complete!')
        print(f'{"="*60}')

        # List output files
        txt_files = [f for f in os.listdir(OUTPUT_DIR) if f.endswith('.txt') and 'debug' not in f]
        if txt_files:
            print('\nGenerated files:')
            for f in sorted(txt_files):
                fp = os.path.join(OUTPUT_DIR, f)
                lines = len(open(fp, encoding='utf-8').readlines())
                print(f'  📄 {f} ({lines} lines)')

    except Exception as e:
        print(f'\n[ERROR] {e}')
        import traceback
        traceback.print_exc()

        # Save debug info
        try:
            debug_path = os.path.join(OUTPUT_DIR, 'debug_page.html')
            with open(debug_path, 'w', encoding='utf-8') as f:
                f.write(driver.page_source)
            driver.save_screenshot(os.path.join(OUTPUT_DIR, 'debug_screenshot.png'))
            print(f'[DEBUG] Saved debug info to {OUTPUT_DIR}')
        except:
            pass

    finally:
        driver.quit()
        print('[CLEANUP] Chrome closed.')


if __name__ == '__main__':
    main()
