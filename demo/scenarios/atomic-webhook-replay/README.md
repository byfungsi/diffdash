# Atomic Webhook Replay

This fictional `emberline/dispatch` pull request is the flagship DiffDash promotional scenario.
It models a production fix for duplicate webhook retries by introducing atomic replay claims,
lease recovery, operator visibility, and concurrency coverage.

All people, repositories, commits, and incidents are fictional. The source artifacts are designed
for product demonstrations and may be redistributed with DiffDash promotional materials.

The two revisions are full pull-request diffs against the same base revision:

- `01-initial` introduces replay claims and worker ownership.
- `02-database-clock` moves lease timestamps to the database clock and adds cross-region coverage.

Parser-owned IDs and anchors are intentionally absent from the source files. DiffDash derives them
through its production diff parser and validates the walkthrough and thread references at load time.
