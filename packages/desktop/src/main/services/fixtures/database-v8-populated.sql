BEGIN;

CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  remote_url TEXT NOT NULL,
  local_path TEXT,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  last_opened_at TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, owner, name)
);

CREATE TABLE pull_requests (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  state TEXT NOT NULL,
  last_fetched_at TEXT NOT NULL,
  UNIQUE(repo_id, number)
);

CREATE TABLE viewed_files (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pr_number INTEGER,
  review_key TEXT NOT NULL,
  file_path TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  viewed_at TEXT NOT NULL,
  PRIMARY KEY(repo_id, review_key, file_path, head_sha)
);

CREATE TABLE walkthroughs (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pr_number INTEGER,
  review_key TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(repo_id, review_key, base_sha, head_sha, prompt_version)
);

CREATE TABLE review_threads (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  review_key TEXT NOT NULL,
  pr_number INTEGER,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  current_base_sha TEXT NOT NULL,
  current_head_sha TEXT NOT NULL,
  original_anchor_json TEXT NOT NULL,
  current_anchor_json TEXT,
  anchor_status TEXT NOT NULL CHECK (
    anchor_status IN ('active', 'carried_forward', 'outdated', 'unresolved_anchor')
  ),
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repo_id, review_key, original_anchor_json)
);

CREATE INDEX review_threads_review_idx
  ON review_threads(repo_id, review_key, updated_at DESC, id);

CREATE INDEX review_threads_revision_idx
  ON review_threads(repo_id, review_key, current_head_sha, updated_at DESC, id);

CREATE TABLE review_thread_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  author TEXT NOT NULL CHECK (author IN ('user', 'agent')),
  body_markdown TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'failed')),
  agent_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(thread_id, sequence)
);

CREATE INDEX review_thread_messages_thread_idx
  ON review_thread_messages(thread_id, sequence);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES review_threads(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('opencode', 'codex', 'claude')),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  provider_run_id TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  usage_json TEXT,
  UNIQUE(id, thread_id),
  CHECK (
    (status = 'running' AND completed_at IS NULL AND error IS NULL) OR
    (status = 'completed' AND completed_at IS NOT NULL AND error IS NULL) OR
    (status = 'failed' AND completed_at IS NOT NULL AND error IS NOT NULL)
  )
);

CREATE INDEX agent_runs_thread_idx
  ON agent_runs(thread_id, started_at DESC, id);

CREATE TABLE agent_run_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'file_read', 'search_result', 'shell_output', 'web_result',
    'diff_context', 'mcp_tool_result', 'provider_message', 'unknown'
  )),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
  original_size INTEGER NOT NULL CHECK (original_size >= 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id, thread_id) REFERENCES agent_runs(id, thread_id) ON DELETE CASCADE
);

CREATE INDEX agent_run_artifacts_run_idx
  ON agent_run_artifacts(run_id, created_at ASC, id);

CREATE INDEX agent_run_artifacts_thread_idx
  ON agent_run_artifacts(thread_id, created_at ASC, id);

CREATE TABLE thread_memory (
  thread_id TEXT PRIMARY KEY REFERENCES review_threads(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  important_artifact_ids_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  summarized_through_sequence INTEGER NOT NULL DEFAULT 0 CHECK (summarized_through_sequence >= 0),
  summary_algorithm TEXT NOT NULL DEFAULT 'legacy',
  summary_version INTEGER NOT NULL DEFAULT 1 CHECK (summary_version >= 1)
);

INSERT INTO repos VALUES (
  'github:byfungsi/diffdash', 'github', 'byfungsi', 'diffdash',
  'https://github.com/byfungsi/diffdash', '/fixtures/diffdash', 1,
  '2026-07-15T12:00:00.000Z', '2026-07-15T12:00:01.000Z',
  '2026-07-15T11:59:59.000Z', '2026-07-15T12:00:01.000Z'
);

INSERT INTO pull_requests VALUES (
  'pr-v8', 'github:byfungsi/diffdash', 147, 'Persist version 8 compatibility',
  'fixture-author', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'main', 'fixture/v8',
  'OPEN', '2026-07-15T12:00:02.000Z'
);

INSERT INTO viewed_files VALUES (
  'github:byfungsi/diffdash', 147, 'src/main/services/database.ts',
  'src/main/services/database.ts', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '2026-07-15T12:00:03.000Z'
);

INSERT INTO walkthroughs VALUES (
  'github:byfungsi/diffdash', 147, 'github:byfungsi/diffdash#147',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'walkthrough-v4',
  '{"title":"Version 8 review path","summary":"Verify the persisted database graph.","chapters":[{"id":"chapter-v8","title":"Persistence","summary":"Review durable relationships.","stops":[{"id":"stop-v8","title":"Database fixture","summary":"Every durable entity remains readable.","risk":"critical","hunkIds":["hunk-v8"]}]}],"support":[]}',
  '2026-07-15T12:00:04.000Z'
);

INSERT INTO review_threads VALUES (
  'thread-v8', 'github:byfungsi/diffdash', 'github:byfungsi/diffdash#147', 147,
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '{"_tag":"line","fileId":"file-v8","filePath":"src/main/services/database.ts","oldPath":null,"hunkId":"hunk-v8","hunkFingerprint":"fingerprint-v8","hunkHeader":"@@ -1 +1 @@","side":"new","lineNumber":1,"lineContent":"const persisted = true"}',
  '{"_tag":"line","fileId":"file-v8","filePath":"src/main/services/database.ts","oldPath":null,"hunkId":"hunk-v8","hunkFingerprint":"fingerprint-v8","hunkHeader":"@@ -1 +1 @@","side":"new","lineNumber":1,"lineContent":"const persisted = true"}',
  'active', 'open', NULL, '2026-07-15T12:00:05.000Z', '2026-07-15T12:00:08.000Z'
);

INSERT INTO review_thread_messages VALUES
  ('message-v8-1', 'thread-v8', 1, 'user', 'Why must this survive restart?', 'complete', NULL, '2026-07-15T12:00:05.000Z', '2026-07-15T12:00:05.000Z'),
  ('message-v8-2', 'thread-v8', 2, 'agent', 'SQLite retains the thread and its related records.', 'complete', 'run-v8', '2026-07-15T12:00:06.000Z', '2026-07-15T12:00:06.000Z'),
  ('message-v8-3', 'thread-v8', 3, 'user', 'Confirm it still exists after reopening.', 'complete', NULL, '2026-07-15T12:00:08.000Z', '2026-07-15T12:00:08.000Z');

INSERT INTO agent_runs VALUES (
  'run-v8', 'thread-v8', 'claude', 'claude-sonnet-4', 'thread-v1', 'completed',
  'claude-session-v8', NULL, '2026-07-15T12:00:05.500Z', '2026-07-15T12:00:06.000Z',
  '{"inputTokens":120,"outputTokens":40,"cacheReadTokens":20,"cacheWriteTokens":null,"costUsd":0.0042}'
);

INSERT INTO agent_run_artifacts VALUES (
  'artifact-v8', 'run-v8', 'thread-v8', 'file_read', 'Read database.ts', 'fixture',
  'sha256:fixture-v8',
  '{"path":"src/main/services/database.ts","sourceProvider":"claude"}',
  0, 7, '2026-07-15T12:00:06.500Z'
);

INSERT INTO thread_memory VALUES (
  'thread-v8', 'The discussion verifies version-8 persistence across reopen.',
  '["artifact-v8"]', '2026-07-15T12:00:09.000Z', 3,
  'deterministic-transcript', 1
);

PRAGMA user_version = 8;
COMMIT;
