#!/usr/bin/env python3
"""
Sync Xbox achievements (OpenXBL) and PlayStation trophies (PSN) into
console-data.json / console-summary.json on the "user" branch.

Environment:
  OPENXBL_KEY   API key from https://xbl.io (optional; Xbox is skipped without it)
  PSN_NPSSO     NPSSO sign-in token from Sony (optional; PlayStation is skipped without it)

Usage:
  python sync_console.py --data <folder with console-data.json>

Only games whose progress changed since the last run are fetched again, so
regular runs are quick. Xbox requests are capped per run to stay inside
OpenXBL's free limit (150 requests/hour); a big first sync finishes over
several runs.

Exit code 0 = everything synced, 2 = a platform failed (its previous data is
kept and the error is written to console-data.json "sources").
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests

MAX_XBOX_CALLS = int(os.environ.get("MAX_XBOX_CALLS", "110"))
MAX_PSN_TITLES = int(os.environ.get("MAX_PSN_TITLES", "500"))


class ProviderError(Exception):
    pass


class BudgetExhausted(Exception):
    pass


def log(msg):
    print(msg, flush=True)


def to_epoch(value):
    """ISO date string -> unix seconds (0 when missing / Xbox's year-1 placeholder)."""
    if not value or not isinstance(value, str) or value.startswith("0001"):
        return 0
    try:
        v = value.replace("Z", "+00:00")
        # Trim fractional seconds beyond 6 digits (Xbox sends 7)
        if "." in v:
            head, rest = v.split(".", 1)
            frac = "".join(ch for ch in rest if ch.isdigit())
            tz = rest[len(frac):]
            v = f"{head}.{frac[:6]}{tz}"
        dt = datetime.fromisoformat(v)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp())
    except ValueError:
        return 0


def percent_str(value):
    try:
        return f"{float(value):.1f}"
    except (TypeError, ValueError):
        return None


def make_entry(appid, name, icon, platform, console, defs, earned, key):
    return {
        "appid": appid,
        "info": {
            "appid": appid,
            "name": name,
            "icon": icon,
            "platform": platform,
            "console": console,
            "achievements": defs,
        },
        "achievements": earned,
        "sync": {"key": key},
    }


# ----------------------------------------------------------------------------
# Xbox (OpenXBL)
# ----------------------------------------------------------------------------

XBL = "https://xbl.io/api/v2"


class Xbox:
    def __init__(self, key):
        self.s = requests.Session()
        self.s.headers.update({
            "X-Authorization": key,
            "Accept": "application/json",
            "Accept-Language": "en-US",
        })
        self.calls = 0

    def get(self, path):
        if self.calls >= MAX_XBOX_CALLS:
            raise BudgetExhausted()
        self.calls += 1
        r = self.s.get(XBL + path, timeout=40)
        if r.status_code in (401, 403):
            raise ProviderError("OpenXBL rejected the API key (OPENXBL_KEY). Check the secret.")
        if r.status_code == 429:
            raise BudgetExhausted()
        if r.status_code >= 400:
            raise ProviderError(f"OpenXBL {path.split('?')[0]} returned HTTP {r.status_code}")
        try:
            return r.json()
        except ValueError:
            raise ProviderError(f"OpenXBL {path.split('?')[0]} did not return JSON")

    @staticmethod
    def platform_label(devices):
        d = set(devices or [])
        if d == {"Xbox360"} or (d and d <= {"Xbox360", "Mobile"}):
            return "Xbox 360"
        if "XboxOne" in d:
            return "Xbox One"
        if "XboxSeries" in d:
            return "Xbox Series X|S"
        if "Xbox360" in d:
            return "Xbox 360"
        if d & {"PC", "Win32"}:
            return "PC (Xbox)"
        return "Xbox"

    def title_achievements(self, xuid, title_id, is360):
        paths = [f"/achievements/x360/{xuid}/title/{title_id}", f"/achievements/player/{xuid}/{title_id}"]
        if not is360:
            paths.reverse()
        for path in paths:
            items = []
            token = None
            for _ in range(6):
                data = self.get(path + (f"?continuationToken={token}" if token else ""))
                if isinstance(data, list):
                    items += data
                    break
                items += data.get("achievements") or []
                token = (data.get("pagingInfo") or {}).get("continuationToken")
                if not token:
                    break
            if items:
                return items
        return []

    @staticmethod
    def parse(item, title_id):
        aid = str(item.get("id"))
        if "progressState" in item:  # Xbox One / Series / PC
            earned = item.get("progressState") == "Achieved"
            t = to_epoch((item.get("progression") or {}).get("timeUnlocked")) if earned else 0
            icon = next((m.get("url") for m in item.get("mediaAssets") or [] if (m.get("type") or "").lower() == "icon" and m.get("url")), "")
            gs = next((r.get("value") for r in item.get("rewards") or [] if (r.get("type") or "").lower() == "gamerscore"), None)
        else:  # Xbox 360
            t = to_epoch(item.get("timeUnlocked"))
            earned = bool(item.get("unlocked") or item.get("unlockedOnline") or t)
            image_id = item.get("imageId")
            icon = ""
            try:
                if image_id:
                    icon = f"https://image-ssl.xboxlive.com/global/t.{int(title_id):x}/ach/0/{int(image_id):x}"
            except (TypeError, ValueError):
                icon = ""
            gs = item.get("gamerscore")
        hidden = bool(item.get("isSecret"))
        desc = item.get("description") or item.get("lockedDescription") or ""
        definition = {
            "name": item.get("name") or aid,
            "description": desc,
            "icon": icon,
            "icongray": icon,
            "hidden": hidden,
            "percent": percent_str((item.get("rarity") or {}).get("currentPercentage")),
            "group": "Base Game",
        }
        if gs not in (None, "", 0, "0"):
            definition["badge"] = f"{gs}G"
            definition["badgeType"] = "gamerscore"
        return aid, definition, {"earned": earned, "earned_time": t}

    def sync(self, previous):
        history = self.get("/player/titleHistory")
        titles = history.get("titles") or (history.get("content") or {}).get("titles") or []
        xuid = history.get("xuid")
        if not xuid:
            account = self.get("/account")
            xuid = ((account.get("profileUsers") or [{}])[0]).get("id")
        if not xuid:
            raise ProviderError("Could not find your Xbox user id (xuid) from OpenXBL.")

        games, fetched, waiting = [], 0, 0
        for t in titles:
            summary = t.get("achievement") or {}
            total = summary.get("totalAchievements") or 0
            if not total and not summary.get("totalGamerscore"):
                continue  # apps and games without achievements
            title_id = str(t.get("titleId"))
            appid = f"xbox-{title_id}"
            key = "|".join(str(x) for x in (
                summary.get("currentAchievements"), summary.get("currentGamerscore"),
                summary.get("totalAchievements"), (t.get("titleHistory") or {}).get("lastTimePlayed")))
            old = previous.get(appid)
            if old and old.get("sync", {}).get("key") == key:
                games.append(old)
                continue
            try:
                devices = t.get("devices") or []
                is360 = summary.get("sourceVersion") == 1 or devices == ["Xbox360"]
                items = self.title_achievements(xuid, title_id, is360)
            except BudgetExhausted:
                waiting += 1
                if old:
                    games.append(old)  # keep showing the old data until the next run
                continue
            defs, earned = {}, {}
            for item in items:
                aid, d, e = self.parse(item, title_id)
                defs[aid] = d
                earned[aid] = e
            if not defs:
                if old:
                    games.append(old)
                continue
            games.append(make_entry(appid, t.get("name") or appid, t.get("displayImage") or "",
                                    self.platform_label(t.get("devices")), "xbox", defs, earned, key))
            fetched += 1
        log(f"Xbox: {len(games)} games, {fetched} updated, {self.calls} API calls"
            + (f", {waiting} waiting for the next run (rate limit)" if waiting else ""))
        return games, waiting


# ----------------------------------------------------------------------------
# PlayStation (PSN)
# ----------------------------------------------------------------------------

PSN_AUTH = "https://ca.account.sony.com/api/authz/v3/oauth"
PSN_API = "https://m.np.playstation.com/api/trophy/v1"
PSN_CLIENT_ID = "09515159-7237-4370-9b40-3806e67c0891"
PSN_BASIC = "Basic MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A="
PSN_REDIRECT = "com.scee.psxandroid.scecompcall://redirect"

PSN_PLATFORMS = {"PS5": "PlayStation 5", "PS4": "PlayStation 4", "PS3": "PlayStation 3", "PSVITA": "PlayStation Vita", "PSPC": "PC (PlayStation)"}


class PlayStation:
    def __init__(self, npsso):
        self.s = requests.Session()
        self.token = self.sign_in(npsso)
        self.s.headers.update({"Authorization": f"Bearer {self.token}", "Accept-Language": "en-US"})

    def sign_in(self, npsso):
        expired = ("Sony didn't accept the PSN_NPSSO token. It has probably expired: "
                   "get a new one (see console/README.md) and update the secret.")
        r = self.s.get(f"{PSN_AUTH}/authorize", params={
            "access_type": "offline", "client_id": PSN_CLIENT_ID, "redirect_uri": PSN_REDIRECT,
            "response_type": "code", "scope": "psn:mobile.v2.core psn:clientapp",
        }, headers={"Cookie": f"npsso={npsso}"}, allow_redirects=False, timeout=30)
        location = r.headers.get("Location", "")
        code = parse_qs(urlparse(location).query).get("code", [None])[0]
        if not code:
            raise ProviderError(expired)
        r = self.s.post(f"{PSN_AUTH}/token", data={
            "code": code, "redirect_uri": PSN_REDIRECT,
            "grant_type": "authorization_code", "token_format": "jwt",
        }, headers={"Authorization": PSN_BASIC, "Content-Type": "application/x-www-form-urlencoded"}, timeout=30)
        token = r.json().get("access_token") if r.ok else None
        if not token:
            raise ProviderError(expired)
        return token

    def get(self, path, params=None):
        for attempt in range(4):
            r = self.s.get(PSN_API + path, params=params, timeout=40)
            if r.status_code == 429:
                time.sleep(10 * (attempt + 1))
                continue
            if r.status_code == 401:
                raise ProviderError("PSN rejected the session. Update the PSN_NPSSO secret.")
            if r.status_code >= 400:
                raise ProviderError(f"PSN {path.split('?')[0]} returned HTTP {r.status_code}")
            time.sleep(0.25)
            return r.json()
        raise ProviderError("PSN kept rate-limiting the requests. Try again later.")

    def titles(self):
        out, offset = [], 0
        while True:
            data = self.get("/users/me/trophyTitles", {"limit": 800, "offset": offset})
            out += data.get("trophyTitles") or []
            nxt = data.get("nextOffset")
            if not nxt or nxt <= offset:
                return out
            offset = nxt

    def sync(self, previous):
        games, fetched, waiting = [], 0, 0
        for t in self.titles():
            comm_id = t.get("npCommunicationId")
            service = t.get("npServiceName") or "trophy"
            if not comm_id:
                continue
            appid = f"psn-{comm_id}"
            key = "|".join(str(x) for x in (t.get("lastUpdatedDateTime"), t.get("progress"),
                                            json.dumps(t.get("earnedTrophies"), sort_keys=True)))
            old = previous.get(appid)
            if old and old.get("sync", {}).get("key") == key:
                games.append(old)
                continue
            if fetched >= MAX_PSN_TITLES:
                waiting += 1
                if old:
                    games.append(old)
                continue
            params = {"npServiceName": service}
            definitions = self.get(f"/npCommunicationIds/{comm_id}/trophyGroups/all/trophies", params).get("trophies") or []
            progress = self.get(f"/users/me/npCommunicationIds/{comm_id}/trophyGroups/all/trophies", params).get("trophies") or []
            groups = {}
            try:
                for g in self.get(f"/npCommunicationIds/{comm_id}/trophyGroups", params).get("trophyGroups") or []:
                    groups[g.get("trophyGroupId")] = g.get("trophyGroupName")
            except ProviderError:
                pass
            earned_by_id = {p.get("trophyId"): p for p in progress}

            defs, earned = {}, {}
            for d in definitions:
                tid = d.get("trophyId")
                p = earned_by_id.get(tid, {})
                key_id = str(tid)
                group_id = d.get("trophyGroupId") or "default"
                kind = (d.get("trophyType") or "").lower()
                defs[key_id] = {
                    "name": d.get("trophyName") or f"Trophy {tid}",
                    "description": d.get("trophyDetail") or "",
                    "icon": d.get("trophyIconUrl") or "",
                    "icongray": d.get("trophyIconUrl") or "",
                    "hidden": bool(d.get("trophyHidden")),
                    "percent": percent_str(p.get("trophyEarnedRate")),
                    "group": "Base Game" if group_id == "default" else (groups.get(group_id) or f"Pack {group_id}"),
                    "badge": kind.capitalize() if kind else None,
                    "badgeType": kind or None,
                }
                is_earned = bool(p.get("earned"))
                earned[key_id] = {"earned": is_earned, "earned_time": to_epoch(p.get("earnedDateTime")) if is_earned else 0}
            if not defs:
                if old:
                    games.append(old)
                continue
            plats = [x.strip() for x in str(t.get("trophyTitlePlatform") or "").split(",") if x.strip()]
            platform = PSN_PLATFORMS.get(plats[0], plats[0]) if plats else "PlayStation"
            games.append(make_entry(appid, t.get("trophyTitleName") or comm_id, t.get("trophyTitleIconUrl") or "",
                                    platform, "playstation", defs, earned, key))
            fetched += 1
        log(f"PlayStation: {len(games)} games, {fetched} updated"
            + (f", {waiting} waiting for the next run" if waiting else ""))
        return games, waiting


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

def summarize(entry):
    defs = entry["info"]["achievements"]
    got = entry["achievements"]
    unlocked = sum(1 for k in defs if (got.get(k) or {}).get("earned"))
    last = max([(got.get(k) or {}).get("earned_time") or 0 for k in defs] or [0])
    total = len(defs)
    return {
        "appid": entry["appid"],
        "name": entry["info"]["name"],
        "icon": entry["info"]["icon"],
        "platform": entry["info"]["platform"],
        "console": entry["info"]["console"],
        "total": total,
        "unlocked": unlocked,
        "percent": round(unlocked * 100 / total) if total else 0,
        "lastUnlock": last,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="folder that holds console-data.json (user branch checkout)")
    args = ap.parse_args()
    folder = Path(args.data)
    data_file = folder / "console-data.json"
    summary_file = folder / "console-summary.json"

    previous_doc = {}
    if data_file.exists():
        try:
            previous_doc = json.loads(data_file.read_text(encoding="utf-8"))
        except ValueError:
            log("Existing console-data.json is unreadable; starting fresh.")
    previous_games = previous_doc.get("games") or []
    by_console = {"xbox": {}, "playstation": {}}
    for g in previous_games:
        c = (g.get("info") or {}).get("console")
        if c in by_console:
            by_console[c][g["appid"]] = g

    sources = previous_doc.get("sources") or {}
    failed = False
    results = {}
    now = int(time.time())

    providers = [
        ("xbox", "OPENXBL_KEY", Xbox),
        ("playstation", "PSN_NPSSO", PlayStation),
    ]
    for name, env, cls in providers:
        secret = os.environ.get(env, "").strip()
        if not secret:
            log(f"{name}: {env} is not set, skipping (keeping {len(by_console[name])} saved games).")
            results[name] = list(by_console[name].values())
            sources[name] = {**sources.get(name, {}), "status": "not configured"}
            continue
        try:
            client = cls(secret)
            games, waiting = client.sync(by_console[name])
            results[name] = games
            sources[name] = {"status": "ok", "synced": now, "games": len(games), "waiting": waiting}
        except BudgetExhausted:  # rate limit hit before anything was fetched: just try next run
            log(f"{name}: rate limit reached, trying again next run.")
            results[name] = list(by_console[name].values())
            sources[name] = {**sources.get(name, {}), "status": "waiting for rate limit"}
        except Exception as e:  # keep old data for this platform, report the error
            failed = True
            message = str(e) if isinstance(e, ProviderError) else f"{type(e).__name__}: {e}"
            log(f"{name}: ERROR {message}")
            results[name] = list(by_console[name].values())
            sources[name] = {**sources.get(name, {}), "status": "error", "error": message, "errorAt": now}

    games = sorted(results["xbox"] + results["playstation"], key=lambda g: g["info"]["name"].lower())
    doc = {"last_updated": now, "sources": sources, "games": games}
    data_file.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    summary = {"last_updated": now, "sources": sources, "games": [summarize(g) for g in games]}
    summary_file.write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"Wrote {len(games)} console games.")
    sys.exit(2 if failed else 0)


if __name__ == "__main__":
    main()
