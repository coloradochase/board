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

## Troubleshooting
- **"isn't on the team list yet":** that email is missing from `config/editors`, or the person signed in with a different Google account.
- **Sign-in popup fails:** check that `coloradochase.github.io` is listed under Authentication → Settings → Authorized domains.
