// Game title search for the Add game dialog.
// Uses Wikipedia articles that have a video game infobox (titles, year, box art)
// and Wikidata for the platforms a game was released on. No API key needed.

const WIKI = 'https://en.wikipedia.org/w/api.php';
const WIKIDATA = 'https://www.wikidata.org/w/api.php';

// Wikidata platform names → the names used on the list
const PLATFORM_NAMES = {
  'Microsoft Windows': 'PC',
  'Xbox Series X and Series S': 'Xbox Series X|S',
  'Xbox Series X/S': 'Xbox Series X|S',
  'Nintendo Entertainment System': 'NES',
  'Super Nintendo Entertainment System': 'SNES',
  'PlayStation (console)': 'PlayStation',
  'Xbox (console)': 'Xbox',
};
const SKIP_PLATFORMS = new Set(['Linux', 'macOS', 'Classic Mac OS', 'Stadia', 'Amazon Luna', 'cloud gaming', 'Web browser']);

function api(base, params) {
  const url = new URL(base);
  for (const [k, v] of Object.entries({ format: 'json', origin: '*', ...params })) url.searchParams.set(k, v);
  return url;
}

async function getJson(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// "The Legend of Zelda: Ocarina of Time (2026 video game)" → title + year
export function splitWikiTitle(wikiTitle, description = '') {
  const m = wikiTitle.match(/^(.*?)\s*\(((?:\d{4}\s+)?(?:video\s+)?game|[^)]*video game[^)]*)\)$/i);
  const title = m ? m[1] : wikiTitle;
  const year = (wikiTitle.match(/\((\d{4})\b/) || String(description).match(/\b(19[5-9]\d|20\d\d)\b/) || [])[1] || '';
  return { title, year };
}

function words(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) || [];
}

// Every typed word is the start of a word in the title (so "zel oca" matches)
export function titleMatches(title, query) {
  const t = words(title);
  return words(query).every((q) => t.some((w) => w.startsWith(q)));
}

function cleanQuery(q) {
  return q.replace(/["~*\\:()[\]{}<>!^|&]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function runSearch(search, signal) {
  const data = await getJson(api(WIKI, {
    action: 'query',
    generator: 'search',
    gsrsearch: `${search} hastemplate:"Infobox video game"`,
    gsrlimit: '15',
    gsrnamespace: '0',
    prop: 'description|pageimages',
    piprop: 'thumbnail',
    pithumbsize: '600', // same size as the automatic covers
    pilicense: 'any',
  }), signal);
  return Object.values((data.query && data.query.pages) || {}).sort((a, b) => a.index - b.index);
}

// Returns [{ title, wikiTitle, year, description, cover }]
export async function searchGames(query, { signal } = {}) {
  const q = cleanQuery(query);
  if (q.length < 2) return [];
  const last = q.split(' ').pop();
  // Short last word: match it as a prefix ("zel" → "zel*") so results show while typing
  let pages = await runSearch(last.length < 4 ? `${q}*` : q, signal);
  if (!pages.length && last.length >= 4) pages = await runSearch(`${q}*`, signal);

  const seen = new Set();
  const results = [];
  for (const p of pages) {
    // Skip lists and collections ("List of …", "… games from … series", description "Video games")
    if (/^List of\b|\bgames from\b|\bseries\)?$/i.test(p.title) || /^video games$/i.test(p.description || '')) continue;
    const { title, year } = splitWikiTitle(p.title, p.description);
    const key = `${title.toLowerCase()}|${year}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      title,
      wikiTitle: p.title,
      year,
      description: p.description || '',
      cover: (p.thumbnail && p.thumbnail.source) || '',
      match: titleMatches(title, q),
    });
  }
  // Titles containing what was typed first, then Wikipedia's order.
  // Loosely related games only fill up a short list.
  results.sort((a, b) => Number(b.match) - Number(a.match));
  const matching = results.filter((r) => r.match).length;
  return results.filter((r) => r.match || matching < 5).slice(0, 10);
}

// Platforms a game came out on, e.g. ["Nintendo Switch 2"]
export async function gamePlatforms(wikiTitle, { signal } = {}) {
  const page = await getJson(api(WIKI, { action: 'query', prop: 'pageprops', ppprop: 'wikibase_item', titles: wikiTitle, redirects: '1' }), signal);
  const item = Object.values(page.query.pages || {})[0];
  const qid = item && item.pageprops && item.pageprops.wikibase_item;
  if (!qid) return [];
  const entity = await getJson(api(WIKIDATA, { action: 'wbgetentities', ids: qid, props: 'claims' }), signal);
  const ids = ((entity.entities[qid].claims || {}).P400 || [])
    .map((c) => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value.id)
    .filter(Boolean)
    .slice(0, 40);
  if (!ids.length) return [];
  const labels = await getJson(api(WIKIDATA, {
    action: 'wbgetentities', ids: ids.join('|'), props: 'labels|sitelinks', languages: 'en|mul', sitefilter: 'enwiki',
  }), signal);
  const names = [];
  for (const id of ids) {
    const e = labels.entities[id] || {};
    const raw = (e.labels && ((e.labels.en && e.labels.en.value) || (e.labels.mul && e.labels.mul.value)))
      || (e.sitelinks && e.sitelinks.enwiki && e.sitelinks.enwiki.title);
    if (!raw || SKIP_PLATFORMS.has(raw)) continue;
    const name = PLATFORM_NAMES[raw] || raw;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}
