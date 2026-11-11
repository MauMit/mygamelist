// Storage + auth layer for My Game List.
// Firebase (Auth + Firestore) when configured, otherwise a browser-only local mode.
import { firebaseConfig, enableGoogleSignIn } from './firebase-config.js';

const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';

export const isFirebaseConfigured = Boolean(
  firebaseConfig && firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith('YOUR_')
);

export async function createStore() {
  return isFirebaseConfigured ? createFirebaseStore() : createLocalStore();
}

function stamp(obj) {
  const now = Date.now();
  return { ...obj, updatedAt: now };
}

function friendlyError(err) {
  const code = err && err.code ? err.code : '';
  const map = {
    'auth/invalid-email': 'That email address looks wrong.',
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/wrong-password': 'Wrong email or password.',
    'auth/user-not-found': 'No account with that email.',
    'auth/email-already-in-use': 'An account with that email already exists.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/popup-closed-by-user': 'Google sign-in was closed.',
    'auth/unauthorized-domain': 'This domain is not authorized in Firebase (Authentication > Settings > Authorized domains).',
    'auth/too-many-requests': 'Too many attempts. Try again in a minute.',
    'permission-denied': 'Firestore refused the request. Check your Firestore rules.',
  };
  return new Error(map[code] || (err && err.message) || String(err));
}

// ------------------------------------------------------------
// Firebase
// ------------------------------------------------------------
async function createFirebaseStore() {
  const [appMod, authMod, fsMod] = await Promise.all([
    import(FIREBASE_SDK + 'firebase-app.js'),
    import(FIREBASE_SDK + 'firebase-auth.js'),
    import(FIREBASE_SDK + 'firebase-firestore.js'),
  ]);

  const app = appMod.initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);
  const db = fsMod.getFirestore(app);

  const authListeners = new Set();
  const toUser = (u) =>
    u ? { uid: u.uid, name: u.displayName || (u.email || 'Player').split('@')[0], email: u.email, photo: u.photoURL } : null;
  const emit = () => authListeners.forEach((cb) => cb(toUser(auth.currentUser)));

  authMod.onAuthStateChanged(auth, emit);

  const gamesCol = () => {
    if (!auth.currentUser) throw new Error('Not signed in');
    return fsMod.collection(db, 'users', auth.currentUser.uid, 'games');
  };

  const wrap = (fn) => async (...args) => {
    try { return await fn(...args); } catch (e) { throw friendlyError(e); }
  };

  return {
    mode: 'firebase',
    supportsGoogle: Boolean(enableGoogleSignIn),
    supportsReset: true,
    onAuth(cb) { authListeners.add(cb); return () => authListeners.delete(cb); },
    signIn: wrap((email, password) => authMod.signInWithEmailAndPassword(auth, email, password)),
    signUp: wrap(async (name, email, password) => {
      const cred = await authMod.createUserWithEmailAndPassword(auth, email, password);
      if (name) await authMod.updateProfile(cred.user, { displayName: name });
      emit();
    }),
    signInWithGoogle: wrap(() => authMod.signInWithPopup(auth, new authMod.GoogleAuthProvider())),
    resetPassword: wrap((email) => authMod.sendPasswordResetEmail(auth, email)),
    signOut: wrap(() => authMod.signOut(auth)),
    subscribe(cb, onError) {
      return fsMod.onSnapshot(
        gamesCol(),
        (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
        (err) => onError && onError(friendlyError(err))
      );
    },
    add: wrap((game) => fsMod.addDoc(gamesCol(), stamp({ ...game, createdAt: Date.now() }))),
    // opts.touch === false: don't change updatedAt (background fixes like covers)
    update: wrap((id, patch, opts = {}) =>
      fsMod.updateDoc(fsMod.doc(gamesCol(), id), opts.touch === false ? patch : stamp(patch))),
    remove: wrap((id) => fsMod.deleteDoc(fsMod.doc(gamesCol(), id))),
    addMany: wrap(async (games) => {
      for (let i = 0; i < games.length; i += 400) {
        const batch = fsMod.writeBatch(db);
        games.slice(i, i + 400).forEach((g) => {
          batch.set(fsMod.doc(gamesCol()), stamp({ ...g, createdAt: Date.now() }));
        });
        await batch.commit();
      }
    }),
  };
}

// ------------------------------------------------------------
// Local mode (no Firebase yet): everything lives in this browser.
// ------------------------------------------------------------
function createLocalStore() {
  const USERS_KEY = 'gamelist-local-users';
  const SESSION_KEY = 'gamelist-local-session';
  const gamesKey = (uid) => 'gamelist-local-games-' + uid;

  const read = (key, fallback) => {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  };
  const write = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { throw new Error('Could not save in this browser: ' + e.message); }
  };
  const hash = async (text) => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const authListeners = new Set();
  const gameListeners = new Set();
  let current = read(SESSION_KEY, null);

  const emitAuth = () => authListeners.forEach((cb) => cb(current));
  const loadGames = () => (current ? read(gamesKey(current.uid), []) : []);
  const saveGames = (games) => { write(gamesKey(current.uid), games); gameListeners.forEach((cb) => cb(games)); };
  const requireUser = () => { if (!current) throw new Error('Not signed in'); };

  window.addEventListener('storage', (e) => {
    if (current && e.key === gamesKey(current.uid)) gameListeners.forEach((cb) => cb(loadGames()));
  });

  return {
    mode: 'local',
    supportsGoogle: false,
    supportsReset: false,
    onAuth(cb) { authListeners.add(cb); setTimeout(() => cb(current), 0); return () => authListeners.delete(cb); },
    async signIn(email, password) {
      const users = read(USERS_KEY, {});
      const key = String(email).trim().toLowerCase();
      const u = users[key];
      if (!u || u.pass !== (await hash(password))) throw new Error('Wrong email or password.');
      current = { uid: u.uid, name: u.name, email: key, photo: null };
      write(SESSION_KEY, current);
      emitAuth();
    },
    async signUp(name, email, password) {
      const key = String(email).trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(key)) throw new Error('That email address looks wrong.');
      if (String(password).length < 6) throw new Error('Password must be at least 6 characters.');
      const users = read(USERS_KEY, {});
      if (users[key]) throw new Error('An account with that email already exists.');
      users[key] = { uid: newId(), name: name || key.split('@')[0], pass: await hash(password) };
      write(USERS_KEY, users);
      await this.signIn(key, password);
    },
    async signInWithGoogle() { throw new Error('Google sign-in needs Firebase.'); },
    async resetPassword() { throw new Error('Password reset needs Firebase.'); },
    async signOut() { current = null; localStorage.removeItem(SESSION_KEY); emitAuth(); },
    subscribe(cb) {
      gameListeners.add(cb);
      setTimeout(() => cb(loadGames()), 0);
      return () => gameListeners.delete(cb);
    },
    async add(game) {
      requireUser();
      saveGames([...loadGames(), stamp({ ...game, id: newId(), createdAt: Date.now() })]);
    },
    async update(id, patch, opts = {}) {
      requireUser();
      saveGames(loadGames().map((g) => {
        if (g.id !== id) return g;
        const next = { ...g, ...patch };
        return opts.touch === false ? next : stamp(next);
      }));
    },
    async remove(id) {
      requireUser();
      saveGames(loadGames().filter((g) => g.id !== id));
    },
    async addMany(games) {
      requireUser();
      const now = Date.now();
      saveGames([...loadGames(), ...games.map((g) => ({ ...g, id: newId(), createdAt: now, updatedAt: now }))]);
    },
  };
}
