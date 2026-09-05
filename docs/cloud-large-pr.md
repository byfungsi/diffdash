# Large public pull requests: progressive Cloud review

GitHub REST returned HTTP 406 for `oven-sh/bun#30412` because its full-diff endpoint limits file
count to 300. The public patch endpoint returned HTTP 200 and 43,310,301 bytes. DiffsHub's browser
requests its own `/api/diff` endpoint, which also returned a roughly 43 MB response; this observation
does not establish its internal server implementation.

Cloud now falls back after a REST 406 only after verifying that the repository is public. The Worker
streams from the fixed `patch-diff.githubusercontent.com` origin, accepts only a constrained PR path,
rejects redirects, and forwards no PAT, cookies, or caller headers. Vite supplies a development proxy
for the same route. Private repositories remain on the authenticated REST path and receive an explicit
unsupported-large-diff error rather than sending their patch request through the public fallback.

## Loading and resource ownership

Cloud opens the response body without `response.text()`. A dedicated browser worker finds file
boundaries incrementally and delegates each complete file to the existing domain parser. It returns
one schema-encoded file per acknowledgement; the browser decodes the publication once. The worker
retains the unfinished file and current transport data, not a second complete review. Scanning resumes
at the last unfinished line rather than rescanning a large file after every network chunk.

The hosted snapshot is reserved after summary metadata and the first complete file arrive. A unique
acquisition identity distinguishes these reservations; it is not a content-addressed hash of a patch
that has not finished arriving. Subsequent inventory requests consume batches of up to 32 files.
The shared progressive session publishes inventory pages as they arrive and coalesces UI notifications
over 16 ms, while imperative navigation reads see the latest projection immediately.

Closing the owning session aborts the reader, terminates its parser worker, and releases the snapshot.
Stale session closes cannot cancel a newer owner. Stream failure remains an explicit failed acquisition;
already loaded files stay visible with an incomplete-review warning and Reload action.

The review renderer now shows available files while later file reads remain pending, instead of
hiding every diff behind the all-files-loaded gate. Tree ordering and preparation are retained while
the inventory is unchanged; a 2,000-file tree regression verifies selection does not reread inventory
paths.

## Rendering and host scope

Cloud selects the whole-review Pierre `CodeView` viewport at app composition. Only viewport files
mount headers, diff DOM, and annotations. Parsed Pierre metadata is retained by file identity;
versioned items update only when their annotations, navigation anchor, or collapsed state changes.
File selection materializes a virtualized target before the shared navigation verifier runs.
Mobile retains edge-to-edge, horizontally scrolling code; desktop retains wrapping and card spacing.

Notes and line actions still flow through the trusted Review contribution and source-surface runtime.
File headers reuse the existing controls. The adapter keeps context-menu path copying and marks very
large files as plain text rather than requesting whole-file syntax highlighting.

The native host deliberately retains its qualified card viewport. The `reviewViewport` host capability
selects rendering machinery only; it does not select activities, notes policy, or providers. Native
Review's 37 browser interaction tests pass, including search, language navigation, threads, viewed
state, and viewport ownership. This is not a claim of a full Electron E2E run.

## Reproduction and measurements

The normal headless browser suite includes a paused HTTP response test: the first diff is rendered
before the producer sends the remainder. Worker tests cover file/hunk identity parity, split UTF-8,
cancellation, and event-loop activity during 200,000 synthetic lines. A 2,000-file review verifies
bounded mounted files, filtering, distant selection, and reselecting after scrolling away.

For a real-patch replay, temporarily place the captured public Bun #30412 diff at
`packages/cloud/public/__bun-30412.diff`, then run:

```sh
VITE_LARGE_PR_REPLAY=1 pnpm --filter @diffdash/cloud test:browser -t 'actual Bun'
```

Remove that fixture before building or deploying; it must not become a public app asset. The replay
uses deterministic GitHub metadata and the actual roughly 43 MB patch, not GitHub authentication.
On the development machine, the latest headless Chromium replay measured:

| Viewport | First file host | Replay + filtering + scroll checks | Largest two-frame scroll interval |
| --- | ---: | ---: | ---: |
| 390 px | 727 ms | 9,518 ms | 24 ms |
| 1280 px | 579 ms | 9,300 ms | 29 ms |

Both replays found the final `test/tsconfig.json` file, reported no incomplete-load error, and mounted
three diff files after scrolling. These are local replay measurements, not production network latency,
physical-phone benchmarks, or guarantees for every scroll position/browser.

## Remaining product limits

The PR overview's file/commit metadata remains first-page-only; the diff inventory is parsed from the
full patch and is not subject to that overview limit. Large private PRs rejected by GitHub REST remain
unsupported. A single enormous file must finish arriving before that file can be published. Comparison
acquisition still buffers its response before off-thread parsing. Public patch acquisition does not yet
prove immutable revision consistency across a concurrently updated pull request.

Current coverage includes synthetic REST-406-to-public-patch rendering through the shared app,
fixed-origin/no-credential Worker requests, invalid proxy inputs, and sanitized upstream errors.
