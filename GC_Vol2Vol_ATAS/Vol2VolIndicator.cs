using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using System.Drawing;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Threading.Tasks;
using System.Windows.Media;
using ATAS.Indicators;
using ATAS.Indicators.Drawing;
using OFT.Rendering.Context;
using OFT.Rendering.Tools;
using Utils.Common.Logging;
using Color = System.Drawing.Color;

namespace GC_Vol2Vol_ATAS
{
    /// <summary>
    /// ATAS Custom Indicator: Gold Vol2Vol
    /// Fetches OI and Intraday data from GitHub (pageth/Vol2VolData)
    /// Draws round number lines every $25, OI histogram bars, and expected range labels.
    /// </summary>
    [DisplayName("Vol2Vol Gold - OI & Expected Range")]
    [Category("Custom")]
    [Description("Displays Vol2Vol expected range with OI bars for Gold (GC) futures.")]
    public class Vol2VolIndicator : Indicator
    {
        #region ===== Configuration =====

        private const string IntradayUrl = "https://raw.githubusercontent.com/pageth/Vol2VolData/main/IntradayData.txt";
        private const string OIUrl = "https://raw.githubusercontent.com/pageth/Vol2VolData/main/OIData.txt";

        [Display(Name = "Strike Interval ($)", GroupName = "Settings", Order = 10)]
        [Range(5, 100)]
        public int StrikeInterval { get; set; } = 25;

        [Display(Name = "Visible Range ($)", GroupName = "Settings", Order = 20)]
        [Range(50, 500)]
        public int VisibleRange { get; set; } = 300;

        [Display(Name = "Auto Refresh (sec)", GroupName = "Settings", Order = 30)]
        [Range(30, 600)]
        public int RefreshSeconds { get; set; } = 60;

        [Display(Name = "Line Color", GroupName = "Appearance", Order = 40)]
        public System.Windows.Media.Color LineColor { get; set; } = System.Windows.Media.Colors.Orange;

        [Display(Name = "Call OI Color", GroupName = "Appearance", Order = 50)]
        public System.Windows.Media.Color CallColor { get; set; } = System.Windows.Media.Colors.LightSkyBlue;

        [Display(Name = "Put OI Color", GroupName = "Appearance", Order = 60)]
        public System.Windows.Media.Color PutColor { get; set; } = System.Windows.Media.Colors.Orange;

        [Display(Name = "OI Bar Max Width (px)", GroupName = "Appearance", Order = 70)]
        [Range(50, 300)]
        public int OIBarMaxWidth { get; set; } = 150;

        [Display(Name = "Show Labels", GroupName = "Appearance", Order = 80)]
        public bool ShowLabels { get; set; } = true;

        #endregion

        #region ===== Data Structures =====

        private class StrikeData
        {
            public double Strike { get; set; }
            public int Call { get; set; }
            public int Put { get; set; }
            public double VolSettle { get; set; }
            public int Total => Call + Put;
        }

        private class Vol2VolDataSet
        {
            public string Header { get; set; } = "";
            public string Contract { get; set; } = "";
            public double DTE { get; set; }
            public double Underlying { get; set; }
            public double Change { get; set; }
            public string DataType { get; set; } = "";
            public List<StrikeData> Strikes { get; set; } = new();
        }

        #endregion

        #region ===== State =====

        private static readonly HttpClient _http = new();
        private Vol2VolDataSet? _intradayData;
        private Vol2VolDataSet? _oiData;
        private DateTime _lastFetch = DateTime.MinValue;
        private bool _isFetching = false;
        private readonly object _lockObj = new();
        private readonly List<LineTillTouch> _drawnLines = new();

        #endregion

        #region ===== Indicator Lifecycle =====

        protected override void OnCalculate(int bar, decimal value)
        {
            // Only process on the last bar
            if (bar != CurrentBar - 1)
                return;

            // Auto-refresh data
            if (!_isFetching && (DateTime.Now - _lastFetch).TotalSeconds >= RefreshSeconds)
            {
                _ = FetchDataAsync();
            }
        }

        protected override void OnRender(RenderContext context, DrawingLayerType layer)
        {
            if (layer != DrawingLayerType.AboveChart)
                return;

            Vol2VolDataSet? oiData;
            Vol2VolDataSet? intradayData;

            lock (_lockObj)
            {
                oiData = _oiData;
                intradayData = _intradayData;
            }

            if (oiData == null && intradayData == null)
                return;

            var underlying = oiData?.Underlying ?? intradayData?.Underlying ?? 0;
            if (underlying <= 0)
                return;

            // Draw round number lines
            DrawRoundNumberLines(context, underlying, intradayData);

            // Draw OI bars on left margin
            if (oiData != null)
            {
                DrawOIBars(context, oiData, underlying);
            }
        }

        #endregion

        #region ===== Data Fetching =====

        private async Task FetchDataAsync()
        {
            _isFetching = true;

            try
            {
                var intradayTask = _http.GetStringAsync(IntradayUrl + "?t=" + DateTimeOffset.UtcNow.ToUnixTimeSeconds());
                var oiTask = _http.GetStringAsync(OIUrl + "?t=" + DateTimeOffset.UtcNow.ToUnixTimeSeconds());

                await Task.WhenAll(intradayTask, oiTask);

                var newIntraday = ParseData(intradayTask.Result);
                var newOI = ParseData(oiTask.Result);

                lock (_lockObj)
                {
                    _intradayData = newIntraday;
                    _oiData = newOI;
                    _lastFetch = DateTime.Now;
                }

                // Trigger redraw
                RedrawChart();
            }
            catch (Exception ex)
            {
                this.LogError($"Vol2Vol fetch error: {ex.Message}");
            }
            finally
            {
                _isFetching = false;
            }
        }

        private Vol2VolDataSet? ParseData(string text)
        {
            if (string.IsNullOrWhiteSpace(text))
                return null;

            var lines = text.Trim().Split('\n');
            if (lines.Length < 2)
                return null;

            var result = new Vol2VolDataSet { Header = lines[0] };

            // Parse header: "Gold (OG|GC) OG2G6 (0.64 DTE) vs 4999.8 (+51.4) - Intraday Volume"
            var dteMatch = System.Text.RegularExpressions.Regex.Match(lines[0], @"\(([\d.]+)\s*DTE\)");
            var priceMatch = System.Text.RegularExpressions.Regex.Match(lines[0], @"vs\s+([\d.]+)");
            var changeMatches = System.Text.RegularExpressions.Regex.Matches(lines[0], @"\(([+-]?[\d.]+)\)");
            var typeMatch = System.Text.RegularExpressions.Regex.Match(lines[0], @"- (.+)$");
            var contractMatch = System.Text.RegularExpressions.Regex.Match(lines[0], @"\)\s+(\S+)\s+\(");

            if (dteMatch.Success)
                result.DTE = double.Parse(dteMatch.Groups[1].Value, CultureInfo.InvariantCulture);
            if (priceMatch.Success)
                result.Underlying = double.Parse(priceMatch.Groups[1].Value, CultureInfo.InvariantCulture);
            if (changeMatches.Count >= 2)
            {
                var last = changeMatches[changeMatches.Count - 1];
                result.Change = double.Parse(last.Groups[1].Value, CultureInfo.InvariantCulture);
            }
            if (typeMatch.Success)
                result.DataType = typeMatch.Groups[1].Value.Trim();
            if (contractMatch.Success)
                result.Contract = contractMatch.Groups[1].Value;

            // Parse strike rows (skip header row at index 1)
            for (int i = 2; i < lines.Length; i++)
            {
                var parts = lines[i].Split(',');
                if (parts.Length < 4) continue;

                if (double.TryParse(parts[0], NumberStyles.Any, CultureInfo.InvariantCulture, out var strike) &&
                    int.TryParse(parts[1], out var call) &&
                    int.TryParse(parts[2], out var put) &&
                    double.TryParse(parts[3], NumberStyles.Any, CultureInfo.InvariantCulture, out var vs))
                {
                    result.Strikes.Add(new StrikeData
                    {
                        Strike = strike,
                        Call = call,
                        Put = put,
                        VolSettle = vs,
                    });
                }
            }

            return result;
        }

        #endregion

        #region ===== Drawing =====

        private void DrawRoundNumberLines(RenderContext context, double underlying, Vol2VolDataSet? intradayData)
        {
            var chartInfo = ChartInfo;
            if (chartInfo == null) return;

            // Build vol settle lookup
            var vsMap = new Dictionary<double, double>();
            if (intradayData?.Strikes != null)
            {
                foreach (var s in intradayData.Strikes)
                    vsMap[s.Strike] = s.VolSettle;
            }

            double dte = intradayData?.DTE ?? 1;
            double minStrike = underlying - VisibleRange;
            double maxStrike = underlying + VisibleRange;
            double startStrike = Math.Ceiling(minStrike / StrikeInterval) * StrikeInterval;

            var pen = new RenderPen(
                new RenderColor(LineColor.R, LineColor.G, LineColor.B, LineColor.A),
                1,
                RenderPenStyle.Dash
            );

            var labelFont = new RenderFont("Segoe UI", 9);
            var labelBrush = new RenderColor(LineColor.R, LineColor.G, LineColor.B, 200);

            for (double strike = startStrike; strike <= maxStrike; strike += StrikeInterval)
            {
                int y = chartInfo.PriceChartContainer.GetYByPrice((decimal)strike);

                if (y < 0 || y > context.ClipBounds.Height)
                    continue;

                // Draw horizontal line
                context.DrawLine(pen, 0, y, context.ClipBounds.Width, y);

                // Calculate expected range
                double volSettle = InterpolateVolSettle(vsMap, strike);
                string labelText;

                if (volSettle > 0)
                {
                    double expectedRange = underlying * volSettle * Math.Sqrt(dte / 365.0);
                    double expectedLevel = underlying - expectedRange;
                    labelText = $"{strike:F0} ({expectedLevel:F1})";
                }
                else
                {
                    labelText = $"{strike:F0}";
                }

                if (ShowLabels)
                {
                    // Draw label to the right of center
                    int labelX = context.ClipBounds.Width / 2 + 40;
                    context.DrawString(labelText, labelFont, labelBrush, labelX, y - 7);
                }
            }
        }

        private double InterpolateVolSettle(Dictionary<double, double> vsMap, double strike)
        {
            if (vsMap.TryGetValue(strike, out var vs) && vs > 0)
                return vs;

            double lower = Math.Floor(strike / 5) * 5;
            double upper = lower + 5;

            vsMap.TryGetValue(lower, out var lowerVS);
            vsMap.TryGetValue(upper, out var upperVS);

            if (lowerVS > 0 && upperVS > 0)
                return lowerVS + (upperVS - lowerVS) * ((strike - lower) / 5.0);

            return lowerVS > 0 ? lowerVS : upperVS;
        }

        private void DrawOIBars(RenderContext context, Vol2VolDataSet oiData, double underlying)
        {
            var chartInfo = ChartInfo;
            if (chartInfo == null || oiData.Strikes == null) return;

            // Filter visible strikes
            var visible = oiData.Strikes
                .Where(s => s.Strike >= underlying - VisibleRange &&
                            s.Strike <= underlying + VisibleRange &&
                            s.Total > 0)
                .ToList();

            if (!visible.Any()) return;

            int maxOI = visible.Max(s => Math.Max(s.Call, s.Put));
            if (maxOI <= 0) maxOI = 1;

            var callBrush = new RenderColor(CallColor.R, CallColor.G, CallColor.B, 180);
            var putBrush = new RenderColor(PutColor.R, PutColor.G, PutColor.B, 180);
            var textFont = new RenderFont("Segoe UI", 8);
            var textColor = new RenderColor(200, 200, 200, 180);

            int barHeight = 8;
            int leftMargin = 5;

            foreach (var s in visible)
            {
                int y = chartInfo.PriceChartContainer.GetYByPrice((decimal)s.Strike);
                if (y < 0 || y > context.ClipBounds.Height)
                    continue;

                int callWidth = (int)((double)s.Call / maxOI * OIBarMaxWidth);
                int putWidth = (int)((double)s.Put / maxOI * OIBarMaxWidth);

                // Draw call bar (top half)
                if (callWidth > 0)
                {
                    context.FillRectangle(
                        callBrush,
                        new Rectangle(leftMargin, y - barHeight, callWidth, barHeight - 1)
                    );
                }

                // Draw put bar (bottom half)
                if (putWidth > 0)
                {
                    context.FillRectangle(
                        putBrush,
                        new Rectangle(leftMargin, y + 1, putWidth, barHeight - 1)
                    );
                }

                // Draw total OI label
                int totalWidth = Math.Max(callWidth, putWidth);
                context.DrawString(
                    s.Total.ToString(),
                    textFont,
                    textColor,
                    leftMargin + totalWidth + 4,
                    y - 5
                );
            }
        }

        private void RedrawChart()
        {
            // Force ATAS to redraw
            OnPropertyChanged(nameof(ShowLabels));
        }

        #endregion
    }
}
