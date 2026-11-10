# My Game List

A personal game tracker with achievement progress, hosted on GitHub Pages.

- **Game list** (`list.html`): track games as Currently Playing, Almost Done, Completed or Plan to Play, with score, hours, dates and notes. Sign in with email/password or Google (Firebase). Your list is saved in Firestore and works on any device.
- **Achievement viewer** (`index.html`): every game your emulator achievement files cover, with names, icons, rarity, hidden achievement descriptions and 100% tracking.
- **Achievement watcher** (`watcher/`): Windows scripts that push new `achievements.json` files from GSE / Goldberg saves to GitHub as you unlock them.

Live site: <https://maumit.github.io/mygamelist/>

## How it fits together

```
Game / emulator writes achievements.json
        │   watcher/achievement-watcher.ps1 copies it, commits, pushes
        ▼
user branch: AppID/<appid>/achievements.json
        │   "Update Achievement Data (on push)" workflow (changed games only)
        ▼
user branch: game-data.json
        │
        ├──▶ index.html   Achievement viewer
        └──▶ list.html    My Game List (progress bars, import, status hints)
```

## Branches

| Branch | Contents |
|---|---|
| `main` | The website, workflows, Python data scripts and the watcher scripts. GitHub Pages deploys from here. |
| `user` | Your data: `AppID/<appid>/` achievement files, generated `game-info.json`, `game-data.json` and `top_owners.json`. |

## Setup

1. **Pages:** Settings → Pages → Source: **GitHub Actions**. The `Deploy GitHub Pages` workflow publishes `main` on every push.
2. **Steam API key:** Settings → Secrets and variables → Actions → add `STEAM_API_KEY`. The data workflow uses it to fetch game names, icons and achievement details.
3. **Firebase (game list login):** see [GAME-LIST-SETUP.md](GAME-LIST-SETUP.md).
4. **Watcher:** see [watcher/README.md](watcher/README.md).

## Workflows

| Workflow | When it runs |
|---|---|
| Deploy GitHub Pages | Every push to `main` |
| Update Achievement Data (on push) | When the watcher pushes `AppID/**` files to `user`. Processes only the changed games (under a minute). |
| Full Refresh (all games) | Only when started by hand from the Actions tab. Re-fetches every game, which takes about 1.5 hours. |

## Supported achievement files

Put one per game in `AppID/<Steam AppID>/` on the `user` branch.

**GSE / Goldberg** `achievements.json` (`%AppData%\GSE Saves\<AppID>`):

```json
{
  "Defeat_Mantis": { "earned": true, "earned_time": 1754144765 }
}
```

**Achievement Watcher Steam cache** `<AppID>.db` (`%AppData%\Achievement Watcher\steam_cache\data`):

```json
[
  { "apiname": "ACHIEVEMENT_reached_speed_1", "achieved": 0, "unlocktime": 0 }
]
```

Optional files per game, see `AppID/_appid_/` on `main`: `<Name>.platform` adds a platform label, `blacklist` hides achievement API names, `skip` skips a game.

## Credits

The achievement viewer and data scripts are based on [Roschach96/achievement-viewer](https://github.com/Roschach96/achievement-viewer) (see [LICENSE](LICENSE)). Its community Hub and cross-user comparison have been removed here.

- Hidden achievement retrieval automates **alex47exe**'s gse_fork_tools.
- Enhanced hidden achievement retrieval by **darktakayanagi**.
