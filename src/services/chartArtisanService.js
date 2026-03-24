/**
 * chartArtisanService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Layer A: Hybrid Artisan chart generator.
 *
 * Strategy:
 *   1. Deterministic builder (instant) — covers bar, line, area, pie, donut,
 *      horizontal_bar, stacked_bar, grouped_bar, histogram, scatter, radar.
 *   2. LLM fallback — for chart types the builder doesn't support, or when
 *      the user explicitly requests AI generation (forceAI=true).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { callLLM } from './aiEmployeeLLMService.js';
import { getResolvedArtisanModel } from './modelConfigService.js';

const MAX_CACHE_SIZE = 50;
const CACHE_VERSION = 5;

const _artisanCache = new Map();

function cacheKey(chart, title, isAI) {
  const dataFp = JSON.stringify(chart.data?.slice(0, 5)) + (chart.data?.length || 0);
  return `v${CACHE_VERSION}|${isAI ? 'ai' : 'det'}|${chart.type}|${chart.xKey}|${chart.yKey}|${dataFp}|${title || ''}`;
}

export function getCachedArtisan(chart, title) {
  // Check deterministic cache first, then AI cache
  return _artisanCache.get(cacheKey(chart, title, false))
    || _artisanCache.get(cacheKey(chart, title, true))
    || null;
}

export function clearCachedArtisan(chart, title) {
  _artisanCache.delete(cacheKey(chart, title, false));
  _artisanCache.delete(cacheKey(chart, title, true));
}

function cacheResult(key, result) {
  if (_artisanCache.size >= MAX_CACHE_SIZE) {
    const oldest = _artisanCache.keys().next().value;
    _artisanCache.delete(oldest);
  }
  _artisanCache.set(key, result);
}

// ── Color palette ───────────────────────────────────────────────────────────

const GRADIENT_COLORS = [
  { top: '#60a5fa', bottom: '#2563eb' },
  { top: '#a78bfa', bottom: '#7c3aed' },
  { top: '#34d399', bottom: '#059669' },
  { top: '#fbbf24', bottom: '#d97706' },
  { top: '#f87171', bottom: '#dc2626' },
  { top: '#22d3ee', bottom: '#0891b2' },
  { top: '#f472b6', bottom: '#db2777' },
  { top: '#818cf8', bottom: '#4f46e5' },
];

const SOLID_COLORS = GRADIENT_COLORS.map(g => g.bottom);

// Chart types the deterministic builder supports
const DETERMINISTIC_TYPES = new Set([
  'bar', 'histogram', 'horizontal_bar', 'line', 'area',
  'pie', 'donut', 'stacked_bar', 'grouped_bar', 'scatter', 'radar',
]);

// ── Chart type → Chart.js type mapping ──────────────────────────────────────

function resolveChartJsType(type) {
  const map = {
    bar: 'bar', histogram: 'bar', horizontal_bar: 'bar',
    line: 'line', area: 'line',
    pie: 'pie', donut: 'doughnut',
    scatter: 'scatter', bubble: 'bubble',
    stacked_bar: 'bar', grouped_bar: 'bar',
    radar: 'radar',
  };
  return map[type] || 'bar';
}

// ── Deterministic HTML builder ──────────────────────────────────────────────

function buildArtisanHtml(chart, { title } = {}) {
  const { type, data, xKey, yKey, series, referenceLines, xAxisLabel, yAxisLabel, label } = chart;
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  const labels = data.map(d => d[xKey]);
  const chartJsType = resolveChartJsType(type);
  const isHorizontal = type === 'horizontal_bar';
  const isPie = type === 'pie' || type === 'donut';
  const isArea = type === 'area';
  const isStacked = type === 'stacked_bar';

  const seriesKeys = Array.isArray(series) && series.length > 0 ? series : [yKey];
  const datasets = seriesKeys.map((key, i) => {
    const color = GRADIENT_COLORS[i % GRADIENT_COLORS.length];
    const values = data.map(d => Number(d[key]) || 0);

    if (isPie) {
      return {
        data: values,
        backgroundColor: data.map((_, j) => SOLID_COLORS[j % SOLID_COLORS.length]),
        borderWidth: 2,
        borderColor: isDark ? '#0f172a' : '#ffffff',
        hoverOffset: 8,
      };
    }

    const base = {
      label: seriesKeys.length === 1 ? (label || key) : key,
      data: values,
      _gradientTop: color.top,
      _gradientBottom: color.bottom,
      borderRadius: 8,
      borderSkipped: false,
      barPercentage: 0.7,
      categoryPercentage: 0.8,
    };

    if (chartJsType === 'line') {
      Object.assign(base, {
        borderColor: color.bottom,
        borderWidth: 2.5,
        pointBackgroundColor: '#fff',
        pointBorderColor: color.bottom,
        pointBorderWidth: 2,
        pointRadius: data.length > 20 ? 0 : 3,
        pointHoverRadius: 5,
        tension: 0.4,
        fill: isArea ? 'origin' : false,
        _areaFill: isArea,
      });
    }

    if (chartJsType === 'radar') {
      Object.assign(base, {
        borderColor: color.bottom,
        backgroundColor: color.bottom + '30',
        borderWidth: 2,
        pointBackgroundColor: color.bottom,
      });
    }

    if (type === 'scatter') {
      base.backgroundColor = color.bottom + 'aa';
      base.borderColor = color.bottom;
      base.pointRadius = 5;
      base.data = data.map(d => ({ x: Number(d[xKey]) || 0, y: Number(d[yKey]) || 0 }));
    }

    return base;
  });

  // Annotations
  const annotations = {};
  if (referenceLines?.length > 0 && !isPie) {
    referenceLines.slice(0, 3).forEach((ref, i) => {
      annotations[`ref${i}`] = {
        type: 'line', scaleID: isHorizontal ? 'x' : 'y', value: ref.value,
        borderColor: ref.color || '#94a3b8', borderDash: [6, 4], borderWidth: 1.5,
        label: { display: true, content: `${ref.label || ''}: ${ref.value}`, position: 'end', backgroundColor: 'transparent', color: '#94a3b8', font: { size: 10 } },
      };
    });
  }

  if (!referenceLines?.length && !isPie && seriesKeys.length === 1 && type !== 'scatter' && type !== 'radar') {
    const values = data.map(d => Number(d[yKey])).filter(v => !isNaN(v));
    if (values.length > 0) {
      const mean = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
      annotations.autoMean = {
        type: 'line', scaleID: isHorizontal ? 'x' : 'y', value: mean,
        borderColor: '#94a3b8', borderDash: [6, 4], borderWidth: 1.5,
        label: { display: true, content: `Avg: ${mean.toLocaleString()}`, position: 'end', backgroundColor: 'transparent', color: '#94a3b8', font: { size: 10 } },
      };
    }
  }

  const chartTitle = title || chart.title || '';
  const bg = isDark ? '#0f172a' : '#ffffff';
  const textColor = isDark ? '#e2e8f0' : '#1e293b';
  const subTextColor = '#94a3b8';
  const gridColor = isDark ? '#1e293b' : '#f1f5f9';
  const tooltipBg = isDark ? '#1e293b' : '#ffffff';
  const tooltipText = isDark ? '#e2e8f0' : '#1e293b';
  const tooltipBorder = isDark ? '#334155' : '#e2e8f0';
  const hasAnnotations = Object.keys(annotations).length > 0;

  const config = {
    type: chartJsType,
    data: { labels: type === 'scatter' ? undefined : labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: isHorizontal ? 'y' : 'x',
      layout: { padding: { top: 8, right: 16, bottom: 8, left: 8 } },
      plugins: {
        legend: {
          display: seriesKeys.length > 1 || isPie,
          position: isPie ? 'bottom' : 'top',
          labels: { color: subTextColor, font: { size: 11 }, usePointStyle: true, pointStyle: 'circle', padding: 16 },
        },
        tooltip: {
          backgroundColor: tooltipBg, titleColor: tooltipText, bodyColor: tooltipText,
          borderColor: tooltipBorder, borderWidth: 1, cornerRadius: 8, padding: 12,
          titleFont: { weight: 'bold', size: 12 }, bodyFont: { size: 11 }, displayColors: true, boxPadding: 4,
          callbacks: { label: null }, // placeholder, will be set in script
        },
        annotation: hasAnnotations ? { annotations } : undefined,
      },
      scales: isPie || type === 'radar' ? undefined : {
        x: {
          display: true, stacked: isStacked,
          grid: { display: false },
          ticks: { color: subTextColor, font: { size: 11 }, maxRotation: labels.some(l => String(l).length > 8) ? 35 : 0 },
          title: xAxisLabel ? { display: true, text: xAxisLabel, color: subTextColor, font: { size: 12 } } : undefined,
        },
        y: {
          display: true, stacked: isStacked,
          grid: { color: gridColor, drawBorder: false },
          ticks: { color: subTextColor, font: { size: 11 } },
          title: yAxisLabel ? { display: true, text: yAxisLabel, color: subTextColor, font: { size: 12 } } : undefined,
        },
      },
      animation: { duration: 800, easing: 'easeOutQuart' },
    },
  };

  if (type === 'donut') config.options.cutout = '60%';

  // Remove the null callback placeholder before serializing
  const tooltipCallbackPlaceholder = '"label":null';
  const configJson = JSON.stringify(config).replace(tooltipCallbackPlaceholder,
    '"label":function(ctx){return " "+ctx.dataset.label+": "+ctx.parsed.y.toLocaleString()}'
  );

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:${bg};font-family:system-ui,-apple-system,sans-serif;overflow:hidden;height:auto}
body{padding:20px 24px 16px}
h2{font-size:16px;font-weight:700;color:${textColor};margin-bottom:16px;line-height:1.4}
.chart-wrap{position:relative;width:100%;height:320px;overflow:hidden}
canvas{max-height:320px}
${type === 'donut' ? `.donut-center{position:absolute;top:45%;left:50%;transform:translate(-50%,-50%);text-align:center;pointer-events:none}
.donut-total{font-size:22px;font-weight:700;color:${textColor}}
.donut-label{font-size:10px;color:${subTextColor};margin-top:2px}` : ''}
</style>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"><\/script>
${hasAnnotations ? '<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3/dist/chartjs-plugin-annotation.min.js"><\/script>' : ''}
</head>
<body>
${chartTitle ? `<h2>${escapeHtml(chartTitle)}</h2>` : ''}
<div class="chart-wrap">
<canvas id="c"></canvas>
${type === 'donut' ? `<div class="donut-center"><div class="donut-total" id="dt"></div><div class="donut-label">${escapeHtml(label || 'Total')}</div></div>` : ''}
</div>
<script>
window.addEventListener('load',function(){
  var cfg = ${configJson};
  var canvas = document.getElementById('c');
  var ctx = canvas.getContext('2d');
  var h = canvas.parentElement.offsetHeight;

  cfg.data.datasets.forEach(function(ds){
    if(ds._gradientTop && ds._gradientBottom){
      var g = ctx.createLinearGradient(0,0,${isHorizontal ? 'canvas.parentElement.offsetWidth,0' : '0,h'});
      g.addColorStop(0, ds._gradientTop);
      g.addColorStop(1, ds._gradientBottom);
      ds.backgroundColor = g;
      if(ds._areaFill){
        var gf = ctx.createLinearGradient(0,0,0,h);
        gf.addColorStop(0, ds._gradientTop+'4D');
        gf.addColorStop(1, ds._gradientBottom+'08');
        ds.backgroundColor = gf;
      }
      delete ds._gradientTop;
      delete ds._gradientBottom;
      delete ds._areaFill;
    }
  });

  ${hasAnnotations ? "if(window['chartjs-plugin-annotation'])Chart.register(window['chartjs-plugin-annotation']);" : ''}

  new Chart(ctx, cfg);

  ${type === 'donut' ? `var total=cfg.data.datasets[0].data.reduce(function(a,b){return a+b},0);document.getElementById('dt').textContent=total>=1000?(total/1000).toFixed(1)+'K':total.toLocaleString();` : ''}

  window.addEventListener('message',function(e){if(e.data&&e.data.type==='theme-change')location.reload()});
});
<\/script>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── LLM-based generation (fallback for unsupported types) ───────────────────

const LLM_SYSTEM_PROMPT = `You are a senior frontend engineer. Generate a self-contained HTML document that renders a chart using Chart.js v4.

RULES:
- Load Chart.js: <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
- Put chart code in window.addEventListener('load', function(){ ... })
- Do NOT use import/export or type="module"
- Use gradient fills (ctx.createLinearGradient), rounded corners, modern color palette
- Light mode by default (white bg), check window.__ARTISAN_DARK__ for dark mode
- After render: window.parent.postMessage({type:'chart-height',height:document.body.scrollHeight},'*')
- Output ONLY the HTML. No markdown fences.`;

async function generateWithLLM(chart, { title } = {}) {
  const { provider: artisanProvider, model: artisanModel } = getResolvedArtisanModel();

  const compactData = chart.data.slice(0, 50);
  const prompt = `Generate a beautiful ${chart.type} chart HTML:\n${JSON.stringify({
    chartType: chart.type, xAxis: chart.xKey, yAxis: chart.yKey,
    title: title || chart.title || '',
    dataPoints: compactData, totalRows: chart.data.length,
    series: chart.series || undefined,
  })}`;

  const { text, provider, model } = await callLLM({
    taskType: 'chart_artisan',
    systemPrompt: LLM_SYSTEM_PROMPT,
    prompt,
    temperature: 0.4,
    maxTokens: 4096,
    jsonMode: false,
    modelOverride: { provider: artisanProvider, model_name: artisanModel },
  });

  let html = (text || '').trim();
  if (!html) throw new Error(`${provider || artisanProvider} returned empty content`);
  if (html.startsWith('```')) html = html.replace(/^```(?:html)?\n?/, '').replace(/\n?```$/, '');
  if (!html.includes('<')) throw new Error('LLM returned non-HTML content');

  // Fix common LLM mistakes
  html = html.replace(/<script[^>]*type\s*=\s*["']module["'][^>]*>/gi, '<script>');
  html = html.replace(/import\s+\{[^}]*\}\s+from\s+['"][^'"]*['"];?/gi, '');

  // Inject theme
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  html = html.replace('</head>', `<script>window.__ARTISAN_DARK__=${isDark}<\/script>\n</head>`);

  // Inject full data if truncated
  if (chart.data.length > 50) {
    html = html.replace('</head>', `<script>window.__CHART_FULL_DATA__=${JSON.stringify(chart.data)}<\/script>\n</head>`);
  }

  return { html, provider, model };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate an Artisan chart.
 * Uses deterministic builder for supported types, LLM for others.
 *
 * @param {object} chart - Chart spec { type, data, xKey, yKey, ... }
 * @param {object} [context] - { title, summary }
 * @param {object} [options] - { forceAI: bool } force LLM generation
 * @returns {Promise<{ html: string, provider: string, model: string }>}
 */
export async function generateArtisanChart(chart, { title, summary } = {}, { forceAI = false } = {}) {
  if (!chart?.type || !Array.isArray(chart?.data)) {
    throw new Error('Invalid chart spec for artisan generation');
  }

  const useAI = forceAI || !DETERMINISTIC_TYPES.has(chart.type);
  const key = cacheKey(chart, title, useAI);
  const cached = _artisanCache.get(key);
  if (cached) return cached;

  let result;
  if (useAI) {
    result = await generateWithLLM(chart, { title });
  } else {
    const html = buildArtisanHtml(chart, { title });
    result = { html, provider: 'local', model: 'deterministic' };
  }

  cacheResult(key, result);
  return result;
}
