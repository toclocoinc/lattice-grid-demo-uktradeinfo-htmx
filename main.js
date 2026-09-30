/* The wiring. htmx moves the HTML and modules/htmx hydrates each <table data-lattice-grid> it brings in;
   this file only binds the tiles and charts to whichever grids are live, on htmx:load. See the README. */
(function () {
  'use strict';
  const { setLicence, gridElementsWithin } = window.LatticeGridHtmx;
  const { createChart } = window.LatticeGrid; // the charts module extends this global
  const { createKPI } = window.LatticeGridKPI;
  setLicence(DEMO_LICENCE); // before htmx's first htmx:load hydrates the rendered table

  const $ = (sel) => document.querySelector(sel);
  const select = $('#month');
  const gridIn = (sel) => { const host = gridElementsWithin($(sel))[0]; return host ? host.__lattice : null; };
  const money = { type: 'currency', currency: 'GBP', decimals: 0 };
  const bound = { trade: null, summary: null, kpi: null, charts: null, trend: null, partner: null };
  let top = []; // the partners that have their own trend fragment, from fragments/index.json
  let prev = {}; // the previous month's values by series key; reassigned on every bind, read by the compute below

  /** The month's tiles and three charts: created once, then rebound to whichever grid hydrates #trade
      thereafter (the select, and now also back/forward - grid 1.83.0's snapshot-size fix, BACKLOG-1597).
      A hydrated table's id is not carried across a swap, so the module cannot rebind on its own; this
      manual rebind() call is what keeps the views live instead of rebuilding them on every swap. */
  function bindMonth(grid) {
    prev = JSON.parse(($('#trade .previous-month') || {}).textContent || '{}');
    if (bound.kpi) {
      bound.kpi.rebind(grid);
      bound.charts.forEach((c) => c.rebind(grid));
      return;
    }
    bound.kpi = createKPI($('#tiles'), {
      grid, rowKey: '__row', fields: ['value', 'balance', 'flow', 'partner', 'chapter'], columns: 5,
      tiles: [
        { id: 'exports', label: 'Exports in view', aggregation: 'sum', field: 'value', filter: (r) => r.flow === 'Exports', format: money },
        { id: 'imports', label: 'Imports in view', aggregation: 'sum', field: 'value', filter: (r) => r.flow === 'Imports', format: money },
        { id: 'balance', label: 'Trade balance in view', aggregation: 'sum', field: 'balance', format: money,
          bands: [{ min: 0, status: 'good' }, { max: 0, status: 'critical' }] },
        { id: 'partners', label: 'Partners in view', aggregation: 'countDistinct', field: 'partner', format: 'number' },
        { id: 'change', label: 'Change on the month before, like for like', aggregation: 'custom', format: { type: 'percent', decimals: 1 },
          // Only the chapter, partner and flow combinations traded in both months count, on both sides.
          compute: (rows) => {
            let now = 0; let before = 0;
            for (const r of rows) {
              const key = `${Number(r.chapter)}|${r.partner}|${r.flow}`;
              if (key in prev) { now += Number(r.value) || 0; before += prev[key]; }
            }
            return before ? (now - before) / before : null;
          } },
      ],
    });
    bound.kpi.on('change', followPartner);
    bound.charts = [
      createChart({ container: $('#chart-partner'), grid, type: 'treemap', x: 'partner', y: 'value', title: 'Who the trade is with', legend: false }),
      createChart({ container: $('#chart-section'), grid, type: 'treemap', x: 'section', y: 'value', title: 'What is traded, by HS section', legend: false }),
      createChart({ container: $('#chart-region'), grid, type: 'horizontalBar', x: 'region', y: 'value', series: 'flow',
        title: 'Imports and exports by region', margin: { left: 150 }, legend: { position: 'bottom' } }),
    ];
  }

  /** The trend line: created once, then rebound to whichever grid hydrates #summary thereafter. */
  function bindTrend(grid) {
    if (bound.trend) { bound.trend.rebind(grid); return; }
    bound.trend = createChart({ container: $('#chart-trend'), grid, type: 'line', x: 'month', y: 'value', series: 'flow',
      title: 'Month by month', axis: { x: { scale: 'band', labels: true, rotate: 'auto', every: 3 } }, legend: { position: 'bottom' } });
  }

  /** A partner filter on the table narrows the trend, when that partner has a saved trend fragment. */
  function followPartner() {
    const filtered = JSON.stringify(bound.trade.filters.get() || {}).includes('"partner"');
    const inView = new Set();
    bound.kpi.rows.forEach((r) => inView.add(r.partner));
    const one = filtered && inView.size === 1 ? [...inView][0] : null;
    const match = top.find((p) => p.name === one) || null;
    $('#trend-note').textContent = filtered && !match
      ? 'The trend is saved for each of the top 20 partners, one at a time; it shows all 30 partners here.' : '';
    const want = match ? match.name : null;
    if (want === bound.partner) return;
    bound.partner = want;
    htmx.ajax('GET', `fragments/${select.value}/${match ? `summary-${match.slug}.html` : 'summary.html'}`, { target: '#summary', swap: 'innerHTML' });
  }

  /** Bind whatever grid is live and not yet bound to: the select's swap, and now also back/forward,
      which re-hydrate through htmx's history cache rather than reloading the page. */
  function sync() {
    const trade = gridIn('#trade');
    if (trade && trade !== bound.trade) {
      bound.trade = trade;
      bound.partner = null;
      select.value = $('#trade .previous-month')?.dataset.for || select.value;
      bindMonth(trade);
    }
    const summary = gridIn('#summary');
    if (summary && summary !== bound.summary) { bound.summary = summary; bindTrend(summary); }
  }

  /* The select's hx-get names the newest month; point it at the chosen one, and push ?month= rather than the fragment's address. */
  document.body.addEventListener('htmx:configRequest', (e) => {
    if (e.detail.elt !== select) return;
    e.detail.path = `fragments/${select.value}/table.html`;
    select.setAttribute('hx-push-url', `?month=${select.value}`);
  });
  // On document, after modules/htmx's own listeners (also on document, added first), so the grids exist by then.
  document.addEventListener('htmx:load', sync);
  document.addEventListener('htmx:historyRestore', sync);

  fetch('fragments/index.json').then((r) => r.json()).then((index) => {
    top = index.partners;
    // A link to another month: that month is one request away; the newest is already in the page.
    const asked = new URLSearchParams(location.search).get('month');
    if (asked && asked !== index.newest && index.months.includes(asked)) {
      select.value = asked;
      htmx.ajax('GET', `fragments/${asked}/table.html`, { target: '#trade', swap: 'innerHTML' });
    }
  });
  window.__tradeHtmx = bound; // for tools/verify.mjs
})();
