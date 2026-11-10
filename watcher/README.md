# Achievement watcher

Two Windows scripts that send your emulator achievements to the `user` branch. From there the GitHub Action builds `game-data.json`, which both the achievement viewer (`index.html`) and My Game List (`list.html`) read.

| Script | What it does |
|---|---|
| `achievement-watcher.ps1` | Keeps running. On start it syncs every game once (catching up on anything earned while it was off), then watches `%APPDATA%\GSE Saves` and `%APPDATA%\Goldberg SteamEmu Saves`. When a game writes `achievements.json`, it writes `AppID\<appid>\achievements.json`, commits, pulls and pushes to `user`. |
| `sync-gse.bat` | One-off sync: runs the watcher with `-Once` (sync everything, push, exit). Keep it in the same folder as the `.ps1`. |

**Games in both folders are merged.** An achievement counts as earned if either folder has it, using the earliest unlock time. That way an empty placeholder in one folder (Achievement Watcher creates these, marked by `.aw-seed.json`) can't hide progress saved in the other.

Add `-DryRun` to see what would be uploaded without changing anything.

## Setup

1. Keep a local clone of this repo checked out on the **`user`** branch:

   ```bash
   git clone -b user https://github.com/<you>/mygamelist.git
   ```

2. Copy both scripts somewhere outside that clone, for example your Desktop. The scripts switch the clone to `user`, which doesn't contain this `watcher/` folder.

3. Run the watcher:

   ```powershell
   powershell -ExecutionPolicy Bypass -File achievement-watcher.ps1 -RepoPath "C:\path\to\achievement-viewer"
   ```

   Or the one-off sync:

   ```bat
   sync-gse.bat "C:\path\to\achievement-viewer"
   ```

   Leaving out the path uses `%USERPROFILE%\Desktop\Egna Projekt\achievement-viewer\achievement-viewer`.

## After a push

The **Fetch Steam Game Data** workflow runs, merges the new achievements into `game-data.json`, and both pages pick up the changes on their next load. In My Game List, progress bars update. If a game reaches 100%, or 75% while it's still marked Playing, its card offers a one-click status change.
