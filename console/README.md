# Xbox + PlayStation achievements

The **Sync Xbox + PlayStation Achievements** workflow runs every hour. It saves your Xbox achievements and PlayStation trophies to `console-data.json` and `console-summary.json` on the `user` branch. From there:

- **Achievement viewer** (`index.html`) shows them next to your PC games, labelled with their console, gamerscore or trophy type (Platinum / Gold / Silver / Bronze), rarity and DLC packs.
- **My Game List** (`list.html`) matches them by title to your Xbox 360/One/Series and PS3/PS4/PS5/Vita games and shows progress bars. Nothing on your list needs to change.

Each platform is optional. If its secret is missing, that platform is skipped.

## Xbox: `OPENXBL_KEY`

[OpenXBL](https://xbl.io) is a free Xbox Live API.

1. Go to <https://xbl.io> and click **Login with Xbox Live**. Sign in with your Microsoft account.
2. On your OpenXBL profile page, create an **API key** and copy it.
3. In this repo: **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `OPENXBL_KEY`
   - Secret: the key

The free plan allows 150 requests an hour. Each run uses at most 110, so a large first sync is spread over several hourly runs (about 35 games per run). After that, only games with new achievements are fetched.

## PlayStation: `PSN_NPSSO`

Sony has no public API. This uses the same trophy API as the PlayStation app, signed in with your **NPSSO** token.

1. In a browser, sign in at <https://www.playstation.com>.
2. In the same browser, open <https://ca.account.sony.com/api/v1/ssocookie>. It shows `{"npsso":"…"}`.
3. Copy the 64-character value (without the quotes).
4. Add it as a repository secret named `PSN_NPSSO`.

> The NPSSO token signs in to your PlayStation account, so treat it like a password. Only ever put it in the GitHub secret, never in a file or a chat. It expires after about two months. When it does, the workflow fails with "Sony didn't accept the PSN_NPSSO token"; repeat steps 1–4 and update the secret.

## Running it

- **First time:** Actions → **Sync Xbox + PlayStation Achievements** → **Run workflow**.
- **After that:** it runs every hour on its own. Runs where nothing changed take a few seconds and make 1–2 API calls per platform.
- **If one platform fails** (for example an expired PSN token), the other still syncs, the last good data is kept, and the run is marked failed with the reason in the log.

## What gets published

Like your PC achievements, the synced data is public on the site: game names, achievement names, descriptions, unlock dates and rarity. Your API key, NPSSO token and Xbox/PSN account IDs are never saved to the repo.
