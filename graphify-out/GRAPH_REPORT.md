# Graph Report - vacant  (2026-05-17)

## Corpus Check
- 47 files · ~912,091 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1109 nodes · 1569 edges · 82 communities (77 shown, 5 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `aba4b604`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]
- [[_COMMUNITY_Community 74|Community 74]]
- [[_COMMUNITY_Community 75|Community 75]]
- [[_COMMUNITY_Community 76|Community 76]]

## God Nodes (most connected - your core abstractions)
1. `getProfile()` - 19 edges
2. `renderAnalysisTab()` - 19 edges
3. `renderAnalysisTab()` - 19 edges
4. `scrape_asset()` - 18 edges
5. `getProfile()` - 17 edges
6. `Vol2VolIndicator` - 17 edges
7. `analyze_contract_position()` - 13 edges
8. `scrape_oi_heatmap_phase()` - 13 edges
9. `dominant_call` - 12 edges
10. `dominant_put` - 12 edges

## Surprising Connections (you probably didn't know these)
- `Switch between Intraday Volume and Open Interest.          Key insight from sc` --rationale_for--> `switch_to_view()`  [EXTRACTED]
  .claude/worktrees/eloquent-roentgen-aa050c/scraper/quikstrike_scraper.py → scraper/quikstrike_scraper.py
- `Extract data from all Highcharts charts on the page.` --rationale_for--> `extract_chart()`  [EXTRACTED]
  .claude/worktrees/eloquent-roentgen-aa050c/scraper/quikstrike_scraper.py → scraper/quikstrike_scraper.py
- `Get the header/subtitle text, with HTML tags stripped.` --rationale_for--> `extract_header()`  [EXTRACTED]
  .claude/worktrees/eloquent-roentgen-aa050c/scraper/quikstrike_scraper.py → scraper/quikstrike_scraper.py
- `Fetch futures price from yfinance for any asset (cached 60s).` --rationale_for--> `get_futures_price()`  [EXTRACTED]
  .claude/worktrees/eloquent-roentgen-aa050c/scraper/quikstrike_scraper.py → scraper/quikstrike_scraper.py
- `Convert chart data to text format compatible with the dashboard.` --rationale_for--> `chart_to_text()`  [EXTRACTED]
  .claude/worktrees/eloquent-roentgen-aa050c/scraper/quikstrike_scraper.py → scraper/quikstrike_scraper.py

## Communities (82 total, 5 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.1
Nodes (19): 1. สร้าง Oracle Cloud VM (ฟรี), 2. SSH เข้า VM แล้วรัน setup, 3. ตั้ง Credentials, 4. ตั้ง GitHub Push Access, 5. ทดสอบ, 6. ติดตั้ง Cron, code:bash (ssh ubuntu@<VM_IP>), code:bash (sudo -u scraper bash) (+11 more)

### Community 1 - "Community 1"
Cohesion: 0.16
Nodes (9): bool, GC_Vol2Vol_ATAS, StrikeData, Vol2VolDataSet, Vol2VolIndicator, HttpClient, Indicator, object (+1 more)

### Community 2 - "Community 2"
Cohesion: 0.08
Nodes (60): applyBiasHysteresis(), ASSET_PROFILES, biasDisplay(), buildBrokenEntry(), buildTradeSetup(), calcBreakdownRisk(), calcCharm(), calcDelta() (+52 more)

### Community 3 - "Community 3"
Cohesion: 0.14
Nodes (15): create_driver(), get_output_dir(), get_quikstrike_url(), main(), push_data_to_repo(), Build QuikStrike URL for a given asset., Get output directory for a given asset., Get output directory for a given asset. (+7 more)

### Community 4 - "Community 4"
Cohesion: 0.12
Nodes (18): classify_contracts(), discover_product_pid(), get_expiration_contracts(), is_error_page(), Check if the current page is a QuikStrike error page., Try to discover the correct QuikStrike product ID for an asset.          Strat, Scrape all contracts for one asset. Returns True if any data was scraped., Check if the current page is a QuikStrike error page. (+10 more)

### Community 5 - "Community 5"
Cohesion: 0.09
Nodes (56): applyBiasHysteresis(), ASSET_PROFILES, biasDisplay(), buildBrokenEntry(), buildTradeSetup(), calcBreakdownRisk(), calcCharm(), calcDelta() (+48 more)

### Community 6 - "Community 6"
Cohesion: 0.29
Nodes (7): _handle_disclaimer(), login_cme(), Navigate to QuikStrike → handle SSO login → handle disclaimer., Navigate to QuikStrike → handle SSO login → handle disclaimer., Accept the QuikStrike disclaimer page.          The disclaimer page has:, Accept the QuikStrike disclaimer page.          The disclaimer page has:, _try_auto_login()

### Community 7 - "Community 7"
Cohesion: 0.13
Nodes (16): extract_chart(), extract_header(), Scrape one view and save to file., Scrape one view and save to file., Switch between Intraday Volume and Open Interest.          Key insight from sc, Switch between Intraday Volume and Open Interest.          Key insight from sc, Switch between Intraday Volume and Open Interest.          Key insight from sc, Extract data from all Highcharts charts on the page. (+8 more)

### Community 8 - "Community 8"
Cohesion: 0.05
Nodes (53): asset, confidence, contract, contract_key, activity_vs_oi, call_oi, call_volume, intraday_volume (+45 more)

### Community 9 - "Community 9"
Cohesion: 0.2
Nodes (10): Scrape both Intraday + OI for one contract.          IMPORTANT: After selectin, Scrape both Intraday + OI for one contract.      IMPORTANT: After selecting a, Wait for page to be fully loaded (ASP.NET postback complete)., Wait for page to be fully loaded (ASP.NET postback complete)., Click a contract tab link using JavaScript click., Click a contract tab link using JavaScript click., Scrape both Intraday + OI for one contract.          IMPORTANT: After selectin, scrape_contract() (+2 more)

### Community 10 - "Community 10"
Cohesion: 0.33
Nodes (5): approve, matchCommandLine, chat.tools.terminal.autoApprove, /^cd \"c:\\\\Users\\\\kitkon\\\\\\.gemini\\\\antigravity\\\\playground\\\\vacant-exoplanet\" && python -c \"\nwith open\\('index\\.html', 'r', encoding='utf-8'\\) as f:\n    content = f\\.read\\(\\)\n\n# Find the script tag end and </head> markers\nmarker1 = '<script src=\\\\\"https://unpkg\\.com/lightweight-charts/dist/lightweight-charts\\.standalone\\.production\\.js\\\\\"></script>'\nmarker2 = '</head>'\n\nidx1 = content\\.index\\(marker1\\) \\+ len\\(marker1\\)\nidx2 = content\\.index\\(marker2\\)\n\n# Replace everything between the two markers with just a newline\nnew_content = content\\[:idx1\\] \\+ '\\\\n' \\+ content\\[idx2:\\]\n\nwith open\\('index\\.html', 'w', encoding='utf-8'\\) as f:\n    f\\.write\\(new_content\\)\nprint\\('Done'\\)\n\"\n$/, github.copilot.chat.anthropic.contextEditing.enabled

### Community 11 - "Community 11"
Cohesion: 0.22
Nodes (9): List, chart_to_text(), get_futures_price(), Fetch futures price from yfinance for any asset (cached 60s)., Fetch futures price from yfinance for any asset (cached 60s)., Convert chart data to text format compatible with the dashboard., Convert chart data to text format compatible with the dashboard., Fetch futures price from yfinance for any asset (cached 60s). (+1 more)

### Community 12 - "Community 12"
Cohesion: 0.4
Nodes (3): General Guidelines, GitHub Instructions, graphify

### Community 13 - "Community 13"
Cohesion: 0.05
Nodes (53): asset, confidence, contract, contract_key, activity_vs_oi, call_oi, call_volume, intraday_volume (+45 more)

### Community 14 - "Community 14"
Cohesion: 0.05
Nodes (53): asset, confidence, contract, contract_key, dte, future_price, generated_at, activity_vs_oi (+45 more)

### Community 19 - "Community 19"
Cohesion: 0.05
Nodes (53): asset, confidence, contract, contract_key, activity_vs_oi, call_oi, call_volume, intraday_volume (+45 more)

### Community 24 - "Community 24"
Cohesion: 0.05
Nodes (53): asset, confidence, contract, contract_key, dte, future_price, generated_at, note (+45 more)

### Community 25 - "Community 25"
Cohesion: 0.09
Nodes (30): asset, confidence, contract, contract_key, dte, future_price, generated_at, note (+22 more)

### Community 26 - "Community 26"
Cohesion: 0.21
Nodes (22): DateTime, analyze_contract_position(), _best(), _bias_label(), build_asset_position_bias(), _clamp(), _confidence_label(), _distance_payload() (+14 more)

### Community 27 - "Community 27"
Cohesion: 0.14
Nodes (14): _click_heatmap_expiration_tab(), _click_qs_top_tab(), _click_sidebar_heatmap_oi(), _dump_sidebar_diagnostics(), _ensure_call_put_combined(), _extract_heatmap_table(), Click a QuikStrike top-nav tab by visible label (e.g. 'Open Interest').     Qui, On the Open Interest page, click 'OI' under the 'Heatmap' sidebar.      Primar (+6 more)

### Community 28 - "Community 28"
Cohesion: 0.26
Nodes (10): asset, asset_name, contracts, generated_at, note, position_bias, label, method (+2 more)

### Community 29 - "Community 29"
Cohesion: 0.26
Nodes (10): asset, asset_name, contracts, generated_at, note, position_bias, label, method (+2 more)

### Community 30 - "Community 30"
Cohesion: 0.17
Nodes (12): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+4 more)

### Community 31 - "Community 31"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 32 - "Community 32"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 33 - "Community 33"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 34 - "Community 34"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 35 - "Community 35"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 36 - "Community 36"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 37 - "Community 37"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 38 - "Community 38"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 39 - "Community 39"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 40 - "Community 40"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 41 - "Community 41"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 42 - "Community 42"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 43 - "Community 43"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 44 - "Community 44"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 45 - "Community 45"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 46 - "Community 46"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 47 - "Community 47"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 48 - "Community 48"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 49 - "Community 49"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 50 - "Community 50"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 51 - "Community 51"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 52 - "Community 52"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 53 - "Community 53"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 54 - "Community 54"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 55 - "Community 55"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 56 - "Community 56"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 57 - "Community 57"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 58 - "Community 58"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 59 - "Community 59"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 60 - "Community 60"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 61 - "Community 61"
Cohesion: 0.18
Nodes (11): activity_vs_oi, call_oi, call_volume, intraday_volume, net_call_minus_put, put_oi, put_volume, side (+3 more)

### Community 62 - "Community 62"
Cohesion: 0.47
Nodes (10): pct, points, side, distance, distance, distance, distance, distance (+2 more)

### Community 63 - "Community 63"
Cohesion: 0.47
Nodes (10): pct, points, side, distance, distance, distance, distance, distance (+2 more)

### Community 64 - "Community 64"
Cohesion: 0.47
Nodes (10): pct, points, side, distance, distance, distance, distance, distance (+2 more)

### Community 65 - "Community 65"
Cohesion: 0.47
Nodes (10): pct, points, side, distance, distance, distance, distance, distance (+2 more)

### Community 66 - "Community 66"
Cohesion: 0.47
Nodes (10): pct, points, side, distance, distance, distance, distance, distance (+2 more)

### Community 67 - "Community 67"
Cohesion: 0.47
Nodes (10): pct, points, side, distance, distance, distance, distance, distance (+2 more)

### Community 68 - "Community 68"
Cohesion: 0.22
Nodes (8): asset, contract, dates, header, prefix, scrapedAt, strikes, underlying

### Community 69 - "Community 69"
Cohesion: 0.22
Nodes (8): asset, contract, dates, header, prefix, scrapedAt, strikes, underlying

### Community 70 - "Community 70"
Cohesion: 0.22
Nodes (8): asset, contract, dates, header, prefix, scrapedAt, strikes, underlying

### Community 71 - "Community 71"
Cohesion: 0.22
Nodes (8): asset, contract, dates, header, prefix, scrapedAt, strikes, underlying

### Community 72 - "Community 72"
Cohesion: 0.22
Nodes (8): asset, contract, dates, header, prefix, scrapedAt, strikes, underlying

### Community 73 - "Community 73"
Cohesion: 0.22
Nodes (8): asset, contract, dates, header, prefix, scrapedAt, strikes, underlying

### Community 75 - "Community 75"
Cohesion: 0.67
Nodes (3): debug_page(), Print comprehensive debug info about current page., Print comprehensive debug info about current page.

## Knowledge Gaps
- **677 isolated node(s):** `ASSET_PROFILES`, `CONFIG`, `state`, `STYLE_CONFIG`, `PreToolUse` (+672 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `walls` connect `Community 8` to `Community 32`, `Community 33`, `Community 34`, `Community 35`, `Community 31`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **Why does `walls` connect `Community 14` to `Community 41`, `Community 42`, `Community 43`, `Community 44`, `Community 45`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **Why does `walls` connect `Community 19` to `Community 46`, `Community 47`, `Community 48`, `Community 49`, `Community 50`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **What connects `ASSET_PROFILES`, `CONFIG`, `state` to the rest of the system?**
  _677 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.14 - nodes in this community are weakly interconnected._