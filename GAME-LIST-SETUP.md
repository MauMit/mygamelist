# My Game List: setup

`list.html` is a game backlog tracker (in the spirit of MyVideoGameList) that lives next to the achievement viewer:

- **Statuses:** Currently Playing, Almost Done, Completed, Plan to Play
- **Login:** email/password or Google, through Firebase Authentication
- **Storage:** your list is saved in Firestore, so you see it on any device
- **Achievements:** games your achievement watcher syncs to the `user` branch show their achievement progress, and you can import them all in one click. Status is suggested from progress (100% → Completed, 75%+ → Almost Done)

Live page: `https://<your-username>.github.io/mygamelist/list.html`

Until Firebase is configured the page runs in **local mode**: accounts and the list are kept only in the browser you're using.

---

## 1. Create a Firebase project (about 5 minutes, free)

1. Go to <https://console.firebase.google.com> and click **Create a project**. Analytics isn't needed.
2. On the project overview, click the **Web** icon (`</>`) to add a web app. Any nickname works; skip Firebase Hosting.
3. Firebase shows a `firebaseConfig = { ... }` object. Copy its values into [`js/list/firebase-config.js`](js/list/firebase-config.js), replacing the `YOUR_...` placeholders.

> The web config is meant to be public, so committing it is fine. Your data is protected by the Firestore rules in step 3.

## 2. Turn on login

1. **Build → Authentication → Get started.**
2. Under **Sign-in method**, enable **Email/Password**.
3. *(Optional)* Enable **Google** too.
4. Under **Settings → Authorized domains**, click **Add domain** and add `<your-username>.github.io`.

## 3. Create the database

1. **Build → Firestore Database → Create database.** Choose a location near you and start in **production mode**.
2. Open the **Rules** tab, replace everything with the contents of [`firestore.rules`](firestore.rules), and click **Publish**.

## 4. Push and sign in

Commit `js/list/firebase-config.js` to `main`. GitHub Pages redeploys in a minute or two. Open `list.html`, click **Create account**, and you're in.

Anything you added in local mode stays in that browser. Re-add it, or use **Import from achievements** again.

---

## How the achievement part fits together

```
Game / emulator writes achievements.json
        │   (watcher/achievement-watcher.ps1 notices, copies it, commits, pushes)
        ▼
user branch: AppID/<appid>/achievements.json
        │   (GitHub Action "Fetch Steam Game Data")
        ▼
user branch: game-data.json
        │
        ├──▶ index.html   Achievement viewer
        └──▶ list.html    My Game List (progress bars, import, status hints)
```

See [`watcher/README.md`](watcher/README.md) to run the watcher.

## Data model

Each game is a document at `users/{uid}/games/{id}`:

| Field        | Type            | Notes                                     |
|--------------|-----------------|-------------------------------------------|
| `title`      | string          | required                                  |
| `status`     | string          | `playing`, `almost`, `completed`, `plan`  |
| `platform`   | string \| null  |                                           |
| `score`      | number \| null  | 1–10                                      |
| `hours`      | number \| null  |                                           |
| `startedAt`  | `YYYY-MM-DD` \| null |                                      |
| `finishedAt` | `YYYY-MM-DD` \| null | filled in automatically when completed |
| `appid`      | string \| null  | Steam AppID, links achievement progress   |
| `cover`      | string \| null  | custom cover URL (defaults to Steam art)  |
| `notes`      | string \| null  |                                           |
| `createdAt` / `updatedAt` | number | ms timestamps                    |
