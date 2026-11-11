// Reads a MyVideoGameList list export (JSON) and turns it into game list entries.
//
// Export rows look like:
//   { entry_id, game_id, list_title, game_title, platform, status, rating,
//     hours_played: "50-60 Hours", started_date: "2017-08-22", finished_date, notes, ... }

const STATUS_MAP = {
  'completed': 'completed',
  'beaten': 'completed',
  'plan to play': 'plan',
  'wishlist': 'plan',
  'on hold': 'plan',
  'playing': 'playing',
  'continuously playing': 'playing',
  'replaying': 'playing',
  'almost done': 'almost',
};

// "Far Cry® 6" and "Far Cry 6" -> "farcry6"
export function normalizeTitle(title) {
  return String(title || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

export function normalizePlatform(platform) {
  const p = String(platform || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!p || p === 'pc' || p === 'windows' || p === 'steam' || p === 'steamdeck') return 'pc';
  return p;
}

export function entryKey(title, platform) {
  return normalizeTitle(title) + '|' + normalizePlatform(platform);
}

function firstNumber(text) {
  const m = String(text || '').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function isoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

// Throws a readable error if the file isn't a MyVideoGameList export.
export function parseMvglExport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  const rows = Array.isArray(data) ? data : (data && (data.games || data.list || data.entries)) || null;
  if (!Array.isArray(rows) || !rows.some((r) => r && (r.game_title || r.list_title) && 'status' in r)) {
    throw new Error("That doesn't look like a MyVideoGameList list export.");
  }

  const entries = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    // game_title is the clean catalog name; list_title can have "(2016)" or encoding damage
    const title = String(r.game_title || r.list_title || '').trim();
    if (!title) continue;

    const mvglStatus = String(r.status || '').trim();
    const status = STATUS_MAP[mvglStatus.toLowerCase()] || 'playing';
    const score = Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 10 ? r.rating : null;

    const noteParts = [];
    if (r.notes) noteParts.push(String(r.notes).trim());
    if (mvglStatus.toLowerCase() === 'continuously playing') noteParts.push('Continuously playing');
    if (r.hours_played && /\D/.test(String(r.hours_played))) noteParts.push(`Hours: ${r.hours_played}`);

    entries.push({
      title: title.slice(0, 150),
      status,
      mvglStatus,
      platform: r.platform ? String(r.platform).slice(0, 40) : null,
      score,
      hours: firstNumber(r.hours_played),
      startedAt: isoDate(r.started_date),
      finishedAt: isoDate(r.finished_date),
      notes: noteParts.length ? noteParts.join(' · ').slice(0, 2000) : null,
      mvglEntryId: Number.isFinite(r.entry_id) ? r.entry_id : null,
    });
  }
  return entries;
}
