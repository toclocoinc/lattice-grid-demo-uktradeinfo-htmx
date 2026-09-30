/**
 * The HMRC uktradeinfo API, and the shape of the data this demo keeps.
 *
 * Nothing here knows about the grid. It builds the queries the snapshot tool
 * sends, turns what the API answers into flat rows, and reads those rows back
 * out of the saved copy. The page and the snapshot tool run this same file,
 * which is why it looks for `globalThis` rather than `window` and why it is a
 * classic script rather than a module.
 *
 * The API answers without an `Access-Control-Allow-Origin` header, so a
 * browser on any other web address cannot read it. The page therefore never
 * calls it: `tools/build-snapshot.mjs` does, under Node, and commits what it
 * fetched to `data/snapshot/`. The page reads that.
 *
 * Trade figures are published under the Open Government Licence v3.0.
 * Source: HM Revenue & Customs, uktradeinfo.
 */
(function (root) {
  'use strict';

  const API = 'https://api.uktradeinfo.com';

  /** How many months the saved copy holds, ending at the newest published one. */
  const WINDOW_MONTHS = 24;

  /** How many partner countries the saved copy keeps, by total trade over the window. */
  const PARTNER_COUNT = 30;

  /**
   * The API's four flow types folded into two. HMRC splits imports and exports
   * by whether the partner is in the EU, which is a fact about the partner
   * rather than about the trade, so the two halves are added back together.
   */
  const FLOW_OF = { 1: 'I', 2: 'X', 3: 'I', 4: 'X' };
  const FLOW_LABELS = { I: 'Imports', X: 'Exports' };

  /**
   * Rows in the Country table that are not countries: HMRC's buckets for
   * trade below the reporting threshold, estimates, ships' stores and
   * confidential trade, and the "Other ..." regional remainders. They are kept
   * out of the partner league table but counted in the whole-world totals.
   */
  const NOT_A_COUNTRY = new Set([951, 952, 958, 959, 962, 977, 1001, 1002, 1003, 1004, 1005, 1006, 1007]);

  /**
   * The twenty-one sections of the Harmonised System, each a run of chapters.
   * The API has no section table, and the sections are how a reader thinks
   * about ninety-seven chapters.
   */
  const SECTIONS = [
    ['I', 1, 5, 'Live animals and animal products', 'Animal products'],
    ['II', 6, 14, 'Vegetable products', 'Vegetables'],
    ['III', 15, 15, 'Animal and vegetable fats and oils', 'Fats and oils'],
    ['IV', 16, 24, 'Prepared foodstuffs, beverages and tobacco', 'Food and drink'],
    ['V', 25, 27, 'Mineral products', 'Minerals, fuels'],
    ['VI', 28, 38, 'Chemical products', 'Chemicals'],
    ['VII', 39, 40, 'Plastics and rubber', 'Plastics'],
    ['VIII', 41, 43, 'Hides, skins, leather and fur', 'Leather'],
    ['IX', 44, 46, 'Wood, cork and basketware', 'Wood'],
    ['X', 47, 49, 'Pulp, paper and printed matter', 'Paper'],
    ['XI', 50, 63, 'Textiles and clothing', 'Textiles'],
    ['XII', 64, 67, 'Footwear, headgear and umbrellas', 'Footwear'],
    ['XIII', 68, 70, 'Stone, ceramics and glass', 'Stone and glass'],
    ['XIV', 71, 71, 'Precious stones and metals', 'Precious metals'],
    ['XV', 72, 83, 'Base metals', 'Base metals'],
    ['XVI', 84, 85, 'Machinery and electrical equipment', 'Machinery'],
    ['XVII', 86, 89, 'Vehicles, aircraft and vessels', 'Vehicles'],
    ['XVIII', 90, 92, 'Instruments, clocks and musical instruments', 'Instruments'],
    ['XIX', 93, 93, 'Arms and ammunition', 'Arms'],
    ['XX', 94, 96, 'Miscellaneous manufactured articles', 'Misc. goods'],
    ['XXI', 97, 99, 'Works of art, antiques and unclassified', 'Art, antiques'],
  ];

  /**
   * HMRC's world regions, as the Country table names them, and a short form
   * of each that fits a chart label.
   */
  const REGION_SHORT = {
    'European Union': 'EU',
    'Western Europe exc EU': 'W Europe, non-EU',
    'Eastern Europe exc EU': 'E Europe, non-EU',
    'North America': 'North America',
    'Latin America and Caribbean': 'Latin America',
    'Middle East and N Africa': 'Middle East, N Africa',
    'Sub-Saharan Africa': 'Sub-Saharan Africa',
    'Asia and Oceania': 'Asia and Oceania',
  };

  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  /* ------------------------------------------------------------------ */
  /* Months                                                              */
  /* ------------------------------------------------------------------ */

  /** `'2026-07'` to the API's `202607`. */
  function monthId(month) {
    return Number(month.replace('-', ''));
  }

  /** The API's `202607` to `'2026-07'`. */
  function monthKey(id) {
    const text = String(id);
    return `${text.slice(0, 4)}-${text.slice(4, 6)}`;
  }

  /** `'2026-07'` as `July 2026`. */
  function monthLabel(month) {
    const [year, mon] = month.split('-').map(Number);
    return `${MONTH_NAMES[mon - 1]} ${year}`;
  }

  /** The month before `'2026-07'`, which is `'2026-06'`. */
  function previousMonth(month) {
    const [year, mon] = month.split('-').map(Number);
    const d = new Date(Date.UTC(year, mon - 2, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /** `count` months ending at `newest`, oldest first. */
  function monthsEndingAt(newest, count) {
    const out = [newest];
    while (out.length < count) out.unshift(previousMonth(out[0]));
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Queries                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * One month of trade, added up to chapter by partner by flow.
   *
   * The OTS table holds a row per eight-digit commodity code, per partner,
   * per port, per flow, per month: several hundred thousand rows a month. The
   * API's `$apply` does the adding up on its side, grouping on the commodity's
   * two-digit chapter through the navigation property, so one request returns
   * the fifteen thousand or so rows this demo keeps rather than the rows they
   * were added up from. The two-digit `CommodityId` rows the table also holds
   * are placeholders for trade recorded at chapter level only, not chapter
   * totals; grouping on `Commodity/Hs2Code` folds them in where they belong.
   *
   * @param {number} id a month id such as 202607
   * @returns {string} the request URL
   */
  function monthQuery(id) {
    const apply =
      `filter(MonthId eq ${id})` +
      '/groupby((Commodity/Hs2Code,CountryId,FlowTypeId),' +
      'aggregate(Value with sum as Value,NetMass with sum as NetMass))';
    return `${API}/OTS?$apply=${encodeURIComponent(apply)}`;
  }

  /** Does a month have any trade published yet? One row is enough to say. */
  function monthProbeQuery(id) {
    return `${API}/OTS?$filter=${encodeURIComponent(`MonthId eq ${id}`)}&$top=1`;
  }

  /** The months the API knows about in a year. It lists a month once it is published. */
  function yearQuery(year) {
    return `${API}/Date?$filter=${encodeURIComponent(`Year eq ${year}`)}`;
  }

  /** Every partner country, with its region. */
  function countryQuery() {
    return `${API}/Country`;
  }

  /** The chapter names, one row per two-digit code. */
  function chapterQuery() {
    return `${API}/Commodity?$apply=${encodeURIComponent('groupby((Hs2Code,Hs2Description))')}`;
  }

  /* ------------------------------------------------------------------ */
  /* Shaping                                                             */
  /* ------------------------------------------------------------------ */

  /** The section a chapter belongs to, or null for a code outside the system. */
  function sectionOf(chapter) {
    const n = Number(chapter);
    for (const [code, from, to, name, short] of SECTIONS) {
      if (n >= from && n <= to) return { code, name, short };
    }
    return null;
  }

  /** A row's identity across the whole dataset. */
  function rowId(month, chapter, countryId, flow) {
    return `${month}|${chapter}|${countryId}|${flow}`;
  }

  /** The identity of a chapter, partner and flow, whichever month. */
  function seriesKey(chapter, countryId, flow) {
    return `${chapter}|${countryId}|${flow}`;
  }

  /**
   * Fold one month's API answer into chapter by partner by flow.
   *
   * The API has grouped by its four flow types; this adds the EU and non-EU
   * halves of each direction together. Rows with no chapter are HMRC's
   * estimates for trade below the reporting threshold, which have no
   * commodity at all; they are counted in the whole-world totals and nowhere
   * else. Net mass is summed where it was published and left null where it
   * was suppressed throughout.
   *
   * @param {object[]} apiRows the `value` array of a {@link monthQuery} answer
   * @returns {{ folded: Map<string, object>, world: { I: number, X: number } }}
   */
  function foldMonth(apiRows) {
    const folded = new Map();
    const world = { I: 0, X: 0 };
    for (const r of apiRows) {
      const flow = FLOW_OF[r.FlowTypeId];
      if (!flow) continue;
      const value = Number(r.Value) || 0;
      world[flow] += value;
      const chapter = r.Commodity && r.Commodity.Hs2Code;
      if (!chapter) continue;
      const key = seriesKey(chapter, r.CountryId, flow);
      let row = folded.get(key);
      if (!row) {
        row = { chapter, countryId: r.CountryId, flow, value: 0, mass: null };
        folded.set(key, row);
      }
      row.value += value;
      if (typeof r.NetMass === 'number') row.mass = (row.mass || 0) + r.NetMass;
    }
    return { folded, world };
  }

  /** The columns a saved month file carries, in order. */
  const MONTH_COLUMNS = ['chapter', 'country', 'flow', 'value', 'mass'];

  /**
   * One month as it is written to disk: a column list and an array of arrays,
   * which is about a third the size of an array of objects.
   *
   * @param {string} month `'2026-07'`
   * @param {Map<string, object>} folded from {@link foldMonth}
   * @param {Set<number>} partnerIds the partners to keep
   * @returns {object} the file's content
   */
  function encodeMonth(month, folded, partnerIds) {
    const rows = [];
    for (const row of folded.values()) {
      if (!partnerIds.has(row.countryId)) continue;
      rows.push([row.chapter, row.countryId, row.flow, Math.round(row.value), row.mass == null ? null : Math.round(row.mass)]);
    }
    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1] || (a[2] < b[2] ? -1 : 1)));
    return { month, columns: MONTH_COLUMNS, rows };
  }

  /**
   * Read a saved month back into the flat rows the grid holds.
   *
   * Every field the views need is put on the row here, once, so the grid can
   * group by section or partner and a chart can add up by region without
   * anything being derived on every pass.
   *
   * @param {object} file the content of a saved month file
   * @param {object} lookups `meta.json`'s `partners` and `chapters`
   * @returns {object[]} the rows
   */
  function decodeMonth(file, lookups) {
    const partnerById = new Map(lookups.partners.map((p) => [p.id, p]));
    const columns = file.columns || MONTH_COLUMNS;
    const at = Object.fromEntries(columns.map((name, i) => [name, i]));
    const month = file.month;
    const label = monthLabel(month);
    const rows = [];
    for (const cells of file.rows) {
      const chapter = cells[at.chapter];
      const countryId = cells[at.country];
      const flow = cells[at.flow];
      const partner = partnerById.get(countryId);
      if (!partner) continue;
      const section = sectionOf(chapter) || { code: '-', name: 'Unclassified', short: 'Unclassified' };
      const value = Number(cells[at.value]) || 0;
      const mass = cells[at.mass];
      rows.push({
        id: rowId(month, chapter, countryId, flow),
        key: seriesKey(chapter, countryId, flow),
        month,
        monthLabel: label,
        chapter,
        chapterName: lookups.chapters[chapter] || `Chapter ${chapter}`,
        section: section.code,
        sectionName: section.name,
        /* The section as a chart labels it: the numeral and a word or two. */
        sectionShort: `${section.code} ${section.short}`,
        countryId,
        partner: partner.name,
        region: partner.region,
        regionShort: REGION_SHORT[partner.region] || partner.region,
        flow: FLOW_LABELS[flow],
        value,
        /* Tonnes, from the kilograms HMRC publishes; null where it was suppressed. */
        mass: typeof mass === 'number' ? mass / 1000 : null,
        /* Exports count towards the balance, imports against it, so the sum of
           this column over any set of rows is the trade balance for that set. */
        balance: flow === 'X' ? value : -value,
        count: 1,
      });
    }
    return rows;
  }

  root.TradeDemo = Object.assign(root.TradeDemo || {}, {
    API,
    WINDOW_MONTHS,
    PARTNER_COUNT,
    FLOW_OF,
    FLOW_LABELS,
    NOT_A_COUNTRY,
    SECTIONS,
    REGION_SHORT,
    MONTH_COLUMNS,
    monthId,
    monthKey,
    monthLabel,
    previousMonth,
    monthsEndingAt,
    monthQuery,
    monthProbeQuery,
    yearQuery,
    countryQuery,
    chapterQuery,
    sectionOf,
    rowId,
    seriesKey,
    foldMonth,
    encodeMonth,
    decodeMonth,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
