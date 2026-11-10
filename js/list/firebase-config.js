// ============================================================
// Firebase configuration for "My Game List" (list.html)
// ============================================================
//
// 1. Create a project at https://console.firebase.google.com
// 2. Add a Web app and copy its config object here.
// 3. Turn on Authentication > Email/Password (and Google if you want).
// 4. Create a Firestore database and paste firestore.rules into its Rules tab.
//
// Full steps: GAME-LIST-SETUP.md
//
// These values are safe to commit: a Firebase web config is public by design.
// Your data is protected by the Firestore rules, not by hiding this file.
//
// While apiKey still starts with "YOUR_", the page runs in LOCAL MODE:
// accounts and lists are stored only in the current browser.

export const firebaseConfig = {
  apiKey: "AIzaSyB1sl5qQlR9Tji0LqpdOVv2Wjnn_8yoySU",
  authDomain: "mygamelist-2fc1f.firebaseapp.com",
  projectId: "mygamelist-2fc1f",
  storageBucket: "mygamelist-2fc1f.firebasestorage.app",
  messagingSenderId: "891477552626",
  appId: "1:891477552626:web:4a86c55e352be6144e4f6b",
};

// Set to true after enabling Google under Authentication > Sign-in method.
export const enableGoogleSignIn = true;

// Where the achievement data comes from (the "user" branch of this repo).
// On GitHub Pages this is detected from the URL automatically; this is the
// fallback used when you open the page locally.
export const achievementRepo = {
  owner: "MauMit",
  repo: "mygamelist",
  branch: "user",
};
