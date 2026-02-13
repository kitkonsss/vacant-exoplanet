# QuikStrike Vol2Vol Scraper
# Scrapes Gold options data from CME QuikStrike for 3 contract types:
# 1. Current (nearest expiry)
# 2. Friday (weekly Friday expiry)  
# 3. Monthly (front month)
#
# Requirements: pip install selenium webdriver-manager gitpython

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
# CONFIGURATION — Edit these values
# ============================================================
CME_EMAIL = os.environ.get('CME_EMAIL', '')
CME_PASSWORD = os.environ.get('CME_PASSWORD', '')

# Output directory for data files (relative to script)
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')

# QuikStrike URLs
QUIKSTRIKE_VOL2VOL_URL = 'https://cmegroup-sso.quikstrike.net/User/QuikStrikeView.aspx?pid=40&pf=6'
CME_LOGIN_URL = 'https://www.cmegroup.com/market-data/tools/quikstrike-options-overview.html'

# Contract types to scrape
# The scraper will auto-detect available contracts from the dropdown
CONTRACT_TYPES = ['current', 'friday', 'monthly']

# ============================================================
# HELPERS
# ============================================================

def create_driver():
    """Create a headless Chrome WebDriver."""
    options = Options()
    # options.add_argument('--headless=new')  # Uncomment for headless mode after testing
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--disable-gpu')
    options.add_argument('--window-size=1920,1080')
    options.add_argument('--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
    
    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=options)
    driver.implicitly_wait(10)
    return driver


def login_cme(driver):
    """
    Login to CME Group SSO.
    After login, the session cookies will allow access to QuikStrike.
    """
    print('[LOGIN] Navigating to CME login...')
    driver.get(CME_LOGIN_URL)
    time.sleep(3)
    
    # Check if already logged in
    if 'quikstrike' in driver.current_url.lower():
        print('[LOGIN] Already logged in!')
        return True
    
    try:
        # Look for the login button/link that redirects to CME SSO
        # The exact flow may vary — try multiple approaches
        
        # Approach 1: Direct QuikStrike URL (may redirect to SSO)
        driver.get(QUIKSTRIKE_VOL2VOL_URL)
        time.sleep(3)
        
        # If redirected to login page
        if 'login' in driver.current_url.lower() or 'sso' in driver.current_url.lower() or 'auth' in driver.current_url.lower():
            print('[LOGIN] SSO login page detected, entering credentials...')
            
            # Wait for email field
            email_field = WebDriverWait(driver, 15).until(
                EC.presence_of_element_located((By.CSS_SELECTOR, 'input[type="email"], input[name="email"], input[id*="email"], input[id*="user"], input[name*="user"]'))
            )
            email_field.clear()
            email_field.send_keys(CME_EMAIL)
            
            # Find and fill password
            password_field = driver.find_element(By.CSS_SELECTOR, 'input[type="password"]')
            password_field.clear()
            password_field.send_keys(CME_PASSWORD)
            
            # Click login button
            login_btn = driver.find_element(By.CSS_SELECTOR, 'button[type="submit"], input[type="submit"]')
            login_btn.click()
            
            # Wait for redirect to QuikStrike
            time.sleep(8)
            print(f'[LOGIN] Current URL after login: {driver.current_url}')
        
        # Verify we're on QuikStrike
        if 'quikstrike' in driver.current_url.lower():
            print('[LOGIN] Successfully logged into QuikStrike!')
            return True
        else:
            print(f'[LOGIN] May not be logged in. Current URL: {driver.current_url}')
            print('[LOGIN] Please check if manual login is required...')
            
            # Give user time to manually login if needed
            print('[LOGIN] Waiting 30 seconds for manual login if needed...')
            time.sleep(30)
            
            if 'quikstrike' in driver.current_url.lower():
                print('[LOGIN] Manual login successful!')
                return True
            return False
            
    except Exception as e:
        print(f'[LOGIN] Error during login: {e}')
        return False


def get_contract_list(driver):
    """
    Get list of available contracts from the expiration dropdown.
    Returns: list of dicts with {symbol, text, dte, option_element}
    """
    contracts = []
    try:
        # Look for the expiration dropdown
        # From the screenshot: it's a SELECT element or a custom dropdown
        dropdown = WebDriverWait(driver, 10).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, 
                'select[id*="Expiration"], select[id*="expiration"], select[id*="ddlExpiry"], select[id*="Contract"]'))
        )
        
        select = Select(dropdown)
        for option in select.options:
            text = option.text.strip()
            value = option.get_attribute('value')
            if text and value:
                # Parse DTE from text if available
                dte_match = re.search(r'([\d.]+)\s*DTE', text, re.IGNORECASE)
                dte = float(dte_match.group(1)) if dte_match else None
                contracts.append({
                    'symbol': value,
                    'text': text,
                    'dte': dte,
                })
        
        print(f'[CONTRACTS] Found {len(contracts)} contracts:')
        for c in contracts[:10]:
            print(f'  - {c["text"]} (value={c["symbol"]})')
            
    except Exception as e:
        print(f'[CONTRACTS] Error finding dropdown: {e}')
        # Try alternative: find links/buttons in the contract table
        try:
            rows = driver.find_elements(By.CSS_SELECTOR, 'table tr[onclick], table tr a')
            print(f'[CONTRACTS] Found {len(rows)} clickable contract rows')
        except:
            pass
    
    return contracts


def classify_contracts(contracts):
    """
    Classify contracts into current, friday, and monthly.
    Returns: dict with keys 'current', 'friday', 'monthly'
    """
    result = {'current': None, 'friday': None, 'monthly': None}
    
    if not contracts:
        return result
    
    # Sort by DTE
    sorted_c = sorted(contracts, key=lambda c: c['dte'] if c['dte'] is not None else 9999)
    
    # Current = lowest DTE
    if sorted_c:
        result['current'] = sorted_c[0]
    
    # Friday = find nearest Friday expiry (weekly)
    # Usually weekly options have symbols like OG*G6 for Gold weekly
    for c in sorted_c:
        sym = c['symbol'].upper()
        text = c['text'].upper()
        # Look for weekly Friday contracts
        if c['dte'] and c['dte'] > 0:
            # Check if it's a different contract than current and within ~7 days
            if result['current'] and c['symbol'] != result['current']['symbol'] and c['dte'] <= 7:
                result['friday'] = c
                break
    
    # Monthly = find the main monthly contract (usually starts with GC or OG with longer DTE)
    for c in sorted_c:
        sym = c['symbol'].upper()
        text = c['text'].upper()
        if c['dte'] and c['dte'] > 7:
            # Monthly contracts typically have larger DTE
            if 'monthly' in text.lower() or c['dte'] > 14:
                result['monthly'] = c
                break
    
    # Fallback: if no monthly found, pick the one with DTE > 14
    if not result['monthly']:
        for c in sorted_c:
            if c['dte'] and c['dte'] > 14:
                result['monthly'] = c
                break
    
    return result


def extract_highcharts_data(driver):
    """
    Extract data from the Highcharts chart rendered on the page.
    Returns the series data as a list of dicts.
    """
    try:
        # Wait for Highcharts to render
        time.sleep(2)
        
        # Extract data via JavaScript
        data = driver.execute_script("""
            if (typeof Highcharts === 'undefined' || !Highcharts.charts) return null;
            
            // Find the active chart
            var chart = null;
            for (var i = 0; i < Highcharts.charts.length; i++) {
                if (Highcharts.charts[i]) {
                    chart = Highcharts.charts[i];
                    break;
                }
            }
            if (!chart) return null;
            
            var result = {
                title: chart.title ? chart.title.textStr : '',
                series: []
            };
            
            for (var s = 0; s < chart.series.length; s++) {
                var series = chart.series[s];
                var points = [];
                for (var p = 0; p < series.data.length; p++) {
                    var point = series.data[p];
                    points.push({
                        x: point.x !== undefined ? point.x : point.category,
                        y: point.y,
                        name: point.name || ''
                    });
                }
                result.series.push({
                    name: series.name,
                    type: series.type,
                    color: series.color,
                    data: points
                });
            }
            
            return result;
        """)
        
        if data:
            print(f'[CHART] Extracted chart: "{data["title"]}" with {len(data["series"])} series')
            for s in data['series']:
                print(f'  - Series "{s["name"]}": {len(s["data"])} points (type: {s["type"]})')
        else:
            print('[CHART] No Highcharts data found')
        
        return data
    except Exception as e:
        print(f'[CHART] Error extracting Highcharts data: {e}')
        return None


def extract_header_info(driver):
    """
    Extract header info (contract name, DTE, underlying, etc.) from the page.
    """
    try:
        info = driver.execute_script("""
            var result = {};
            
            // Try to find the header text
            var headerEl = document.querySelector('[id*="lblHeader"], [id*="title"], .chart-title, h2, h3');
            if (headerEl) result.header = headerEl.textContent.trim();
            
            // Find price info
            var priceEls = document.querySelectorAll('[id*="Price"], [id*="price"], [id*="Underlying"], [id*="underlying"]');
            priceEls.forEach(function(el) {
                result.priceText = (result.priceText || '') + ' ' + el.textContent.trim();
            });
            
            // Find the subtitle/info line
            var subtitles = document.querySelectorAll('.chart-subtitle, [id*="SubTitle"], [id*="subtitle"]');
            subtitles.forEach(function(el) {
                result.subtitle = (result.subtitle || '') + ' ' + el.textContent.trim();
            });
            
            return result;
        """)
        return info
    except:
        return {}


def extract_vol_settle_curve(driver):
    """
    Extract the Vol Settle values from the chart or page.
    Returns a dict of strike -> volSettle
    """
    try:
        data = driver.execute_script("""
            if (typeof Highcharts === 'undefined' || !Highcharts.charts) return null;
            
            var chart = null;
            for (var i = 0; i < Highcharts.charts.length; i++) {
                if (Highcharts.charts[i]) {
                    chart = Highcharts.charts[i];
                    break;
                }
            }
            if (!chart) return null;
            
            // Look for a series named 'Vol Settle' or similar
            for (var s = 0; s < chart.series.length; s++) {
                var series = chart.series[s];
                var name = (series.name || '').toLowerCase();
                if (name.indexOf('vol') >= 0 && name.indexOf('settle') >= 0) {
                    var result = {};
                    for (var p = 0; p < series.data.length; p++) {
                        var point = series.data[p];
                        var strike = point.x !== undefined ? point.x : point.category;
                        result[strike] = point.y;
                    }
                    return result;
                }
            }
            return null;
        """)
        return data
    except:
        return None


def switch_to_view(driver, view_type):
    """
    Switch between 'Intraday Volume' and 'Open Interest' views.
    view_type: 'intraday' or 'oi'
    """
    try:
        if view_type == 'intraday':
            # Click Intraday Volume button/link
            btn = driver.find_element(By.CSS_SELECTOR, 
                '[id*="lbIntradayVolume"], [id*="IntradayVolume"], a[href*="IntradayVolume"]')
        else:
            # Click Open Interest button/link
            btn = driver.find_element(By.CSS_SELECTOR,
                '[id*="lbOpenInterest"], [id*="OpenInterest"], a[href*="OpenInterest"]')
        
        btn.click()
        time.sleep(3)  # Wait for postback and chart reload
        print(f'[VIEW] Switched to {view_type} view')
        return True
    except Exception as e:
        print(f'[VIEW] Error switching to {view_type}: {e}')
        
        # Alternative: Try by link text
        try:
            if view_type == 'intraday':
                links = driver.find_elements(By.PARTIAL_LINK_TEXT, 'Intraday')
            else:
                links = driver.find_elements(By.PARTIAL_LINK_TEXT, 'Open Interest')
            
            if links:
                links[0].click()
                time.sleep(3)
                print(f'[VIEW] Switched to {view_type} via link text')
                return True
        except:
            pass
    
    return False


def select_contract(driver, contract_value):
    """Select a specific contract from the dropdown."""
    try:
        dropdown = driver.find_element(By.CSS_SELECTOR,
            'select[id*="Expiration"], select[id*="expiration"], select[id*="ddlExpiry"], select[id*="Contract"]')
        select = Select(dropdown)
        select.select_by_value(contract_value)
        time.sleep(4)  # Wait for postback
        print(f'[CONTRACT] Selected: {contract_value}')
        return True
    except Exception as e:
        print(f'[CONTRACT] Error selecting {contract_value}: {e}')
        return False


def chart_data_to_pageth_format(header_line, chart_data, vol_settle_data=None):
    """
    Convert extracted Highcharts data to pageth's txt format.
    Format:
      Header line
      Strike,Call,Put,Vol Settle
      4670,0,33,0.85...
    """
    if not chart_data or not chart_data.get('series'):
        return None
    
    # Identify call and put series
    call_series = None
    put_series = None
    vol_series = None
    
    for s in chart_data['series']:
        name = (s.get('name') or '').lower()
        if 'call' in name:
            call_series = s
        elif 'put' in name:
            put_series = s
        elif 'vol' in name and 'settle' in name:
            vol_series = s
    
    if not call_series and not put_series:
        # Try by color
        for s in chart_data['series']:
            color = (s.get('color') or '').lower()
            stype = (s.get('type') or '').lower()
            if stype in ('column', 'bar'):
                if not call_series:
                    call_series = s
                elif not put_series:
                    put_series = s
    
    # Build strike map
    strikes = {}
    
    if call_series:
        for point in call_series['data']:
            strike = point['x']
            if strike not in strikes:
                strikes[strike] = {'call': 0, 'put': 0, 'vs': 0}
            strikes[strike]['call'] = abs(int(point['y'] or 0))
    
    if put_series:
        for point in put_series['data']:
            strike = point['x']
            if strike not in strikes:
                strikes[strike] = {'call': 0, 'put': 0, 'vs': 0}
            strikes[strike]['put'] = abs(int(point['y'] or 0))
    
    # Add vol settle data
    if vol_settle_data:
        for strike_str, vs_val in vol_settle_data.items():
            strike = float(strike_str)
            if strike in strikes:
                strikes[strike]['vs'] = vs_val or 0
    elif vol_series:
        for point in vol_series['data']:
            strike = point['x']
            if strike in strikes:
                strikes[strike]['vs'] = point['y'] or 0
    
    # Format output
    lines = [header_line, 'Strike,Call,Put,Vol Settle']
    for strike in sorted(strikes.keys()):
        d = strikes[strike]
        lines.append(f'{int(strike)},{d["call"]},{d["put"]},{d["vs"]}')
    
    return '\n'.join(lines)


def build_header_line(contract_symbol, dte, underlying, change, data_type):
    """Build the header line in pageth format."""
    return f'Gold (OG|GC) {contract_symbol} ({dte:.2f} DTE) vs {underlying} ({change:+.1f}) - {data_type}'


def scrape_contract(driver, contract_info, output_prefix):
    """
    Scrape both Intraday Volume and OI for a single contract.
    Saves to {output_prefix}_IntradayData.txt and {output_prefix}_OIData.txt
    """
    print(f'\n{"="*60}')
    print(f'[SCRAPE] Processing: {contract_info["text"]}')
    print(f'{"="*60}')
    
    # Select contract
    if not select_contract(driver, contract_info['symbol']):
        print(f'[SCRAPE] Failed to select contract {contract_info["symbol"]}')
        return False
    
    results = {}
    
    for view_type, file_suffix in [('intraday', 'IntradayData'), ('oi', 'OIData')]:
        data_type_label = 'Intraday Volume' if view_type == 'intraday' else 'Open Interest'
        
        # Switch view
        if not switch_to_view(driver, view_type):
            print(f'[SCRAPE] Failed to switch to {view_type}')
            continue
        
        # Extract chart data
        chart_data = extract_highcharts_data(driver)
        vol_settle = extract_vol_settle_curve(driver)
        header_info = extract_header_info(driver)
        
        if chart_data:
            # Try to parse header info from page
            header_text = header_info.get('header', '') or header_info.get('subtitle', '')
            
            # Build header line
            dte = contract_info['dte'] or 0
            # Try to get underlying price from chart title or header
            underlying_match = re.search(r'vs\s*([\d.]+)', header_text or '')
            underlying = float(underlying_match.group(1)) if underlying_match else 0
            
            change_match = re.search(r'\(([+-]?\d+\.?\d*)\)', header_text or '')
            change = float(change_match.group(1)) if change_match else 0
            
            if underlying == 0:
                # Try from chart title
                title = chart_data.get('title', '')
                price_match = re.search(r'vs\s*([\d.]+)', title)
                if price_match:
                    underlying = float(price_match.group(1))
            
            header_line = build_header_line(
                contract_info['symbol'], dte, underlying, change, data_type_label
            )
            
            # Convert to pageth format
            formatted = chart_data_to_pageth_format(header_line, chart_data, vol_settle)
            
            if formatted:
                # Save to file
                filepath = os.path.join(OUTPUT_DIR, f'{output_prefix}_{file_suffix}.txt')
                with open(filepath, 'w') as f:
                    f.write(formatted)
                print(f'[SAVE] Saved: {filepath}')
                results[view_type] = filepath
            else:
                print(f'[SCRAPE] Could not format {view_type} data')
        else:
            print(f'[SCRAPE] No chart data for {view_type}')
    
    return bool(results)


# ============================================================
# MAIN
# ============================================================

def main():
    # Validate credentials
    if not CME_EMAIL or not CME_PASSWORD:
        print('=' * 60)
        print('CME credentials required!')
        print('Set environment variables:')
        print('  set CME_EMAIL=your_email@example.com')
        print('  set CME_PASSWORD=your_password')
        print('Or edit the CME_EMAIL and CME_PASSWORD variables in this script.')
        print('=' * 60)
        sys.exit(1)
    
    # Create output directory
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    # Create WebDriver
    print('[INIT] Starting Chrome browser...')
    driver = create_driver()
    
    try:
        # Login
        if not login_cme(driver):
            print('[ERROR] Failed to login to CME. Exiting.')
            return
        
        # Navigate to Vol2Vol
        print('[NAV] Navigating to Vol2Vol...')
        driver.get(QUIKSTRIKE_VOL2VOL_URL)
        time.sleep(5)
        
        # Get contract list
        contracts = get_contract_list(driver)
        
        if not contracts:
            print('[ERROR] No contracts found. The page may not have loaded correctly.')
            print(f'[DEBUG] Current URL: {driver.current_url}')
            print(f'[DEBUG] Page title: {driver.title}')
            
            # Save page source for debugging
            debug_path = os.path.join(OUTPUT_DIR, 'debug_page.html')
            with open(debug_path, 'w', encoding='utf-8') as f:
                f.write(driver.page_source)
            print(f'[DEBUG] Saved page source to {debug_path}')
            return
        
        # Classify contracts
        classified = classify_contracts(contracts)
        print(f'\n[CLASSIFIED] Contract assignments:')
        for key, c in classified.items():
            if c:
                print(f'  {key}: {c["text"]} (DTE={c["dte"]})')
            else:
                print(f'  {key}: NOT FOUND')
        
        # Scrape each available contract
        for contract_type in CONTRACT_TYPES:
            contract = classified.get(contract_type)
            if contract:
                scrape_contract(driver, contract, contract_type)
            else:
                print(f'\n[SKIP] No contract found for: {contract_type}')
        
        print(f'\n{"="*60}')
        print('[DONE] Scraping complete!')
        print(f'[DONE] Data saved to: {OUTPUT_DIR}')
        print(f'{"="*60}')
        
        # List output files
        if os.path.exists(OUTPUT_DIR):
            files = os.listdir(OUTPUT_DIR)
            txt_files = [f for f in files if f.endswith('.txt') and f != 'debug_page.html']
            if txt_files:
                print('\nOutput files:')
                for f in sorted(txt_files):
                    filepath = os.path.join(OUTPUT_DIR, f)
                    size = os.path.getsize(filepath)
                    print(f'  {f} ({size} bytes)')
    
    except Exception as e:
        print(f'[ERROR] {e}')
        import traceback
        traceback.print_exc()
    
    finally:
        driver.quit()
        print('[CLEANUP] Browser closed.')


if __name__ == '__main__':
    main()
