# QuikStrike Vol2Vol Scraper v3
# Scrapes Gold options Vol2Vol data from CME QuikStrike
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
from datetime import datetime
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait, Select
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException, ElementClickInterceptedException
from webdriver_manager.chrome import ChromeDriverManager

# ============================================================
# CONFIG
# ============================================================
CME_EMAIL = os.environ.get('CME_EMAIL', 'kitsakontrader@gmail.com')
CME_PASSWORD = os.environ.get('CME_PASSWORD', 'Jayesslee123')
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
QUIKSTRIKE_URL = 'https://cmegroup-sso.quikstrike.net/User/QuikStrikeView.aspx?pid=40&pf=6'

# ============================================================

def create_driver():
    options = Options()
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--window-size=1920,1080')
    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=options)
    driver.implicitly_wait(5)
    return driver


def save_debug(driver, label=''):
    """Save page source + screenshot for debugging."""
    try:
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        suffix = f'_{label}' if label else ''
        html_path = os.path.join(OUTPUT_DIR, f'debug{suffix}.html')
        png_path = os.path.join(OUTPUT_DIR, f'debug{suffix}.png')
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

def login_cme(driver, max_wait=120):
    """Navigate to QuikStrike → handle SSO login → handle disclaimer."""
    print('[LOGIN] Opening QuikStrike URL...')
    driver.get(QUIKSTRIKE_URL)
    time.sleep(4)

    # Poll until we reach the Vol2Vol page
    start = time.time()
    logged_in = False
    credentials_entered = False

    while time.time() - start < max_wait:
        url = driver.current_url

        # ✅ On QuikStrike Vol2Vol page
        if 'quikstrike.net' in url and 'QuikStrikeView' in url:
            print(f'[LOGIN] ✅ On Vol2Vol page!')
            return True

        # 📋 Disclaimer page — try to accept
        if 'disclaimer' in url.lower() or 'Disclaimer' in url:
            print('[LOGIN] Disclaimer page — trying to accept...')
            _handle_disclaimer(driver)
            time.sleep(3)
            continue

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
    """Accept the QuikStrike disclaimer page."""
    # Look for any submit/accept/agree buttons or checkboxes
    try:
        # First check for checkbox (some disclaimers require checking a box first)
        checkboxes = driver.find_elements(By.CSS_SELECTOR, 'input[type="checkbox"]')
        for cb in checkboxes:
            if not cb.is_selected():
                cb.click()
                print('[DISCLAIMER] Checked checkbox')
                time.sleep(1)
    except:
        pass

    # Now click the accept/submit button
    for sel in [
        'input[type="submit"]', 'button[type="submit"]',
        'input[value*="ccept"]', 'input[value*="gree"]',
        '[id*="ccept"]', '[id*="gree"]', '[id*="btnOK"]',
        '#btnAccept', '#btnAgree', '#submit',
    ]:
        try:
            btn = driver.find_element(By.CSS_SELECTOR, sel)
            btn.click()
            print(f'[DISCLAIMER] Clicked: {sel}')
            time.sleep(3)
            return
        except:
            continue

    # Fallback: click any visible button
    for el in driver.find_elements(By.CSS_SELECTOR, 'input[type="submit"], input[type="button"], button'):
        val = el.get_attribute('value') or el.text or ''
        if val:
            print(f'[DISCLAIMER] Found button: "{val}"')
            try:
                el.click()
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

def get_expiration_contracts(driver):
    """
    Get contracts from the ExpirationTab links in the tab bar.
    
    From debug output, these links have IDs like:
      ctl00_MainContent_ucViewControl_OptionsInfo_ucExpirationTabs_lvTabs_ctrl0_lbExpirationTab
    And title attributes with DTE info like:
      "Contract: ... (Mar 2026) Expiration: 2/24/2026 (11.58 DTE) Future: GCJ6"
    """
    wait_ready(driver)

    # Read ExpirationTab links directly — these are the contract tabs
    contracts = driver.execute_script("""
        var result = [];
        document.querySelectorAll('a').forEach(function(a) {
            var id = a.id || '';
            if (id.indexOf('lbExpirationTab') >= 0) {
                var txt = a.textContent.trim();
                var title = a.title || '';
                var dte = null;
                var match = title.match(/([\d.]+)\s*DTE/i);
                if (match) dte = parseFloat(match[1]);
                result.push({
                    text: txt,
                    id: id,
                    title: title,
                    dte: dte
                });
            }
        });
        return result;
    """)

    if contracts:
        print(f'[EXPIRY] Found {len(contracts)} expiration tabs:')
        for c in contracts:
            dte_str = f'{c["dte"]:.1f} DTE' if c['dte'] is not None else 'no DTE'
            print(f'  {c["text"]:8s} ({dte_str}) id=...{c["id"][-20:]}')
        return contracts

    # Fallback: look for contract links in the selector popup  
    print('[EXPIRY] No ExpirationTab links found. Trying selector popup...')
    
    # Try to open selector popup
    for sel in ['[id*="hlExpiration"]', '[id*="Expiration"]']:
        try:
            driver.find_element(By.CSS_SELECTOR, sel).click()
            time.sleep(2)
            print(f'[EXPIRY] Clicked: {sel}')
            break
        except:
            continue

    contracts = driver.execute_script("""
        var result = [];
        var contractPattern = /^(OG|G[0-9])/;
        document.querySelectorAll('a').forEach(function(a) {
            var id = a.id || '';
            var txt = a.textContent.trim();
            if (id.indexOf('lbExpiration') >= 0 && contractPattern.test(txt) && txt.length < 15) {
                var title = a.title || '';
                var dte = null;
                var match = title.match(/([\d.]+)\s*DTE/i);
                if (match) dte = parseFloat(match[1]);
                result.push({text: txt, id: id, title: title, dte: dte});
            }
        });
        return result;
    """)

    if contracts:
        print(f'[EXPIRY] Found {len(contracts)} contracts in popup:')
        for c in contracts[:15]:
            dte_str = f'{c["dte"]:.1f} DTE' if c['dte'] is not None else 'no DTE'
            print(f'  {c["text"]:8s} ({dte_str})')
        return contracts

    print('[EXPIRY] ❌ No contracts found')
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

    # Strategy 2: Find by text + ExpirationTab pattern
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

def is_weekly_contract(symbol):
    """
    Determine if a Gold option symbol is weekly (Friday) or monthly.
    
    Weekly/Friday pattern: OG + digit + month + year  (e.g. OG2G6, OG3G6, OG1H6)
    Monthly pattern:       OG + month_letter + year   (e.g. OGH6, OGJ6, OGK6)
    
    The digit after 'OG' indicates which week of the month.
    """
    if len(symbol) >= 4 and symbol[:2] == 'OG':
        # Check 3rd character: digit = weekly, letter = monthly
        return symbol[2].isdigit()
    return False


def classify_contracts(contracts):
    """
    Classify contracts into current/friday/monthly using symbol pattern + DTE.
    
    Symbol patterns:
      OG2G6 = weekly (digit after OG) -> Friday contract
      OGH6  = monthly (letter after OG) -> Monthly contract
    
    Rules:
      current = lowest DTE overall (nearest expiry)
      friday  = lowest DTE weekly contract
               -> if same as current, mark to skip redundant scrape
      monthly = lowest DTE monthly contract (OGH6, OGJ6, etc.)
    """
    result = {'current': None, 'friday': None, 'monthly': None, 'friday_is_current': False}

    # Sort by DTE
    with_dte = [c for c in contracts if c.get('dte') is not None]
    sorted_c = sorted(with_dte, key=lambda c: c['dte'])

    if not sorted_c:
        print('[CLASSIFY] No DTE data — using first 3 contracts')
        if len(contracts) >= 1:
            result['current'] = contracts[0]
        if len(contracts) >= 2:
            result['friday'] = contracts[1]
        if len(contracts) >= 3:
            result['monthly'] = contracts[2]
        return result

    # Separate weekly vs monthly based on symbol pattern
    weeklies = [c for c in sorted_c if is_weekly_contract(c['text'])]
    monthlies = [c for c in sorted_c if not is_weekly_contract(c['text'])]

    print(f'[CLASSIFY] Found {len(weeklies)} weekly (Friday) and {len(monthlies)} monthly contracts')

    # Current = lowest DTE overall
    if sorted_c:
        result['current'] = sorted_c[0]

    # Friday = lowest DTE weekly contract (that is NOT expired or is valid)
    if weeklies:
        result['friday'] = weeklies[0]
    
    # Monthly = lowest DTE monthly contract
    if monthlies:
        result['monthly'] = monthlies[0]

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

    if view_type == 'intraday':
        # For Intraday: this is the DEFAULT view.
        # If we're already on it (page just loaded), return True.
        # Otherwise try to find and click the sidebar link.
        target_texts = ['Intraday']
        id_patterns = ['lbIntraday', 'lbVolume', 'Intraday']
    else:  # 'oi'
        target_texts = ['OI']  # Exact match to avoid 'OI Change'
        id_patterns = ['lbOIChart', 'lbOI', 'lbOpenInterest']

    # Strategy 1: Find sidebar link by exact text match across ALL <a> tags
    # (sidebar links may have no ID!)
    links = driver.find_elements(By.TAG_NAME, 'a')
    for link in links:
        txt = link.text.strip()
        link_id = link.get_attribute('id') or ''
        
        for target in target_texts:
            if txt == target:  # Exact match
                try:
                    driver.execute_script('arguments[0].click();', link)
                    print(f'[VIEW] ✅ Clicked sidebar "{txt}" (id={link_id or "none"})')
                    wait_ready(driver)
                    return True
                except Exception as e:
                    print(f'[VIEW] Click failed for "{txt}": {e}')
                    continue

    # Strategy 2: Find by partial ID match
    for pattern in id_patterns:
        found = driver.execute_script(f"""
            var links = document.querySelectorAll('a');
            for (var link of links) {{
                if (link.id && link.id.indexOf('{pattern}') >= 0) {{
                    return link.id;
                }}
            }}
            return null;
        """)
        if found:
            try:
                el = driver.find_element(By.ID, found)
                driver.execute_script('arguments[0].click();', el)
                print(f'[VIEW] ✅ Clicked by ID: {found}')
                wait_ready(driver)
                return True
            except Exception as e:
                print(f'[VIEW] Click failed for {found}: {e}')
                continue

    # Strategy 3: Search non-<a> elements (span, div, td) for clickable text
    for tag in ['span', 'div', 'td', 'li']:
        elements = driver.find_elements(By.TAG_NAME, tag)
        for el in elements:
            txt = el.text.strip()
            for target in target_texts:
                if txt == target:
                    try:
                        driver.execute_script('arguments[0].click();', el)
                        print(f'[VIEW] ✅ Clicked <{tag}> "{txt}"')
                        wait_ready(driver)
                        return True
                    except:
                        continue

    # Strategy 4: Use JavaScript to find by __doPostBack pattern
    found_postback = driver.execute_script("""
        var target = arguments[0];
        var links = document.querySelectorAll('a');
        for (var link of links) {
            var href = link.href || '';
            var txt = link.textContent.trim();
            if (txt === target || (href.indexOf('doPostBack') >= 0 && txt.indexOf(target) === 0)) {
                link.click();
                return 'clicked: ' + txt + ' | id=' + (link.id || 'none') + ' | href=' + href.substring(0, 80);
            }
        }
        return null;
    """, target_texts[0])
    if found_postback:
        print(f'[VIEW] ✅ JS postback click: {found_postback}')
        wait_ready(driver)
        return True

    # Debug: dump ALL links and their text to find the right one
    print(f'[VIEW] ❌ Could not switch to: {view_type}')
    print(f'[VIEW] DEBUG — All <a> links on page:')
    all_links = driver.execute_script("""
        var result = [];
        document.querySelectorAll('a').forEach(function(a) {
            var txt = a.textContent.trim();
            if (txt.length > 0 && txt.length < 30) {
                result.push({id: a.id || '(none)', text: txt, href: (a.href || '').substring(0, 60)});
            }
        });
        return result;
    """)
    for linfo in all_links:
        print(f'    <a id="{linfo["id"]}">{linfo["text"]}</a>  href={linfo["href"]}')
    return False


# ============================================================
# DATA EXTRACTION
# ============================================================

def extract_chart(driver):
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
                series: []
            };
            for (var ser of chart.series) {
                if (!ser.visible) continue;
                var pts = ser.data.map(p => ({
                    x: p.x !== undefined ? p.x : (p.category || 0),
                    y: p.y !== undefined ? p.y : 0
                }));
                info.series.push({name: ser.name || '', type: ser.type || '', data: pts});
            }
            results.push(info);
        }
        return {charts: results};
    """)


def extract_header(driver):
    """Get the header/subtitle text, with HTML tags stripped."""
    raw = driver.execute_script("""
        // Try Highcharts subtitle (contains Put/Call/Vol info)
        if (typeof Highcharts !== 'undefined' && Highcharts.charts) {
            var charts = Highcharts.charts.filter(c => c != null);
            for (var c of charts) {
                // Get plain text from subtitle (strip HTML)
                if (c.subtitle && c.subtitle.textStr) {
                    var tmp = document.createElement('div');
                    tmp.innerHTML = c.subtitle.textStr;
                    return tmp.textContent || tmp.innerText || '';
                }
                if (c.title && c.title.textStr) {
                    var tmp2 = document.createElement('div');
                    tmp2.innerHTML = c.title.textStr;
                    return tmp2.textContent || tmp2.innerText || '';
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


def chart_to_text(chart_data, header_line):
    """Convert chart data to pageth-compatible text format."""
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

def scrape_view(driver, view_type, prefix, skip_switch=False):
    """Scrape one view and save to file."""
    suffix = 'IntradayData' if view_type == 'intraday' else 'OIData'
    label = 'Intraday Volume' if view_type == 'intraday' else 'Open Interest'

    if not skip_switch:
        if not switch_to_view(driver, view_type):
            return None

    chart = extract_chart(driver)
    if isinstance(chart, dict) and 'error' in chart:
        print(f'[SCRAPE] Chart error ({view_type}): {chart["error"]}')
        return None

    header = extract_header(driver) or f'Gold (OG|GC) - {label}'
    text = chart_to_text(chart, header)
    if not text:
        print(f'[SCRAPE] No data for {view_type}')
        return None

    filepath = os.path.join(OUTPUT_DIR, f'{prefix}_{suffix}.txt')
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(text)

    nlines = len(text.strip().split('\n'))
    print(f'[SAVE] ✅ {os.path.basename(filepath)} ({nlines} lines, {len(text)} bytes)')
    return filepath


def scrape_contract(driver, contract, prefix):
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

    # 1. Scrape INTRADAY first — it's the default view, no click needed!
    print('[SCRAPE] Default view = Intraday Volume — scraping immediately...')
    path = scrape_view(driver, 'intraday', prefix, skip_switch=True)
    if path:
        results['intraday'] = path

    # 2. Switch to OI and scrape
    path = scrape_view(driver, 'oi', prefix)
    if path:
        results['oi'] = path

    return bool(results)





# ============================================================
# MAIN
# ============================================================

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print('═'*60)
    print('  QuikStrike Vol2Vol Scraper v3')
    print('═'*60)
    if CME_EMAIL:
        print(f'  Email: {CME_EMAIL}')
    else:
        print('  ⚠ No CME_EMAIL — manual login will be required')
    print()

    driver = create_driver()

    try:
        # ─── LOGIN ───
        if not login_cme(driver, max_wait=120):
            print('[ERROR] Could not reach QuikStrike.')
            save_debug(driver, 'login_fail')
            return

        # ─── WAIT FOR PAGE ───
        wait_ready(driver)
        time.sleep(3)

        # ─── DEBUG CURRENT STATE ───
        page_info = debug_page(driver, 'AFTER LOGIN')

        # ─── GET CONTRACTS ───
        contracts = get_expiration_contracts(driver)

        if not contracts:
            print('[WARN] No contracts found.')
            save_debug(driver, 'no_contracts')

            # Fallback: try to scrape whatever is currently shown
            print('[FALLBACK] Scraping current view...')
            scrape_view(driver, 'intraday', 'current', skip_switch=True)
            scrape_view(driver, 'oi', 'current')
            return

        # ─── CLASSIFY ───
        classified = classify_contracts(contracts)

        print(f'\n[PLAN] Contract assignments:')
        for k in ['current', 'friday', 'monthly']:
            c = classified.get(k)
            if c:
                print(f'  ✅ {k}: {c.get("text", c.get("value", "?"))}')
            else:
                print(f'  ❌ {k}: NOT FOUND')

        # ─── SCRAPE ───
        for key in ['current', 'friday', 'monthly']:
            c = classified.get(key)
            
            if key == 'friday' and classified.get('friday_is_current'):
                print(f'\n[SKIP] friday: same as current contract ({c.get("text")})')
                continue

            if c:
                scrape_contract(driver, c, key)
            else:
                print(f'\n[SKIP] {key}: no contract')

        # ─── DONE ───
        print(f'\n{"═"*60}')
        print('  ✅ SCRAPING COMPLETE')
        print(f'{"═"*60}')

        txt_files = [f for f in os.listdir(OUTPUT_DIR) if f.endswith('.txt') and 'debug' not in f]
        if txt_files:
            print('\n📁 Output files:')
            for f in sorted(txt_files):
                fp = os.path.join(OUTPUT_DIR, f)
                lines = len(open(fp, encoding='utf-8').readlines())
                size = os.path.getsize(fp)
                print(f'  📄 {f} ({lines} lines, {size:,} bytes)')

    except Exception as e:
        print(f'\n[ERROR] {e}')
        import traceback
        traceback.print_exc()
        save_debug(driver, 'error')

    finally:
        driver.quit()
        print('[CLEANUP] Chrome closed.')


if __name__ == '__main__':
    main()
