# Team to-do list

- **Team page:** https://coloradochase.github.io/board/todo/
- **TV board:** shows open tasks under the clock and updates live.
- **Database:** Firebase project `chasyn-board` (already set up: database, security rules, Google sign-in, team list).

## Left to do
1. In the `board` repo on GitHub, click **Add file → Upload files** and drag in everything from this zip:
   `index.html`, `firebase-config.js`, the `todo` folder, `firestore.rules`, and this file. Commit.
2. Wait about a minute, open https://coloradochase.github.io/board/todo/, sign in with chasynmusic@gmail.com, and click **Import tasks from the old list**.
3. Reload the TV board, or wait for its 3 AM reload.

## Team editors
Editors are listed in Firebase console → Firestore → Data → `config` → `editors` → `emails`:
chasynmusic@gmail.com, beccahaddadmgmt@gmail.com, carson@carsonbecker.com, sam@consigmgmt.com.
Add or remove an email there (all lowercase). Changes apply right away.

## Email updates (Emails block)
A Google Apps Script in your Gmail account (`email-sync/`) runs every 15 minutes. It reads the last two weeks
of Primary-inbox threads, asks Gemini which ones are Chasyn business, writes a title, summary and status
for each, and saves them to the private `emails` section of Firebase. Only signed-in team members can see them.

Setup:
1. Get a Gemini API key at https://aistudio.google.com/apikey.
2. Go to https://script.google.com, create a project named `Chasyn Email Sync`, and replace `Code.gs` with `email-sync/Code.gs`.
3. Open Project Settings, tick **Show "appsscript.json" manifest file**, and replace that file with `email-sync/appsscript.json`.
4. In Project Settings, under **Script Properties**, add `GEMINI_API_KEY` with your key.
5. In the editor, choose `setup` and click **Run**. Approve the permissions with chasynmusic@gmail.com.

To keep a thread off the board, give it the Gmail label `hide-from-board`.

## Troubleshooting
- **"isn't on the team list yet":** that email is missing from `config/editors`, or the person signed in with a different Google account.
- **Sign-in popup fails:** check that `coloradochase.github.io` is listed under Authentication → Settings → Authorized domains.
