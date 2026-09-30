/**
 * Render the saved copy into static HTML fragments, and write index.html.
 *
 * This is the "server" of an htmx page that has no server. It reads the
 * saved copy the sibling demo commits (toclocoinc/lattice-grid-demo-uktradeinfo,
 * data/snapshot/), over raw.githubusercontent.com by default, and writes:
 *
 *   fragments/index.json                     the months, the newest, the copy date
 *   fragments/<month>/table.html             the month's table, its grid config,
 *                                            the previous month's values by series
 *                                            key, and the whole-window summary as
 *                                            an out-of-band swap
 *   fragments/<month>/summary.html           the 48 month-by-flow sums, whole window
 *   fragments/<month>/summary-<partner>.html the same for one of the top 20 partners
 *   index.html                               src/index.template.html with the newest
 *                                            month's table rendered into it
 *
 * It never calls the HMRC API. The sibling's nightly job does that; this only
 * reads what it saved.
 *
 *   node tools/render-fragments.mjs                  read the sibling's copy on GitHub
 *   node tools/render-fragments.mjs --from <dir>     read a local data/snapshot folder
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* The sibling's shaping code, reused unchanged: a classic script that puts
   `TradeDemo` on globalThis (sections, regions, month labels, decodeMonth). */
await import('./hmrc-api.js');
const { decodeMonth, monthLabel, previousMonth } = globalThis.TradeDemo;

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SNAPSHOT = 'https://raw.githubusercontent.com/toclocoinc/lattice-grid-demo-uktradeinfo/main/data/snapshot/';

/** How many partners get their own trend fragment. The README says why 20. */
const TOP_PARTNERS = 20;

const fromAt = process.argv.indexOf('--from');
const from = fromAt > -1 ? resolve(process.argv[fromAt + 1]) : null;

/**
 * Read one file of the saved copy, from disk or from GitHub.
 * @param {string} path the path under data/snapshot/
 * @returns {Promise<object>} the parsed JSON
 */
async function readSaved(path) {
  if (from) return JSON.parse(await readFile(join(from, path), 'utf8'));
  const response = await fetch(SNAPSHOT + path);
  if (!response.ok) throw new Error(`${SNAPSHOT + path} answered ${response.status}`);
  return response.json();
}

/** @param {unknown} text @returns {string} the text, safe inside HTML */
const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** @param {string} name a partner name @returns {string} its file-name slug */
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The month table's grid options, read by autoInit from the sibling config script. */
const TABLE_CONFIG = {
  density: 'compact',
  stripedRows: true,
  columnMenu: true,
  groupPanel: true,
  statusBar: true,
  find: true,
  selection: 'multiple',
  toolPanel: { side: 'right', panels: ['filters', 'columns', 'formatting'] },
  formatting: {
    balance: [
      { id: 'surplus', label: 'Surplus: exports exceed imports', when: { op: 'gt', value: 0 }, style: { color: '#1b5e20', fontWeight: '600' } },
      { id: 'deficit', label: 'Deficit: imports exceed exports', when: { op: 'lt', value: 0 }, style: { color: '#b3261e', fontWeight: '600' } },
    ],
  },
};

const SUMMARY_CONFIG = { density: 'compact', stripedRows: true };

/**
 * The month table. `data-type` and `data-format` on each `<th>` are the
 * hydration conventions from the htmx guide: value and balance hydrate as
 * numbers shown in whole pounds.
 * @param {object[]} rows the month's decoded rows
 * @param {string} month '2026-07'
 * @returns {string} the table and its config script
 */
function tableHtml(rows, month) {
  const money = 'data-type="number" data-format="currency:GBP:0"';
  const head = [
    '<th data-field="chapter" data-type="text">Chapter</th>',
    '<th data-field="chapterName">Chapter name</th>',
    '<th data-field="section">HS section</th>',
    '<th data-field="partner">Partner</th>',
    '<th data-field="region">Region</th>',
    '<th data-field="flow">Flow</th>',
    `<th data-field="value" ${money}>Value</th>`,
    `<th data-field="balance" ${money}>Balance</th>`,
  ].join('');
  const body = rows
    .map((r) => `<tr data-id="${esc(r.key)}"><td>${r.chapter}</td><td>${esc(r.chapterName)}</td><td>${esc(r.sectionShort)}</td>`
      + `<td>${esc(r.partner)}</td><td>${esc(r.region)}</td><td>${r.flow}</td><td>${r.value}</td><td>${r.balance}</td></tr>`)
    .join('\n');
  return `<table data-lattice-grid data-month="${month}" aria-label="UK trade, ${monthLabel(month)}">\n`
    + `<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>\n`
    + `<script type="application/json" data-lattice-config>${JSON.stringify({ ...TABLE_CONFIG, title: `UK goods trade, ${monthLabel(month)}` })}</script>\n`;
}

/**
 * The whole-window trend table: one row per month and flow.
 * @param {Map<string, {I: number, X: number}>} sums by month
 * @param {string} scope who the sums cover, for the title
 * @returns {string} the table and its config script
 */
function summaryHtml(sums, scope) {
  const body = [...sums.keys()].sort()
    .flatMap((m) => [['Exports', sums.get(m).X], ['Imports', sums.get(m).I]]
      .map(([flow, value]) => `<tr><td>${m}</td><td>${flow}</td><td>${value}</td></tr>`))
    .join('\n');
  return `<h2 class="scope">Trend data, ${esc(scope)}</h2>\n<table data-lattice-grid data-scope="${esc(scope)}" aria-label="Trend, ${esc(scope)}">\n`
    + '<thead><tr><th data-field="month">Month</th><th data-field="flow">Flow</th>'
    + '<th data-field="value" data-type="number" data-format="currency:GBP:0">Value</th></tr></thead>\n'
    + `<tbody>\n${body}\n</tbody>\n</table>\n`
    + `<script type="application/json" data-lattice-config>${JSON.stringify(SUMMARY_CONFIG)}</script>\n`;
}

/**
 * The previous month's values by series key, for the like-for-like tile.
 * @param {object[]|undefined} rows the previous month's rows
 * @param {string} month the previous month
 * @param {string} current the month on screen, which the page reads back after a swap
 * @returns {string} a JSON script the page reads after the swap
 */
function previousHtml(rows, month, current) {
  /* Keyed by what the hydrated grid can read back: chapter number, partner name, flow. The chapter is a
     number on both sides, because hydration reads "01" as 1 (F-1584-1 in the README). */
  const byKey = Object.fromEntries((rows || []).map((r) => [`${Number(r.chapter)}|${r.partner}|${r.flow}`, r.value]));
  return `<script type="application/json" class="previous-month" data-for="${current}" data-previous="${month}">${JSON.stringify(byKey)}</script>\n`;
}

const started = Date.now();
const meta = await readSaved('meta.json');
const lookups = { partners: meta.partners, chapters: meta.chapters };
const months = [...meta.months].sort();
const store = new Map();
for (const month of months) store.set(month, decodeMonth(await readSaved(`months/${month}.json`), lookups));

/* The trend: month-by-flow sums, for everyone and for each top partner. */
const top = [...meta.partners].sort((a, b) => b.total - a.total).slice(0, TOP_PARTNERS);
const sumsFor = (partner) => new Map(months.map((m) => {
  const s = { I: 0, X: 0 };
  for (const r of store.get(m)) if (!partner || r.partner === partner) s[r.flow === 'Exports' ? 'X' : 'I'] += r.value;
  return [m, s];
}));
const whole = summaryHtml(sumsFor(null), 'all 30 partners');
const perPartner = top.map((p) => ({ name: p.name, slug: slug(p.name), html: summaryHtml(sumsFor(p.name), p.name) }));

await rm(join(ROOT, 'fragments'), { recursive: true, force: true });
let files = 0;
let bytes = 0;
const write = async (path, text) => {
  await mkdir(join(ROOT, path, '..'), { recursive: true });
  await writeFile(join(ROOT, path), text);
  files += 1;
  bytes += Buffer.byteLength(text);
};

for (const month of months) {
  const table = tableHtml(store.get(month), month);
  const previous = previousHtml(store.get(previousMonth(month)), previousMonth(month), month);
  /* The summary rides along out of band, so one request moves both. */
  const oob = `<div id="summary" hx-swap-oob="innerHTML">\n${whole}</div>\n`;
  await write(`fragments/${month}/table.html`, table + previous + oob);
  await write(`fragments/${month}/summary.html`, whole);
  for (const p of perPartner) await write(`fragments/${month}/summary-${p.slug}.html`, p.html);
}

const topShare = top.reduce((s, p) => s + p.total, 0) / meta.partners.reduce((s, p) => s + p.total, 0);
const index = {
  months,
  newest: meta.newest,
  copyDate: meta.fetchedAt,
  rowsByMonth: Object.fromEntries(months.map((m) => [m, store.get(m).length])),
  partners: perPartner.map((p) => ({ name: p.name, slug: p.slug })),
  topShare: Math.round(topShare * 1000) / 1000,
  source: meta.source,
  licence: meta.licence,
};
await write('fragments/index.json', `${JSON.stringify(index, null, 1)}\n`);

/* index.html: the newest month rendered in, so the first paint needs no request. */
const newest = meta.newest;
const template = await readFile(join(ROOT, 'src/index.template.html'), 'utf8');
const copyDate = new Date(meta.fetchedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const options = [...months].reverse().map((m) => `<option value="${m}"${m === newest ? ' selected' : ''}>${monthLabel(m)}</option>`).join('');
const page = template
  .replace('<!--MONTH_OPTIONS-->', options)
  .replace('<!--NEWEST-->', newest)
  .replace('<!--COPY_DATE-->', esc(copyDate))
  .replaceAll('<!--PARTNER_COUNT-->', String(meta.partners.length))
  .replace('<!--TOP_SHARE-->', String(Math.round(topShare * 100)))
  .replace('<!--TABLE-->', tableHtml(store.get(newest), newest) + previousHtml(store.get(previousMonth(newest)), previousMonth(newest), newest))
  .replace('<!--SUMMARY-->', whole);
await writeFile(join(ROOT, 'index.html'), page);

console.log(`[render] ${months.length} months, ${files} fragment files, ${(bytes / 1e6).toFixed(1)} MB, `
  + `index.html ${(Buffer.byteLength(page) / 1e6).toFixed(2)} MB, copy of ${meta.fetchedAt}, ${Date.now() - started} ms`);
