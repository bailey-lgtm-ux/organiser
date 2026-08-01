# Putting the VCE Organiser on your phone

Two things happen here:

1. **Part A** puts the app on the internet, so your phone can open it and you can
   add it to your home screen like a real app.
2. **Part B** turns on sync, so anything you add on the laptop shows up on the
   phone (and the other way around).

Do Part A first — it works on its own. Until Part B is done the app still runs
fine, it just keeps its data on each device separately.

Nothing here costs money. Both services are free at the size you'll use.

---

## Part A — Put the app online (GitHub Pages)

**1. Make a GitHub account** at <https://github.com/signup> if you don't have one.

**2. Make an empty repository.** Go to <https://github.com/new> and set:

- **Repository name:** `organiser`
- **Public** (GitHub Pages is only free on public repositories)
- Leave "Add a README" and everything else **unticked** — the folder already
  has its files.

Click **Create repository**.

> Public means your *code* is visible to anyone. Your homework and events are
> **not** in the code — they live in your private Firestore account from Part B.

**3. Upload the folder.** In Terminal, run these two lines, replacing
`YOUR-USERNAME` with your GitHub username:

```bash
cd ~/Documents/organiser
git remote add origin https://github.com/YOUR-USERNAME/organiser.git
git push -u origin main
```

GitHub will ask you to sign in the first time.

**4. Switch on Pages.** On your repository page go to **Settings** →
**Pages** (left sidebar) → under **Source** pick **Deploy from a branch**,
choose branch **main** and folder **/ (root)**, then **Save**.

Wait about a minute, then reload that page. It will show your link:

```
https://YOUR-USERNAME.github.io/organiser/
```

**5. Open that link on your phone.** It works right now.

- **iPhone:** open it in **Safari** (this only works in Safari), tap the
  **Share** button, then **Add to Home Screen**.
- **Android:** open it in **Chrome**, tap the **⋮** menu, then **Install app**.

You now have an icon on your home screen that opens full-screen with no browser
bars. That's the app.

---

## Part B — Turn on sync (Firebase)

Sign in with the Google account you already use. Everything below is free.

**1. Create the project.** Go to <https://console.firebase.google.com> →
**Create a project**. Name it `vce-organiser`. When it offers Google Analytics,
turn it **off** — you don't need it. Click through to **Create project**.

**2. Turn on Google sign-in.** In the left sidebar: **Build** →
**Authentication** → **Get started** → **Google** → toggle **Enable** on →
pick your own email as the "support email" → **Save**.

**3. Create the database.** Left sidebar: **Build** → **Firestore Database** →
**Create database**. Choose **Start in production mode**, and for location pick
**australia-southeast1 (Sydney)**. Click through to create it.

**4. Lock it to just you.** Open the **Rules** tab of Firestore, delete what's
there, paste this in, and click **Publish**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Your organiser lives at organisers/{your-user-id}.
    // Only you, signed in, can read or write your own document.
    match /organisers/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

This is the bit that keeps your data private. Don't skip it.

**5. Copy your project's settings.** Click the **⚙ gear** next to *Project
Overview* → **Project settings**. Scroll to **Your apps** and click the
**`</>`** (web) icon. Give it a nickname like `organiser`, **don't** tick
Firebase Hosting, and click **Register app**.

You'll see a code block containing `apiKey`, `authDomain`, `projectId` and
`appId`. Open `firebase-config.js` in this folder and replace the four
`PASTE_...` placeholders with those values, keeping the quotes.

It should end up looking like this (with your own values):

```js
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyC...",
  authDomain: "vce-organiser-1234.firebaseapp.com",
  projectId: "vce-organiser-1234",
  appId: "1:12345:web:abc123",
};
```

> These four values are not passwords, and it's fine that they end up in a
> public repository — Google designs them to be visible in web apps. Step 4 is
> what actually protects your data.

**6. Let your site sign people in.** Back in **Authentication** → **Settings**
tab → **Authorised domains** → **Add domain** → enter just:

```
YOUR-USERNAME.github.io
```

(`localhost` is already allowed, so testing on your laptop works without this.)

**7. Publish the change:**

```bash
cd ~/Documents/organiser
git add firebase-config.js
git commit -m "Add Firebase settings"
git push
```

Give GitHub Pages a minute, then reload the app.

---

## Using it

Press the **☁ Sign in** button in the top corner on your laptop, and again on
your phone, using **the same Google account**. That's it — from then on the
button reads **✔ Synced** and anything you add on one device appears on the
other within a couple of seconds.

The button tells you what's going on:

| Button | Meaning |
|---|---|
| **☁ Local only** | `firebase-config.js` hasn't been filled in — Part B isn't done |
| **☁ Sign in** | Sync is ready, you're just not signed in on this device |
| **⟳ Syncing…** | Talking to the cloud right now |
| **✔ Synced** | Everything is up to date |
| **⚠ Offline** | No connection — your changes are saved here and will upload later |
| **⚠ Sync issue** | Something's misconfigured; hover it for the reason |

Tap the button while signed in to sign out on that device.

### Things worth knowing

- **It works offline.** Add homework on the train with no signal; it saves on
  the phone and uploads when you're back online.
- **Editing on both devices is safe.** Changes are merged item by item, so a
  phone that's been closed for a week won't wipe out work you did on the laptop.
  If you edit the *same* item on both, the more recent edit wins.
- **Deleting syncs too.** A deleted item stays hidden everywhere for 90 days
  before being cleared out for good.
- **Reminders** only fire while the app is actually open. That's a limit of what
  a web app is allowed to do, especially on iPhone.

## Changing the app later

Edit files in this folder, then:

```bash
cd ~/Documents/organiser
git add -A
git commit -m "Describe what you changed"
git push
```

The live site updates about a minute later. If your phone still shows the old
version, close the app fully and reopen it — it caches itself so it can work
offline, and picks up updates on the next launch.

To run it on your laptop without the internet, double-click `start.command` as
before.
