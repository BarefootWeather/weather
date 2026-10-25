'use strict';
const byId = id => document.getElementById(id);
const controls = ['metric', 'horizon', 'days'];
let currentData = null;
let selectedSource = '';

function when(value) {
  if (value == null) return 'Never';
  return new Date(value * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function value(value, digits = 1) { return value == null ? '—' : Number(value).toFixed(digits); }
function elt(tag, text, className) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = String(text);
  if (className) n.className = className;
  return n;
}
function isoAge(seconds) {
  if (seconds == null) return 'No observations yet';
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - seconds) / 60));
  return minutes <= 1 ? 'Latest: just now' : minutes < 120 ? `Latest: ${minutes} minutes ago` : `Latest: ${when(seconds)}`;
}
function healthCard(item) {
  const box = elt('div', null, 'health');
  const title = elt('div', null, 'health-title');
  title.append(elt('span', item.source));
  const ok = !!item.last_success_at && !item.last_error;
  title.append(elt('span', ok ? 'LAST FETCH OK' : 'CHECK SOURCE', 'health-state' + (ok ? '' : ' error')));
  box.append(title, elt('div', `Last successful capture: ${when(item.last_success_at)}`, 'health-time'));
  if (item.last_error) box.append(elt('div', item.last_error, 'health-error'));
  return box;
}
async function json(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}
async function loadStatus() {
  const s = await json('./data/status.json');
  byId('site-name').textContent = s.site;
  const o = s.latest || {};
  byId('current-temp').textContent = value(o.temperature_f);
  byId('current-humidity').textContent = value(o.humidity_pct, 0);
  byId('current-wind').textContent = value(o.wind_mph);
  byId('obs-count').textContent = Number(s.counts.observations).toLocaleString();
  byId('snapshot-count').textContent = `${Number(s.counts.forecasts).toLocaleString()} forecast rows archived`;
  byId('last-seen').textContent = isoAge(o.observed_at);
  byId('status-label').textContent = s.mode === 'demo' ? 'SIMULATED DATA' : (o.observed_at ? ((Date.now()/1000-o.observed_at) <= 1200 ? 'Recent station reading' : 'Station reading stale') : 'Awaiting first observation');
  byId('demo-banner').hidden = s.mode !== 'demo';
  const health = byId('source-health');
  health.replaceChildren();
  if (!s.sources.length) health.append(elt('p', 'No sources have been collected yet. Check the scheduled GitHub Action.', 'subtle'));
  s.sources.forEach(item => health.append(healthCard(item)));
  if (!s.configured.ecowitt && s.mode !== 'demo') health.prepend(elt('p', 'Missing Ecowitt credentials in GitHub Actions secrets.', 'health-error'));
  if (!s.configured.coordinates && s.mode !== 'demo') health.prepend(elt('p', 'Missing station coordinates in GitHub Actions secrets.', 'health-error'));
}
async function loadComparison() {
  const query = new URLSearchParams(Object.fromEntries(controls.map(id => [id, byId(id).value])));
  const data = await json('./data/comparisons/' + query.get('metric') + '-' + query.get('horizon') + '-' + query.get('days') + '.json');
  currentData = data;
  byId('match-count').textContent = data.is_comparable ? `${data.matched_hours} matched verified hours in this comparison` : 'Collecting shared verification hours';
  byId('mae-unit').textContent = `(${data.unit})`;
  const body = byId('leaderboard');
  body.replaceChildren();
  if (!data.providers.length) {
    const row = elt('tr');
    const td = elt('td', 'No matching forecast observations yet. Keep the collector running.');
    td.colSpan = 6;
    row.append(td);
    body.append(row);
  }
  data.providers.forEach(result => {
    const row = elt('tr');
    if (result.rank === 1) row.className = 'winner';
    const values = [result.rank || '—', result.provider,
      result.mae == null ? '—' : value(result.mae, 2),
      result.bias == null ? '—' : (result.bias >= 0 ? '+' : '') + value(result.bias, 2),
      result.rmse == null ? '—' : value(result.rmse, 2),
      result.sample_count || `0 (${result.available_hours} available)`];
    values.forEach((entry, i) => {
      const cell = elt('td', entry);
      if (i === 0) cell.className = result.rank ? 'rank' : 'neutral';
      if (i === 3 && result.bias != null) cell.className = result.bias > 0 ? 'positive' : 'negative';
      row.append(cell);
    });
    body.append(row);
  });
  byId('leaderboard-note').textContent = data.warning || `Ranking is based on ${data.matched_hours} identical observation hours across eligible providers. Positive bias means forecasts were too high. Small sample sizes are provisional.`;
  const select = byId('source');
  const available = data.providers.filter(p => p.rank != null).map(p => p.provider);
  if (!available.includes(selectedSource)) selectedSource = available[0] || '';
  select.replaceChildren();
  if (!available.length) select.append(elt('option', 'No verified providers'));
  available.forEach(p => { const opt = elt('option', p); opt.value = p; select.append(opt); });
  select.value = selectedSource;
  drawChart();
}
function svg(tag, attrs, content) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, String(v)));
  if (content != null) e.textContent = content;
  return e;
}
function drawChart() {
  const chart = byId('chart');
  chart.replaceChildren();
  if (!currentData || !currentData.chart.length || !selectedSource) {
    byId('empty-chart').hidden = false;
    return;
  }
  byId('empty-chart').hidden = true;
  const points = currentData.chart.filter(p => p.forecasts[selectedSource] != null && p.actual != null);
  if (points.length < 2) { byId('empty-chart').hidden = false; return; }
  const W = 960, H = 300, left = 54, right = 16, top = 20, bottom = 42;
  const all = points.flatMap(p => [p.actual, p.forecasts[selectedSource]]);
  let min = Math.min(...all), max = Math.max(...all);
  const pad = Math.max((max - min) * 0.18, currentData.metric === 'humidity_pct' ? 5 : 2);
  min -= pad; max += pad;
  const start = points[0].valid_at, end = points[points.length - 1].valid_at;
  const x = p => left + (p.valid_at - start) / (end - start) * (W - left - right);
  const y = v => top + (max - v) / (max - min) * (H - top - bottom);
  for (let i = 0; i <= 4; i++) {
    const py = top + i * (H - top - bottom) / 4;
    chart.append(svg('line', {x1:left,y1:py,x2:W-right,y2:py,stroke:'#293c4b','stroke-width':1}));
    chart.append(svg('text', {x:left-12,y:py+4,fill:'#8297a8','font-size':12,'text-anchor':'end'}, (max-(max-min)*i/4).toFixed(1)));
  }
  const path = accessor => points.map((p,i) => (i?'L':'M')+x(p).toFixed(1)+','+y(accessor(p)).toFixed(1)).join(' ');
  chart.append(svg('path', {d:path(p => p.actual),fill:'none',stroke:'#66d8c0','stroke-width':2.6,'stroke-linejoin':'round'}));
  chart.append(svg('path', {d:path(p => p.forecasts[selectedSource]),fill:'none',stroke:'#8aa4ff','stroke-width':2.4,'stroke-dasharray':'6 3','stroke-linejoin':'round'}));
  [0, Math.floor((points.length-1)/2), points.length-1].forEach(i => {
    chart.append(svg('text', {x:x(points[i]), y:H-12,fill:'#8297a8','font-size':12,'text-anchor':i===0?'start':i===points.length-1?'end':'middle'}, when(points[i].valid_at)));
  });
}
async function refresh() {
  try {
    await Promise.all([loadStatus(), loadComparison()]);
  } catch (e) {
    byId('status-label').textContent = 'Error loading published weather data';
    byId('leaderboard-note').textContent = 'Could not load dashboard: ' + e.message;
  }
}
controls.forEach(id => byId(id).addEventListener('change', loadComparison));
byId('source').addEventListener('change', e => { selectedSource = e.target.value; drawChart(); });
refresh();
setInterval(refresh, 120000);
