# qb-td — notes for Claude

## Every deploy ships a changelog entry

Before any deploy (a push to `main`, which GitHub Pages serves, or
`npx wrangler deploy`), add the release to the top of `app/changelog.txt`
in the same push. It is shown at `app/changelog.html`, linked from the
tournament hub.

The style is Counter-Strike update notes, very concise:

```
Release Notes for 9/27/2026

[ LIVE HUB ]
- Added "Open the next round automatically".

[ READER ]
- Moderators pick starters on the start card.
```

- One `- ` line per change a TD, moderator or player would notice; skip
  internal-only work (refactors, tests, docs).
- Sections in use: RELEASE, HUB, SETUP, LIVE HUB, READER, ROOM PAGE,
  PUBLIC PAGE, CATEGORIES, BUZZPOINTS, STATS, EXPORTS, SCHEDULE, SETS,
  DEMO, ARCHIVE, SECURITY, PERFORMANCE, UI, MISC.
- A second deploy on the same date adds to that date's release.
- `npm test` fails if the file doesn't parse, isn't newest first, or has a
  line over 160 characters.
- Mention the entry in the deploy summary.

## Deploy order

Database migrations (`worker/migrate-*.sql`, remote) before the Worker
deploy, and the Worker before pushing pages that call new routes. See
README "Deploy".
