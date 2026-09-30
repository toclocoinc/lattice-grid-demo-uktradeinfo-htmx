# UK goods trade from HMRC, the htmx way

What the United Kingdom imports and exports, by commodity chapter and trading
partner, month by month, from HM Revenue & Customs. The server owns the data,
htmx moves HTML, and [Lattice Grid](https://www.latticegrid.dev)'s htmx module
hydrates whatever table arrives into a live grid that tiles and charts bind to.

**[See it running](https://toclocoinc.github.io/lattice-grid-demo-uktradeinfo-htmx/)**

| | |
| --- | --- |
| Grid | [@toclocoinc/lattice-grid](https://www.npmjs.com/package/@toclocoinc/lattice-grid) 1.81.0, `modules/htmx`, `modules/charts`, `modules/kpi`, by `<script>` tag from jsDelivr |
| htmx | 2.0.11, by `<script>` tag from unpkg |
| Sibling | [lattice-grid-demo-uktradeinfo](https://github.com/toclocoinc/lattice-grid-demo-uktradeinfo), the same data kept in the browser |
| Data | [HM Revenue & Customs, uktradeinfo](https://www.uktradeinfo.com/), Open Government Licence v3.0 |

## How it fits together

```
 sibling repo: data/snapshot/*.json          (taken from the HMRC API by the sibling's own job)
          |  raw.githubusercontent.com, weekly
          v
 tools/render-fragments.mjs  ------------->  index.html          newest month rendered in
          |                                  fragments/<month>/table.html     + previous month, + summary (OOB)
          |                                  fragments/<month>/summary*.html  trend tables
          v
 browser: <select hx-get hx-target="#trade">  --htmx swap-->  <table data-lattice-grid>
          |                                                        |
          |                               modules/htmx: htmx:load -> autoInit -> hydrateTable
          v                                                        v
 main.js on htmx:load: bind KPI tiles + 3 charts to the month grid, the trend to the summary grid
```

**The contrast with the sibling.** The sibling reads the whole saved copy into
the browser and does everything there: a data router, a derived grid for the
trend, a keyed diff when the month changes. Here the browser holds one month
at a time and nothing else; each month and each trend is a static HTML
fragment rendered ahead of time, and htmx swaps it in. The grid's job shrinks
to hydrating a `<table>` it did not build, and the page's to re-binding its
views when a new grid appears.

## Why a saved copy

The figures come from the HMRC uktradeinfo API, a public OData service with no
key. A page on another web address cannot read it: the API answers without an
`Access-Control-Allow-Origin` header, so every browser refuses to hand the
response over. The sibling demo therefore calls the API under Node and commits
what it fetched to its `data/snapshot/`. This demo goes one step further from
the API: it reads the sibling's committed copy and renders HTML from it. Neither
the page nor this repository's workflow ever calls the API, and
`tools/verify.mjs` fails if the page tries. The badge at the top shows the day
the copy was taken.

## The page

- **First paint needs no request.** The renderer writes the newest month's
  table into `index.html`. With JavaScript off it is a readable table; with it
  on, `modules/htmx` hydrates it on htmx's first `htmx:load`.
- **Hydration conventions.** Columns come from the `<th>` cells: `data-field`
  names the field, `data-type="number"` with `data-format="currency:GBP:0"`
  makes value and balance numbers shown in whole pounds. Grid options (tool
  panel, group panel, column menus, find, the balance colour rule) come from
  the `<script type="application/json" data-lattice-config>` next to the table.
  Each `<tr data-id>` carries the series key as the row key.
- **The month select** is an htmx element (`hx-get`, `hx-target="#trade"`,
  `hx-swap="innerHTML"`, `hx-push-url`). `main.js` points its request at the
  chosen month's fragment and pushes `?month=` rather than the fragment's
  address. The fragment carries the whole-window summary as an out-of-band
  swap (`hx-swap-oob`), so one request moves the table and the trend table.
- **Tiles and charts survive the swap by being rebuilt, not kept.** A swapped
  month is a new grid instance; the old one is destroyed by the module. So
  `main.js` listens for `htmx:load` on `document` (after the module's own
  listener, so the grid already exists), finds the live grid with
  `gridElementsWithin`, and binds a KPI panel and three charts to it. Before a
  swap (`htmx:beforeSwap`, `htmx:oobBeforeSwap`) it destroys the views bound to
  the grid that is about to go. That is the whole of the wiring: 113 lines.
- **The change tile** compares only the chapter, partner and flow combinations
  present in both months. The fragment carries the previous month's values by
  that key in a `<script class="previous-month">`, so the tile needs no extra
  request.
- **Partner filter and the trend.** Filter the table to one partner and, if it
  is one of the top 20, the page requests `summary-<partner>.html` and the trend
  follows it; otherwise the trend stays on all 30 partners and a line says so.
  Why 20: they carry 91.5% of the 30 partners' trade over the window, and 20 files a month keeps
  the fragment set to 529 files; the other ten partners are 8.5% of the trade
  between them and would add 240 files for a line most readers never ask for.

## What this page cannot do

These are gaps in the grid at 1.81.0, reported rather than worked around.

- **Back and forward reload rather than restore (F-1584-2).** The htmx module's
  history hooks save a grid's state into htmx's snapshot and rebuild grids
  marked `data-lattice-grid` on restore. A grid hydrated from a `<table>` cannot
  be rebuilt: the table was consumed, and the grid's host element carries no
  marker, so a restored snapshot is a picture of a grid, not a grid. The page
  therefore turns htmx's snapshot cache off (`historyCacheSize: 0`,
  `refreshOnHistoryMiss: true`): back and forward reload the page on the month
  in the address and the grid is live, but a sort or filter set before leaving
  a month is not carried back.
- **Chapter codes lose their leading zero (F-1584-1).** Hydration turns cell
  text that reads as a number into a number before a `data-type="text"` on the
  `<th>` is applied, so chapter `01` shows as `1`. The chapter name beside it
  is unaffected.
- **No group subtotals or column widths from the markup (F-1584-4).** Per-column
  options beyond type and format would need `columns` in the config script,
  and that replaces every column read from the table rather than the ones it
  names, so this page does not use it.

## Running it

Node 22 or newer, nothing to install.

```
node tools/render-fragments.mjs                     # read the sibling's copy from GitHub, write fragments/ and index.html
node tools/render-fragments.mjs --from <snapshot>   # the same from a local data/snapshot folder
node tools/serve.mjs                                # serve the folder; open the address it prints
node tools/verify.mjs                               # check it in headless Chrome (needs puppeteer-core)
node tools/verify.mjs --url https://toclocoinc.github.io/lattice-grid-demo-uktradeinfo-htmx/
```

Edit `src/index.template.html`, not `index.html`: the renderer writes the
latter. `.github/workflows/render.yml` runs the renderer weekly and on demand
and commits what changed; GitHub Pages publishes from the branch.

`tools/verify.mjs` fails on any request to the HMRC API, checks the hydrated
row count against the fragment's `<tr>` count, recomputes the tiles from the
fragment, sorts and filters the hydrated grid, swaps months, checks the trend
has 48 points and follows a partner filter, goes back and forward, and fails
on any console error or watermark.

## Files

```
index.html                       written by the renderer from src/index.template.html
main.js                          the wiring: bind tiles and charts on htmx:load
styles.css                       the page around the grid
src/licence.js                   the key for this demo's published address
fragments/index.json             months, newest, copy date, the top-20 partners
fragments/<month>/table.html     the month, its previous-month values, the summary (out of band)
fragments/<month>/summary*.html  the trend, for all 30 partners and for each of the top 20
tools/render-fragments.mjs       the "server": saved copy in, HTML out
tools/hmrc-api.js                the sibling's shaping code, copied unchanged
tools/serve.mjs                  a small static file server
tools/verify.mjs                 the browser check
```

## Licence

The demo code is MIT. See `LICENSE`.

Contains public sector information licensed under the Open Government Licence
v3.0. The trade figures are from HM Revenue & Customs, uktradeinfo.

Lattice Grid itself is a separate commercial product with its own terms. It is
free to use on localhost, with no key and no watermark, so a copy of this
repository runs unrestricted on your own machine. This demo carries a key for
its own published address only, which is why you will find one in the source.
Keys for your own sites come from [latticegrid.dev](https://www.latticegrid.dev).
