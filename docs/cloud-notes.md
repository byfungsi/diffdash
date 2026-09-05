# Web notes

DiffDash web keeps PAT authentication. Notes do not require OAuth, GitHub write permissions,
an agent connection, or a backend service.

- Open a PR or comparison diff and click a line number to write a note.
- On mobile, tap the line number once; the gutter plus button is hidden.
- Open **Notes** in the activity ribbon to browse the current review collection.
- **Copy all notes** copies Markdown with the captured source location and revision context.
- **Clear all notes** asks for confirmation and clears only the current collection.
- Individual notes can also be removed. Cancelling Clear keeps the collection intact.

Notes live in IndexedDB on this browser/device. They survive page reloads and PAT disconnects,
but do not sync between devices or accounts. Clearing browser site data removes them. Notes and
captured source context are not encrypted at rest; avoid shared browser profiles for private work.

The web-only extension composition reuses the existing Review Comments note model and registered
review-line contributions, fixes the mode to Notes, and omits agent connection controls. Native
desktop retains its existing Comments extension and persistence. The shared Notes list gains
Copy all and an accessible confirmation dialog.

`packages/cloud/src/cloud-comment-notes.ts` owns the independent notes database, schema decoding,
project/review isolation, and transactional writes. This separate database leaves the existing
web repository/workspace stores untouched. The existing 1,000-note project limit is enforced
inside the same write transaction as insertion.

Headless browser coverage exercises line-number activation, IndexedDB persistence after remount,
the real clipboard, clear/cancel, concurrent writes, and cross-review deletion isolation.
