/**
 * Open the page in a real browser and check it, the way the sibling demo does.
 *
 *   node tools/verify.mjs                      serve this folder locally and check it
 *   node tools/verify.mjs --url <address>      check a published copy (a cache-busting query is added)
 *   node tools/verify.mjs --shots <dir>        also save screenshots
 *
 * Fails (exit 1) unless every check holds:
 *   - no request to the HMRC API, ever (and none blocked either)
 *   - the grid came from modules/htmx 1.83.1; no watermark; no console errors
 *   - the rendered table hydrated: grid rows equal the <tr> count of the month's fragment
 *   - the tiles agree with sums recomputed from that fragment
 *   - sort and filter work on the hydrated grid
 *   - the month select swaps the table (and re-hydrates), the summary rides along out of band,
 *     the trend has 48 points
 *   - a partner filter swaps in that partner's trend fragment
 *   - browser back restores the previous month's grid, live, with the sort set before leaving it
 *     kept; forward restores the next month; htmx's default history cache does both (no
 *     htmx:historyCacheError), and its sessionStorage use stays under quota
 *
 * Needs Chrome and puppeteer-core; set CHROME and PUPPETEER to point at them.
 */

import { mkdir } from 'node:fs/promises';

const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const PUPPETEER = process.env.PUPPETEER
  || '/home/latticeprodmgr/.npm/_npx/8003d8991b0d346b/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const shots = arg('--shots');

const { default: puppeteer } = await import(PUPPETEER);
let server = null;
let base = arg('--url');
if (!base) {
  const { startServer } = await import('./serve.mjs');
  const started = await startServer(0);
  server = started.server;
  base = `http://127.0.0.1:${started.port}/`;
}
const bust = `v=${Date.now()}`;
const failures = [];
const numbers = {};
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The <tr> count and the Exports/Imports sums of a table fragment, in Node, from the published file. */
async function fragmentFacts(month) {
  const html = await (await fetch(new URL(`fragments/${month}/table.html?${bust}`, base))).text();
  const body = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
  const rows = [...body.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((m) => [...m[1].matchAll(/<td>(.*?)<\/td>/g)].map((c) => c[1]));
  const sum = (flow) => rows.filter((r) => r[5] === flow).reduce((s, r) => s + Number(r[6]), 0);
  const prev = JSON.parse(html.match(/class="previous-month"[^>]*>(.*?)<\/script>/)[1]);
  let now = 0; let before = 0;
  for (const r of rows) {
    const key = `${Number(r[0])}|${r[3]}|${r[5]}`;
    if (key in prev) { now += Number(r[6]); before += prev[key]; }
  }
  const change = before ? `${(((now - before) / before) * 100).toFixed(1)}%` : null;
  return { tr: rows.length, exports: sum('Exports'), imports: sum('Imports'), balance: rows.reduce((s, r) => s + Number(r[7]), 0), change };
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
console.log(`chrome pid ${browser.process().pid}; checking ${base}`);
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1300 });
  const errors = [];
  const apiRequests = [];
  const requests = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    requests.push(req.url());
    if (/uktradeinfo\.com/i.test(new URL(req.url()).hostname)) { apiRequests.push(req.url()); return req.abort(); }
    return req.continue();
  });

  const state = () => page.evaluate(() => {
    const b = window.__tradeHtmx;
    if (!b || !window.LatticeGridHtmx) return {};
    const safe = (fn) => { try { return fn(); } catch { return -1; } };
    return {
      month: document.querySelector('#month').value,
      url: location.search,
      tradeRows: safe(() => b.trade.rows.count()),
      tradeMonth: document.querySelector('#trade .previous-month')?.dataset.for || null,
      summaryRows: safe(() => b.summary.rows.count()),
      trendPoints: safe(() => b.trend.data().series.reduce((n, x) => n + x.points.length, 0)),
      scope: document.querySelector('#summary .scope')?.textContent.replace('Trend data, ', '') || null,
      kpiRows: safe(() => { let n = 0; b.kpi.rows.forEach(() => { n += 1; }); return n; }),
      live: window.LatticeGridHtmx.gridElementsWithin(document.body).length,
    };
  });
  const until = async (fn, label, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const s = await state().catch(() => ({})); // mid-navigation, or before the scripts have run
      if (fn(s)) return s;
      if (Date.now() > end) { check(false, `timed out waiting for ${label}`, JSON.stringify(s)); return s; }
      await sleep(150);
    }
  };

  /* 1. First paint: the newest month is in the HTML, hydrated with no request for it. */
  const index = await (await fetch(new URL(`fragments/index.json?${bust}`, base))).json();
  const t0 = Date.now();
  await page.goto(new URL(`?${bust}`, base).href, { waitUntil: 'load' });
  let s = await until((x) => x.tradeRows > 0 && x.summaryRows > 0 && x.trendPoints > 0, 'first hydration');
  numbers.firstHydrationMs = Date.now() - t0;
  const newest = await fragmentFacts(index.newest);
  numbers.newestTr = newest.tr;
  numbers.hydratedRows = s.tradeRows;
  check(s.tradeRows === newest.tr, 'hydrated row count equals the fragment <tr> count', `${s.tradeRows} vs ${newest.tr}`);
  check(!requests.some((u) => u.includes(`fragments/${index.newest}/table.html`)), 'first paint needed no fragment request');
  const lib = await page.evaluate(() => ({
    version: window.LatticeGridHtmx.version(), htmx: window.htmx.version, watermarks: document.querySelectorAll('.lat-watermark').length,
    moduleScript: [...document.scripts].map((x) => x.src).filter((x) => x.includes('lattice-grid@')),
  }));
  numbers.version = lib.version;
  check(lib.version === '1.83.1', 'LatticeGridHtmx.version() is 1.83.1', lib.version);
  check(lib.moduleScript.some((x) => x.includes('@1.83.1/modules/htmx.min.js')) && !lib.moduleScript.some((x) => /lattice-grid\.min\.js/.test(x)),
    'the grid came from modules/htmx, not the core bundle');
  check(lib.watermarks === 0, 'no .lat-watermark', String(lib.watermarks));
  numbers.trendPoints = s.trendPoints;
  check(s.summaryRows === 48 && s.trendPoints === 48, 'trend has 48 points', `${s.summaryRows} rows, ${s.trendPoints} points`);
  const money = (v) => `£${Math.round(v).toLocaleString('en-GB')}`.replace('£-', '-£');
  const tileText = await page.evaluate(() => document.querySelector('#tiles').textContent);
  check(tileText.includes(money(newest.exports)) && tileText.includes(money(newest.imports)) && tileText.includes(money(newest.balance)),
    'tiles equal the sums recomputed from the fragment', `${money(newest.exports)} / ${money(newest.imports)} / ${money(newest.balance)}`);
  numbers.tiles = { exports: money(newest.exports), imports: money(newest.imports), balance: money(newest.balance), change: newest.change };
  check(tileText.includes(newest.change), 'the like-for-like change tile equals the recomputation', newest.change);

  /* 2. Sort and filter on the hydrated grid; the tiles follow. */
  const sorted = await page.evaluate(() => {
    const g = window.__tradeHtmx.trade;
    g.sort.set([{ col: 'value', dir: 'desc' }]);
    const a = g.rows.get(0).data.value; const b = g.rows.get(1).data.value;
    g.filters.set({ col: 'partner', op: 'eq', value: 'Germany' });
    return { a, b, after: g.rows.count(), partners: new Set(Array.from({ length: g.rows.count() }, (_, i) => g.rows.get(i).data.partner)).size };
  });
  check(sorted.a >= sorted.b, 'sort by value, descending', `${sorted.a} >= ${sorted.b}`);
  check(sorted.after > 0 && sorted.after < s.tradeRows && sorted.partners === 1, 'filter partner = Germany', `${sorted.after} rows, ${sorted.partners} partner`);
  numbers.germanyRows = sorted.after;
  s = await until((x) => x.scope === 'Germany' && x.summaryRows === 48 && x.kpiRows === sorted.after, 'the Germany trend fragment');
  check(requests.some((u) => u.includes(`fragments/${index.newest}/summary-germany.html`)), 'a partner filter requested that partner\'s trend fragment');
  check(s.trendPoints === 48, 'Germany trend has 48 points', String(s.trendPoints));
  if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: `${shots}/germany.png`, fullPage: true }); }
  await page.evaluate(() => window.__tradeHtmx.trade.filters.clear());
  s = await until((x) => x.scope !== 'Germany' && x.kpiRows === newest.tr, 'the whole-window trend back');

  /* 3. Swap months with the select; each swap re-hydrates, and the summary comes out of band. */
  const months = [...index.months].reverse();
  const second = months[1];
  const third = months[2];
  const swap = async (month) => {
    await page.select('#month', month);
    return until((x) => x.tradeMonth === month && x.tradeRows > 0 && x.trendPoints === 48 && x.live === 2, `the ${month} swap`);
  };
  s = await swap(second);
  const secondFacts = await fragmentFacts(second);
  check(s.tradeRows === secondFacts.tr, `swap to ${second}: hydrated rows equal its <tr> count`, `${s.tradeRows} vs ${secondFacts.tr}`);
  check(s.url.includes(`month=${second}`), 'the month is pushed into the address', s.url);
  check(s.live === 2, 'only the two live grids remain after a swap (the old one was destroyed)', String(s.live));
  numbers.swaps = [{ month: second, rows: s.tradeRows, tr: secondFacts.tr }];
  await page.evaluate(() => window.__tradeHtmx.trade.sort.set([{ col: 'balance', dir: 'asc' }]));
  s = await swap(third);
  const thirdFacts = await fragmentFacts(third);
  check(s.tradeRows === thirdFacts.tr, `swap to ${third}: hydrated rows equal its <tr> count`, `${s.tradeRows} vs ${thirdFacts.tr}`);
  numbers.swaps.push({ month: third, rows: s.tradeRows, tr: thirdFacts.tr });

  /* 4. Back and forward: grid 1.83.0's snapshot-size fix (BACKLOG-1597) keeps a hydrated month's
     history snapshot under sessionStorage's quota, so the page no longer overrides htmx's history
     config (F-1584-2, fixed). Back restores the previous month's grid live, sort kept; forward the
     next. No htmx:historyCacheError, and sessionStorage stays under quota throughout. */
  await page.evaluate(() => {
    window.__historyCacheErrors = [];
    document.body.addEventListener('htmx:historyCacheError', (e) => window.__historyCacheErrors.push(e.detail));
  });
  const histCfg = await page.evaluate(() => ({
    size: htmx.config.historyCacheSize, refresh: htmx.config.refreshOnHistoryMiss, meta: !!document.querySelector('meta[name="htmx-config"]'),
  }));
  check(!histCfg.meta && histCfg.size > 0, 'no htmx-config override; history caching is on by default', JSON.stringify(histCfg));
  await page.goBack({ waitUntil: 'load' });
  s = await until((x) => x.tradeMonth === second && x.tradeRows > 0 && x.trendPoints === 48, `back to ${second}`);
  const backSort = await page.evaluate(() => JSON.stringify(window.__tradeHtmx.trade.sort.get()));
  numbers.back = { url: s.url, month: s.tradeMonth, rows: s.tradeRows, select: s.month, sort: backSort };
  check(s.tradeRows === secondFacts.tr && s.month === second && s.live === 2, `back restores the ${second} grid, live`, JSON.stringify(numbers.back));
  check(backSort.includes('balance'), 'F-1584-2 fixed: the sort set before leaving the month is kept on back', backSort);
  await page.goForward({ waitUntil: 'load' });
  s = await until((x) => x.tradeMonth === third && x.tradeRows > 0 && x.trendPoints === 48, `forward to ${third}`);
  numbers.forward = { url: s.url, month: s.tradeMonth, rows: s.tradeRows };
  check(s.tradeRows === thirdFacts.tr && s.live === 2, `forward restores the ${third} grid, live`, JSON.stringify(numbers.forward));
  const cacheErrors = await page.evaluate(() => window.__historyCacheErrors);
  check(cacheErrors.length === 0, 'no htmx:historyCacheError on back or forward', JSON.stringify(cacheErrors));
  const sessionBytes = await page.evaluate(() => Object.keys(sessionStorage).reduce(
    (n, k) => n + (k.length + (sessionStorage.getItem(k) || '').length) * 2, 0));
  numbers.sessionStorageBytes = sessionBytes;
  // Chrome's per-origin sessionStorage quota is ~10MB; no QuotaExceededError and no console error
  // above already proves the ten cached entries (htmx's default historyCacheSize) fit.
  check(sessionBytes < 10 * 1024 * 1024, 'htmx history sessionStorage stays under quota', `${sessionBytes} bytes`);

  /* 5. The no-API rule, and a clean console. */
  numbers.requests = requests.length;
  numbers.apiRequests = apiRequests.length;
  check(apiRequests.length === 0, 'no request to the HMRC API', String(apiRequests.length));
  numbers.consoleErrors = errors.length;
  check(errors.length === 0, '0 console errors', errors.slice(0, 3).join(' | '));
  if (shots) await page.screenshot({ path: `${shots}/final.png`, fullPage: true });
} finally {
  await browser.close();
  if (server) server.close();
}
console.log(`numbers ${JSON.stringify(numbers)}`);
console.log(failures.length ? `FAILED ${failures.length}: ${failures.join('; ')}` : 'ALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
