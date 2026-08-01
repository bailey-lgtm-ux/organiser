/* =========================================================================
 * VCE Organiser — cloud sync
 *
 * Signs you in with Google and keeps one Firestore document per account:
 *   organisers/{your-user-id}
 * That document holds the same state object app.js keeps in localStorage,
 * so every device signed into the same Google account sees the same items.
 *
 * This file is pure transport. It never decides which version of an item
 * wins — app.js owns that (see mergeStates), because app.js owns the shape
 * of the data. Here we only: sign in, listen for changes, and push.
 *
 * If firebase-config.js still has its placeholder values, this file does
 * nothing at all and the app stays local-only.
 * ========================================================================= */

"use strict";

const SDK = "https://www.gstatic.com/firebasejs/11.6.1/";
const CFG = window.FIREBASE_CONFIG || {};

/* Treat the untouched placeholder config as "not set up yet". */
const configured =
  typeof CFG.apiKey === "string" &&
  CFG.apiKey.length > 10 &&
  !CFG.apiKey.startsWith("PASTE") &&
  typeof CFG.projectId === "string" &&
  !CFG.projectId.startsWith("PASTE");

/* Filled in once the Firebase SDK has loaded. */
let fb = null;          // { auth, db, ...functions }
let currentUser = null;
let stopDocListener = null;
let pushTimer = null;
let pendingPush = false;
let hooks = { getState: null, applyRemote: null, onStatus: null };

/* ---------- Status reporting ---------- */
/* status: "off" | "signed-out" | "connecting" | "synced" | "offline" | "error" */
let lastStatus = { state: "off", detail: "" };
function setStatus(state, detail = "") {
  lastStatus = { state, detail };
  if (hooks.onStatus) {
    try { hooks.onStatus(lastStatus); } catch (err) { console.error(err); }
  }
}

/* =========================================================================
 * Public interface (app.js talks to window.OrgSync only)
 * ========================================================================= */
window.OrgSync = {
  configured,
  get status() { return lastStatus; },
  get user() { return currentUser; },
  init,
  signIn,
  signOut,
  pushSoon,
};

/**
 * Start sync.
 * @param {object} h
 * @param {() => object}  h.getState     current local state, for pushing
 * @param {(remote:object) => boolean} h.applyRemote
 *        Merge a remote state in. Return true if the merged result still
 *        holds local-only changes that the cloud needs.
 * @param {(s:{state:string, detail:string}) => void} h.onStatus
 */
async function init(h) {
  hooks = h || hooks;

  if (!configured) {
    setStatus("off", "Cloud sync isn't set up yet — see SETUP.md");
    return;
  }

  setStatus("connecting", "Connecting…");
  try {
    const [appMod, authMod, storeMod] = await Promise.all([
      import(SDK + "firebase-app.js"),
      import(SDK + "firebase-auth.js"),
      import(SDK + "firebase-firestore.js"),
    ]);

    const app = appMod.initializeApp(CFG);
    fb = {
      auth: authMod.getAuth(app),
      db: storeMod.getFirestore(app),
      GoogleAuthProvider: authMod.GoogleAuthProvider,
      signInWithPopup: authMod.signInWithPopup,
      signInWithRedirect: authMod.signInWithRedirect,
      getRedirectResult: authMod.getRedirectResult,
      onAuthStateChanged: authMod.onAuthStateChanged,
      fbSignOut: authMod.signOut,
      doc: storeMod.doc,
      setDoc: storeMod.setDoc,
      onSnapshot: storeMod.onSnapshot,
    };

    /* Completes a redirect-based sign-in (used when popups are blocked,
       which is common for an installed app on iOS). */
    fb.getRedirectResult(fb.auth).catch((err) => reportAuthError(err));

    fb.onAuthStateChanged(fb.auth, (user) => {
      currentUser = user;
      if (user) {
        setStatus("connecting", "Syncing…");
        listenToDoc(user.uid);
      } else {
        if (stopDocListener) { stopDocListener(); stopDocListener = null; }
        setStatus("signed-out", "Sign in to sync across your devices");
      }
    });
  } catch (err) {
    console.error("Sync failed to start:", err);
    setStatus("error", "Couldn't reach the sync service");
  }
}

/* ---------- Auth ---------- */
async function signIn() {
  if (!configured) return;
  if (!fb) { setStatus("error", "Sync is still starting up — try again"); return; }
  const provider = new fb.GoogleAuthProvider();
  try {
    setStatus("connecting", "Opening Google sign-in…");
    await fb.signInWithPopup(fb.auth, provider);
  } catch (err) {
    /* Installed apps and some mobile browsers refuse popups. Redirect instead. */
    const fallback = [
      "auth/popup-blocked",
      "auth/popup-closed-by-user",
      "auth/cancelled-popup-request",
      "auth/operation-not-supported-in-this-environment",
    ];
    if (fallback.includes(err && err.code)) {
      try {
        await fb.signInWithRedirect(fb.auth, provider);
        return;
      } catch (err2) { reportAuthError(err2); return; }
    }
    reportAuthError(err);
  }
}

async function signOut() {
  if (!fb) return;
  try {
    await fb.fbSignOut(fb.auth);
  } catch (err) {
    console.error("Sign out failed:", err);
  }
}

function reportAuthError(err) {
  if (!err) return;
  const code = err.code || "";
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
    setStatus("signed-out", "Sign-in cancelled");
    return;
  }
  console.error("Sign-in error:", err);
  if (code === "auth/unauthorized-domain") {
    setStatus("error", "Add this site to Firebase's authorised domains (SETUP.md step 6)");
  } else {
    setStatus("error", "Sign-in failed: " + (err.message || code));
  }
}

/* ---------- The synced document ---------- */
function docRef(uid) {
  return fb.doc(fb.db, "organisers", uid);
}

function listenToDoc(uid) {
  if (stopDocListener) stopDocListener();
  stopDocListener = fb.onSnapshot(
    docRef(uid),
    (snap) => {
      /* Skip the optimistic echo of our own write — the data is already local. */
      if (snap.metadata.hasPendingWrites) return;

      const remote = snap.exists() ? snap.data() : null;
      let needsPush = true;
      if (remote && hooks.applyRemote) {
        try {
          needsPush = !!hooks.applyRemote(remote);
        } catch (err) {
          console.error("Failed to apply synced data:", err);
          needsPush = false;
        }
      }
      setStatus("synced", "Synced");
      /* Push when the cloud is missing something we hold locally — including
         the very first upload, when the document doesn't exist yet. */
      if (needsPush) pushSoon(150);
    },
    (err) => {
      console.error("Sync listener error:", err);
      if (err && err.code === "permission-denied") {
        setStatus("error", "Firestore rules are blocking access (SETUP.md step 5)");
      } else {
        setStatus("offline", "Offline — changes will sync when you reconnect");
      }
    }
  );
}

/** Queue an upload. Called on every local change; collapses rapid edits. */
function pushSoon(delay = 800) {
  if (!configured || !fb || !currentUser) return;
  pendingPush = true;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, delay);
}

async function pushNow() {
  if (!fb || !currentUser || !hooks.getState) return;
  pendingPush = false;
  const state = hooks.getState();
  try {
    await fb.setDoc(docRef(currentUser.uid), {
      subjects: state.subjects || [],
      items: state.items || [],
      notified: state.notified || {},
      updatedAt: Date.now(),
      updatedBy: deviceLabel(),
    });
    if (!pendingPush) setStatus("synced", "Synced");
  } catch (err) {
    console.error("Push failed:", err);
    if (err && err.code === "permission-denied") {
      setStatus("error", "Firestore rules are blocking writes (SETUP.md step 5)");
    } else {
      setStatus("offline", "Offline — changes will sync when you reconnect");
    }
  }
}

/* Just for the "last changed on…" line; not used for merging. */
function deviceLabel() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/.test(ua)) return "iPhone/iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "a device";
}
