// Finds box art for games that have no Steam AppID and no custom cover,
// using the English Wikipedia article's main image (the infobox cover).
//
// 1. Exact title lookups, 50 titles per request, trying variants such as
//    "Title (video game)", "Title (2004 video game)" and the title without
//    "Definitive Edition" / "Remastered" etc.
// 2. For anything still missing, a slow search (about 1 per second) that only
//    accepts a result whose title matches and whose description says it's a game.

const API = 'https://en.wikipedia.org/w/api.php';
const THUMB_SIZE = 600;

const EDITION = /\s*(?:[:\-–])?\s*(?:definitive edition|remastered|hd remastered|hd remaster|game of the year edition|goty edition|complete edition|enhanced edition|special edition|deluxe edition|ultimate edition|anniversary edition|director's cut|re-elected|year-one survival edition|storm warning edition|final mix|hd|remake)\s*$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clean(title) {
  return String(title || '').replace(/�|’/g, "'").replace(/\s+/g, ' ').trim();
}

function norm(title) {
  return clean(title)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

export function titleVariants(title) {
  const t = clean(title);
  const out = [];
  const year = t.match(/^(.*)\((\d{4})\)\s*$/);
  const base = t.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  if (year) out.push(`${year[1].trim()} (${year[2]} video game)`);
  out.push(base, `${base} (video game)`);
  const stripped = base.replace(EDITION, '').trim();
  if (stripped && stripped !== base) out.push(stripped, `${stripped} (video game)`);
  return [...new Set(out)];
}

function isGamePage(page) {
  const d = (page.description || '').toLowerCase();
  return Boolean(page.thumbnail) && d.includes('game') && !/series|franchise|list/.test(d);
}

async function api(params, attempt = 0) {
  const url = API + '?' + new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params });
  const res = await fetch(url);
  if (res.status === 429 && attempt < 4) {
    await sleep(5000 * (attempt + 1));
    return api(params, attempt + 1);
  }
  if (!res.ok) throw new Error(`Wikipedia ${res.status}`);
  return res.json();
}

async function lookupExact(titles) {
  const found = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const chunk = titles.slice(i, i + 50);
    const data = await api({
      action: 'query', titles: chunk.join('|'), redirects: '1',
      prop: 'pageimages|description', piprop: 'thumbnail', pithumbsize: String(THUMB_SIZE), pilicense: 'any',
    });
    const q = data.query || {};
    const alias = new Map();
    for (const n of [...(q.normalized || []), ...(q.redirects || [])]) alias.set(n.from, n.to);
    const pages = new Map((q.pages || []).map((p) => [p.title, p]));
    for (const t of chunk) {
      let x = t;
      for (let hops = 0; alias.has(x) && hops < 5; hops++) x = alias.get(x);
      const p = pages.get(x);
      if (p && isGamePage(p)) found.set(t, p.thumbnail.source);
    }
    await sleep(500);
  }
  return found;
}

async function searchOne(title) {
  const query = clean(title).replace(/\([^)]*\)/g, '').trim();
  const data = await api({
    action: 'query', generator: 'search', gsrsearch: `${query} video game`, gsrlimit: '5',
    prop: 'pageimages|description', piprop: 'thumbnail', pithumbsize: String(THUMB_SIZE), pilicense: 'any',
  });
  const want = norm(title);
  const pages = ((data.query || {}).pages || []).sort((a, b) => (a.index || 99) - (b.index || 99));
  for (const p of pages) {
    const pt = norm(p.title);
    if (isGamePage(p) && (pt === want || pt.startsWith(want) || want.startsWith(pt))) return p.thumbnail.source;
  }
  return null;
}

// titles: string[]. onResult(title, url|null) is called once per title.
export async function findCovers(titles, onResult) {
  const unique = [...new Set(titles)];
  const variantsOf = new Map(unique.map((t) => [t, titleVariants(t)]));
  const found = await lookupExact([...new Set([...variantsOf.values()].flat())]);

  const missing = [];
  for (const t of unique) {
    const hit = variantsOf.get(t).find((v) => found.has(v));
    if (hit) await onResult(t, found.get(hit));
    else missing.push(t);
  }

  for (const t of missing) {
    let url = null;
    try { url = await searchOne(t); } catch { /* treat as not found */ }
    await onResult(t, url);
    await sleep(1000);
  }
}
