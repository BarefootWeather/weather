'use strict';
const byId = id => document.getElementById(id);
const controls = ['metric', 'horizon', 'days'];
let currentData = null;
let currentStatus = null;
let selectedSource = '';
let comparisonRequest = 0;
let statusRequest = 0;
let statusError = false;
let comparisonLoading = true;
let comparisonError = '';
const collectingMessage = 'We’re saving the forecasts as they arrive. Once we have station readings for those same hours, we’ll show how they compare.';
const rainfallMethodMessage = 'Rain only, not snow. Station amounts are estimates from archived counters; upload timing can differ from measurement timing. Matching counters on either side of an hour boundary let us use that hour without interpolation. Rain in that gap leaves the hour out, so some rainy periods won’t appear. Times mark the hour’s end; forecasts are saved before it starts.';

function when(value) {
  if (value == null) return 'Not yet';
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
  if (seconds == null) return 'No station readings yet';
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - seconds) / 60));
  return minutes <= 1 ? 'Latest: just now' : minutes < 120 ? `Latest: ${minutes} minutes ago` : `Latest: ${when(seconds)}`;
}
function healthCard(item) {
  const box = elt('div', null, 'health');
  const title = elt('div', null, 'health-title');
  title.append(elt('span', item.source));
  const limit = item.source === 'Ecowitt WS90' ? 1200 : item.source === 'Rainfall history' ? 3600 : 8 * 3600;
  const stale = item.last_success_at != null && Date.now() / 1000 - item.last_success_at > limit;
  const state = item.last_error ? 'UPDATE FAILED' : item.last_success_at == null ? 'WAITING FOR FIRST UPDATE' : stale ? 'NO RECENT UPDATE' : 'LAST UPDATE OK';
  title.append(elt('span', state, 'health-state' + (item.last_error ? ' error' : item.last_success_at == null ? ' pending' : stale ? ' stale' : '')));
  box.append(title, elt('div', `Last received: ${when(item.last_success_at)}`, 'health-time'));
  if (item.last_error) box.append(elt('div', 'We couldn’t get the latest update.', 'health-error'));
  return box;
}
async function json(path) {
  const response = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}
async function loadStatus() {
  const request = ++statusRequest;
  let s;
  try {
    s = await json('./data/status.json');
  } catch (error) {
    if (request !== statusRequest) return;
    statusError = true;
    byId('status-label').textContent = 'Couldn’t check for updates';
    if (!currentStatus) {
      const option = elt('option', 'Forecast updates unavailable');
      option.value = '';
      byId('source').replaceChildren(option);
      byId('source').disabled = true;
    }
    drawChart();
    return;
  }
  if (request !== statusRequest) return;
  statusError = false;
  currentStatus = s;
  byId('site-name').textContent = s.site;
  const o = s.latest || {};
  byId('current-temp').textContent = value(o.temperature_f);
  byId('current-humidity').textContent = value(o.humidity_pct, 0);
  byId('current-wind').textContent = value(o.wind_mph);
  byId('current-rain').textContent = value(o.rain_daily_in, 2);
  byId('rain-period').textContent = o.rain_daily_in == null ? 'Daily total unavailable' : 'Station day total';
  byId('rain-rate').textContent = o.rain_rate_in_hr == null ? 'Reported rate unavailable' : `Reported rate: ${value(o.rain_rate_in_hr, 2)} in/hr`;
  byId('obs-count').textContent = Number(s.counts.observations).toLocaleString();
  byId('snapshot-count').textContent = `${Number(s.counts.forecasts).toLocaleString()} hourly forecast entries saved`;
  byId('last-seen').textContent = isoAge(o.observed_at);
  byId('status-label').textContent = s.mode === 'demo' ? 'DEMO READINGS' : (o.observed_at ? ((Date.now()/1000-o.observed_at) <= 1200 ? 'Station updated recently' : 'No recent station reading') : 'Waiting for our first reading');
  byId('demo-banner').hidden = s.mode !== 'demo';
  const health = byId('source-health');
  health.replaceChildren();
  if (!s.sources.length) health.append(elt('p', 'We’re waiting for the first station and forecast updates.', 'subtle'));
  s.sources.forEach(item => health.append(healthCard(item)));
  if (!s.configured.ecowitt && s.mode !== 'demo') health.prepend(elt('p', 'Our station connection hasn’t been set up yet.', 'health-error'));
  if (!s.configured.coordinates && s.mode !== 'demo') health.prepend(elt('p', 'The forecast location hasn’t been set up yet.', 'health-error'));
  updateSources();
  renderSnapshot();
  if (currentData) renderLeaderboard();
  drawChart();
}
function renderSnapshot() {
  const grid = byId('snapshot-values');
  grid.replaceChildren();
  const metric = byId('snapshot-metric').value || 'temperature_f';
  const snapshot = currentStatus?.snapshot?.[metric];
  if (!currentStatus || !snapshot || snapshot.observed_at == null || snapshot.station == null) {
    byId('snapshot-time').textContent = currentStatus ? 'We’re waiting for a station reading for this measurement.' : 'Loading the latest comparison…';
    return;
  }
  const unit = {temperature_f: '°F', humidity_pct: '%', wind_mph: 'mph', rain_in: 'in'}[metric];
  const digits = metric === 'rain_in' ? 3 : metric === 'humidity_pct' ? 0 : 1;
  const offset = snapshot.forecast_at == null ? null : Math.round(Math.abs(snapshot.forecast_at - snapshot.observed_at) / 60);
  const timing = offset ? ` (${offset} ${offset === 1 ? 'minute' : 'minutes'} ${snapshot.forecast_at > snapshot.observed_at ? 'after' : 'before'} the reading)` : '';
  byId('snapshot-time').textContent = `${metric === 'rain_in' ? 'Station hour ending' : 'Station reading'} ${when(snapshot.observed_at)}${snapshot.forecast_at == null ? ' · No forecast hour is close enough to match.' : ` · Forecast for ${when(snapshot.forecast_at)}${timing}`}`;
  const station = elt('div', null, 'snapshot-item');
  station.append(elt('span', 'Our station', 'subtle'), elt('strong', `${value(snapshot.station, digits)} ${unit}`));
  grid.append(station);
  currentStatus.forecast_providers.forEach(provider => {
    const box = elt('div', null, 'snapshot-item');
    const forecast = snapshot.providers?.[provider];
    box.append(elt('span', provider, 'subtle'));
    if (forecast && Number.isFinite(forecast.value)) {
      const difference = forecast.value - snapshot.station;
      box.append(elt('strong', `${value(forecast.value, digits)} ${unit}`),
        elt('div', `${difference >= 0 ? '+' : ''}${value(difference, digits)} ${unit} from station · saved ${when(forecast.issued_at)}`, 'subtle'));
    } else {
      box.append(elt('strong', '—'), elt('div', metric === 'rain_in' && provider === 'NWS' ? 'No rainfall amounts' : 'No matching forecast', 'subtle'));
    }
    grid.append(box);
  });
}
function sourceHealth(provider) {
  return currentStatus?.sources.find(item => item.source === provider) || {};
}
function sourceResult(provider) {
  return currentData?.providers.find(item => item.provider === provider);
}
function sourceState(provider) {
  const health = sourceHealth(provider);
  if (currentData?.unsupported_providers?.includes(provider)) return 'No rainfall amounts';
  if (health.last_error) return 'Update failed';
  if (sourceResult(provider)?.rank != null) return 'Ready to compare';
  return health.last_success_at != null ? 'Saving forecasts' : 'Waiting for first update';
}
function updateSources() {
  // Configuration owns availability; historical scoring never adds or removes a source.
  if (!currentStatus) return;
  const available = currentStatus.forecast_providers;
  if (!available.includes(selectedSource)) selectedSource = available[0] || '';
  const select = byId('source');
  select.replaceChildren();
  if (!available.length) {
    const option = elt('option', 'No forecasts set up yet');
    option.value = '';
    select.append(option);
  }
  available.forEach(provider => {
    const option = elt('option', `${provider} · ${sourceState(provider)}`);
    option.value = provider;
    select.append(option);
  });
  select.disabled = !available.length;
  select.value = selectedSource;
}
async function loadComparison() {
  const request = ++comparisonRequest;
  currentData = null;
  comparisonLoading = true;
  comparisonError = '';
  byId('match-count').textContent = 'Loading the comparisons…';
  byId('mae-unit').textContent = '';
  byId('leaderboard').replaceChildren();
  byId('leaderboard-note').textContent = '';
  const rainfall = byId('metric').value === 'rain_in';
  byId('measurement-note').hidden = !rainfall;
  byId('measurement-note').textContent = rainfall
    ? rainfallMethodMessage : '';
  byId('station-legend').textContent = rainfall ? 'Our station (hourly estimate)' : 'Our station';
  byId('chart').setAttribute('aria-label', rainfall ? 'Estimated hourly station rainfall compared with the saved forecast, in inches' : 'Our station readings compared with the saved forecast');
  updateSources();
  drawChart();
  const query = new URLSearchParams(Object.fromEntries(controls.map(id => [id, byId(id).value])));
  let data;
  try {
    data = await json('./data/comparisons/' + query.get('metric') + '-' + query.get('horizon') + '-' + query.get('days') + '.json');
  } catch (error) {
    if (request !== comparisonRequest) return;
    currentData = null;
    comparisonLoading = false;
    comparisonError = 'We couldn’t load the comparisons. Please try again later.';
    byId('leaderboard').replaceChildren();
    byId('match-count').textContent = 'Comparison unavailable';
    byId('mae-unit').textContent = '';
    byId('leaderboard-note').textContent = comparisonError;
    updateSources();
    drawChart();
    return;
  }
  if (request !== comparisonRequest) return;
  currentData = data;
  comparisonLoading = false;
  if (data.metric === 'rain_in' && Number.isInteger(data.observation_hours)) {
    byId('measurement-note').textContent = `${rainfallMethodMessage} ${data.observation_hours} station ${data.observation_hours === 1 ? 'hour has' : 'hours have'} usable rain totals in this period.`;
  }
  byId('match-count').textContent = data.is_comparable ? `${data.matched_hours} hours compared` : 'Waiting for more matching hours';
  byId('mae-unit').textContent = `(${data.unit})`;
  renderLeaderboard();
  byId('leaderboard-note').textContent = data.is_comparable
    ? `Based on ${data.matched_hours} of the same station hours. Short histories can change quickly.`
    : `Rankings need at least ${data.min_samples} matching hours from two different forecast sources. Each forecast is saved ahead of time, then checked against our station.`;
  byId('leaderboard-note').textContent += ' Best Match can use HRRR here, so we don’t rank those two against each other.';
  if (data.metric === 'rain_in' && data.is_comparable && data.wet_hours === 0) {
    byId('leaderboard-note').textContent += ' Only dry hours have been compared so far; this doesn’t show how the forecasts handle rain.';
  }
  updateSources();
  drawChart();
}
function renderLeaderboard() {
  const data = currentData;
  if (!data) return;
  const body = byId('leaderboard');
  const detail = byId('leaderboard-detail');
  body.replaceChildren();
  detail.replaceChildren();
  const available = currentStatus?.forecast_providers;
  const results = data.providers.filter(row => !available || available.includes(row.provider));
  const names = [...(available || []), ...results.map(row => row.provider)];
  const unique = [...new Set(names)];
  const ordered = [...results.map(row => row.provider), ...unique.filter(name => !results.some(row => row.provider === name))];
  if (!ordered.length) {
    const row = elt('tr');
    const td = elt('td', `We’re building up some weather history. Rankings need at least ${data.min_samples} of the same hours to compare.`);
    td.colSpan = 4;
    row.append(td);
    body.append(row);
  }
  ordered.forEach(provider => {
    const result = data.providers.find(row => row.provider === provider) || {provider, rank: null, mae: null, bias: null, rmse: null, sample_count: 0, available_hours: 0};
    const row = elt('tr');
    if (result.rank === 1) row.className = 'winner';
    const digits = data.metric === 'rain_in' ? 3 : 2;
    const hours = result.sample_count || (data.unsupported_providers?.includes(provider) ? 'No rainfall amounts' :
      sourceHealth(provider).last_error ? 'Update failed' : result.available_hours ? `${result.available_hours} matched · not ranked` : 'Waiting for matches');
    const values = [result.rank || '—', result.provider, result.mae == null ? '—' : value(result.mae, digits), hours];
    values.forEach((entry, i) => {
      const cell = elt('td', entry);
      if (i === 0) cell.className = result.rank ? 'rank' : 'neutral';
      row.append(cell);
    });
    body.append(row);
    const extra = elt('tr');
    [result.provider, result.bias == null ? '—' : (result.bias >= 0 ? '+' : '') + value(result.bias, digits),
      result.rmse == null ? '—' : value(result.rmse, digits)].forEach(entry => extra.append(elt('td', entry)));
    detail.append(extra);
  });
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
  const empty = byId('empty-chart');
  const note = byId('provider-note');
  empty.hidden = false;
  note.textContent = '';
  note.className = 'note provider-note';
  if (!currentStatus) {
    empty.textContent = statusError ? 'We couldn’t check the forecast updates. Please try again later.' : 'Loading the forecasts…';
    return;
  }
  if (!selectedSource) {
    empty.textContent = 'No forecasts are set up yet. We’ll start saving them once a source is connected.';
    return;
  }
  const health = sourceHealth(selectedSource);
  const state = sourceState(selectedSource);
  note.textContent = state + '.';
  if (health.last_error) {
    note.textContent = 'We couldn’t get the latest forecast. Any earlier forecasts are still saved.';
    note.className += ' health-error';
  }
  if (comparisonLoading) {
    empty.textContent = 'Loading the weather history…';
    return;
  }
  if (comparisonError) {
    empty.textContent = 'We couldn’t load the weather history. Please try again later.';
    return;
  }
  if (currentData?.unsupported_providers?.includes(selectedSource)) {
    note.textContent = 'This forecast feed doesn’t include rainfall amounts.';
    empty.textContent = 'Choose another forecast to compare rainfall. You can still use this source for temperature, humidity and wind.';
    return;
  }
  const rainfall = currentData?.metric === 'rain_in';
  const rainHistoryError = rainfall && sourceHealth('Rainfall history').last_error;
  if (rainHistoryError) {
    note.textContent += ' We couldn’t update the station’s rain history. Any earlier complete hours are kept.';
    note.className += ' health-error';
  }
  const qualified = sourceResult(selectedSource)?.rank != null;
  const points = qualified
    ? (currentData?.chart || []).filter(p => p.forecasts[selectedSource] != null && p.actual != null)
      .map(p => ({valid_at: p.valid_at, actual: p.actual, forecast: p.forecasts[selectedSource]}))
    : (currentData?.provisional?.[selectedSource] || []).filter(p => p.forecast != null && p.actual != null);
  if (!points.length) {
    empty.textContent = health.last_error
      ? 'We couldn’t get this forecast’s latest update. A comparison will appear when updates resume and we have station readings for the same hours.'
      : state === 'Waiting for first update'
        ? 'We’re still waiting for this source’s first forecast.'
        : rainfall
          ? ['incomplete_history', 'hour_boundaries_unavailable'].includes(currentData.observation_status)
              ? 'The rain readings don’t establish a total for these hours yet. Rain near an hour boundary or missing readings can leave a gap. Daily rainfall and the reported rate, when available, are shown above.'
              : 'We’re saving hourly rain forecasts. Comparisons will appear after those hours pass and the station has a complete rain history.'
          : collectingMessage;
    return;
  }
  empty.hidden = true;
  const historyNote = qualified ? 'Compared using the same station hours.'
    : `Early results (provisional): ${points.length} matched ${points.length === 1 ? 'hour' : 'hours'}. Rankings need at least ${currentData.min_samples} of the same hours from two different forecast sources.`;
  note.textContent += ' ' + historyNote;
  const W = 960, H = 300, left = 54, right = 16, top = 20, bottom = 42;
  const all = points.flatMap(p => [p.actual, p.forecast]);
  let min = Math.min(...all), max = Math.max(...all);
  const pad = Math.max((max - min) * 0.18, rainfall ? 0.01 : currentData.metric === 'humidity_pct' ? 5 : 2);
  min = rainfall ? Math.max(0, min - pad) : min - pad; max += pad;
  const start = points[0].valid_at, end = points[points.length - 1].valid_at;
  const x = p => start === end ? (left + W - right) / 2 : left + (p.valid_at - start) / (end - start) * (W - left - right);
  const y = v => top + (max - v) / (max - min) * (H - top - bottom);
  for (let i = 0; i <= 4; i++) {
    const py = top + i * (H - top - bottom) / 4;
    chart.append(svg('line', {x1:left,y1:py,x2:W-right,y2:py,stroke:'#293c4b','stroke-width':1}));
    chart.append(svg('text', {x:left-12,y:py+4,fill:'#8297a8','font-size':12,'text-anchor':'end'}, (max-(max-min)*i/4).toFixed(rainfall ? 3 : 1)));
  }
  const path = accessor => points.map((p,i) => (i && p.valid_at - points[i-1].valid_at <= 3600 ? 'L' : 'M')+x(p).toFixed(1)+','+y(accessor(p)).toFixed(1)).join(' ');
  if (points.length > 1) {
    chart.append(svg('path', {d:path(p => p.actual),fill:'none',stroke:'#66d8c0','stroke-width':2.6,'stroke-linejoin':'round'}));
    chart.append(svg('path', {d:path(p => p.forecast),fill:'none',stroke:'#8aa4ff','stroke-width':2.4,'stroke-dasharray':'6 3','stroke-linejoin':'round'}));
  }
  points.forEach(p => {
    chart.append(svg('circle', {cx:x(p),cy:y(p.actual),r:3,fill:'#66d8c0'}));
    chart.append(svg('circle', {cx:x(p),cy:y(p.forecast),r:3,fill:'#8aa4ff'}));
  });
  [...new Set([0, Math.floor((points.length-1)/2), points.length-1])].forEach(i => {
    chart.append(svg('text', {x:x(points[i]), y:H-12,fill:'#8297a8','font-size':12,'text-anchor':i===0?'start':i===points.length-1?'end':'middle'}, when(points[i].valid_at)));
  });
}
async function refresh() {
  await Promise.all([loadStatus(), loadComparison()]);
}
controls.forEach(id => byId(id).addEventListener('change', () => {
  if (id === 'metric') { byId('snapshot-metric').value = byId('metric').value; renderSnapshot(); }
  return loadComparison();
}));
byId('snapshot-metric').addEventListener('change', () => {
  byId('metric').value = byId('snapshot-metric').value;
  renderSnapshot();
  return loadComparison();
});
byId('source').addEventListener('change', e => { selectedSource = e.target.value; drawChart(); });
refresh();
setInterval(refresh, 120000);
