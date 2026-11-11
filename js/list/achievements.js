// Reads the achievement data the watcher pushes to the "user" branch
// (game-data.json, built by the Fetch Steam Game Data workflow) and turns it
// into a small per-game progress summary for the game list.
import { achievementRepo } from './firebase-config.js';

const SUMMARY_CACHE_KEY = 'gamelist-achievement-summary-v1';

export function getSourceRepo() {
  const host = location.hostname;
  const path = location.pathname.split('/').filter(Boolean);
  if (host.endsWith('.github.io') && path.length > 0) {
    return { owner: host.replace('.github.io', ''), repo: path[0], branch: achievementRepo.branch || 'user' };
  }
  return { ...achievementRepo };
}

function isUnlocked(entry) {
  if (!entry) return false;
  const v = entry.earned ?? entry.unlocked ?? entry.achieved;
  return v === true || v === 1 || v === '1';
}

function unlockTime(entry) {
  if (!entry) return 0;
  return Number(entry.earned_time || entry.unlock_time || entry.unlocktime || 0) || 0;
}

function summarize(game) {
  const info = game.info || {};
  const blacklist = new Set(info.blacklist || []);

  // .db (Achievement Watcher Steam cache) files are arrays of {apiname, achieved, unlocktime}
  let userAch = game.achievements || {};
  if (Array.isArray(userAch)) {
    userAch = Object.fromEntries(userAch.map((a) => [a.apiname, a]));
  }

  const defs = info.achievements && Object.keys(info.achievements).length ? info.achievements : userAch;
  let total = 0;
  let unlocked = 0;
  let lastUnlock = 0;
  for (const key of Object.keys(defs)) {
    if (blacklist.has(key)) continue;
    total++;
    const entry = userAch[key];
    if (isUnlocked(entry)) {
      unlocked++;
      lastUnlock = Math.max(lastUnlock, unlockTime(entry));
    }
  }

  const appid = String(game.appid || info.appid);
  return {
    appid,
    name: info.name || `Game ${appid}`,
    icon: info.icon || steamCover(appid),
    platform: info.platform || null,
    total,
    unlocked,
    percent: total ? Math.round((unlocked / total) * 100) : 0,
    lastUnlock, // unix seconds
  };
}

export function steamCover(appid) {
  return appid ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg` : '';
}

// Returns { games: Map<appid, summary>, lastUpdated, source, fromCache }
export async function loadAchievementSummaries() {
  const src = getSourceRepo();
  const url = `https://raw.githubusercontent.com/${src.owner}/${src.repo}/${src.branch}/game-data.json`;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.games || [];
    const summaries = list.map(summarize).filter((s) => s.appid && s.appid !== 'undefined');
    summaries.push(...(await loadConsoleSummaries(src)));
    const result = { games: new Map(summaries.map((s) => [s.appid, s])), lastUpdated: data.last_updated || null, source: src };
    try {
      localStorage.setItem(SUMMARY_CACHE_KEY, JSON.stringify({ summaries, lastUpdated: result.lastUpdated }));
    } catch { /* cache is optional */ }
    return { ...result, fromCache: false };
  } catch (err) {
    console.warn('Could not load achievement data:', err);
    try {
      const cached = JSON.parse(localStorage.getItem(SUMMARY_CACHE_KEY) || 'null');
      if (cached) {
        return { games: new Map(cached.summaries.map((s) => [s.appid, s])), lastUpdated: cached.lastUpdated, source: src, fromCache: true };
      }
    } catch { /* ignore */ }
    return { games: new Map(), lastUpdated: null, source: src, fromCache: false, error: err };
  }
}

// Xbox / PlayStation progress synced by the console workflow (small summary file)
async function loadConsoleSummaries(src) {
  try {
    const url = `https://raw.githubusercontent.com/${src.owner}/${src.repo}/${src.branch}/console-summary.json`;
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.games || [])
      .filter((g) => g && g.appid)
      .map((g) => ({ ...g, appid: String(g.appid), icon: g.icon || '' }));
  } catch {
    return [];
  }
}

// Which console achievement system a list entry's platform belongs to.
// Only platforms that have achievements/trophies (no PS1/PS2/original Xbox).
export function consoleFamily(platform) {
  const p = String(platform || '').toLowerCase();
  if (/xbox\s*(360|one|series)/.test(p)) return 'xbox';
  if (/playstation\s*(3|4|5|vita)|^ps\s*(3|4|5)(?!\d)|ps\s*vita/.test(p)) return 'playstation';
  return null;
}

// Suggests a list status from achievement progress.
export function suggestStatus(summary) {
  if (!summary || !summary.total) return 'playing';
  if (summary.percent >= 100) return 'completed';
  if (summary.percent >= 75) return 'almost';
  if (summary.unlocked === 0) return 'plan';
  return 'playing';
}
