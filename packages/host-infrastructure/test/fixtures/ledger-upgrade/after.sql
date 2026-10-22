BEGIN TRANSACTION;
CREATE TABLE budget_reservations (
     permit_id TEXT PRIMARY KEY, root_task_id TEXT NOT NULL, scope_ids TEXT NOT NULL,
     q_micro TEXT NOT NULL, effect_id TEXT NOT NULL, request_hash TEXT NOT NULL,
     writer_generation INTEGER NOT NULL, status TEXT NOT NULL);
CREATE TABLE budget_scopes (
     scope_id TEXT PRIMARY KEY, root_task_id TEXT NOT NULL, child_key TEXT, parent_scope_id TEXT,
     cap_micro TEXT NOT NULL, settled_micro TEXT NOT NULL, held_micro TEXT NOT NULL);
CREATE TABLE child_ordinals (
     parent_key TEXT NOT NULL, effect_id TEXT NOT NULL, n INTEGER NOT NULL,
     PRIMARY KEY (parent_key, effect_id));
CREATE TABLE child_tasks (
     child_key TEXT PRIMARY KEY, creation_id TEXT NOT NULL UNIQUE, parent_key TEXT NOT NULL,
     root_task_id TEXT NOT NULL, runtime_owner TEXT NOT NULL, kind TEXT NOT NULL,
     generation_depth INTEGER NOT NULL, generation_limit INTEGER NOT NULL, input_hash TEXT NOT NULL,
     input_text TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL, actor_id TEXT NOT NULL, budget_scope_id TEXT NOT NULL,
     ancestor_scope_ids TEXT NOT NULL, workspace_id TEXT, isolation TEXT NOT NULL,
     state TEXT NOT NULL, state_revision INTEGER NOT NULL, control_format INTEGER NOT NULL,
     attempt_id TEXT NOT NULL, creation_phase TEXT NOT NULL, creation_revision INTEGER NOT NULL,
     attempt_started_at INTEGER NOT NULL, deferred_fact TEXT, cancelled_fact TEXT);
CREATE TABLE child_workspaces (
     workspace_id TEXT PRIMARY KEY, child_key TEXT NOT NULL, isolation TEXT NOT NULL,
     path TEXT NOT NULL, phase TEXT NOT NULL, root TEXT, branch TEXT);
CREATE TABLE child_writer_gens (
     root_task_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
CREATE TABLE cost_origins (
     origin_key TEXT PRIMARY KEY, micro TEXT NOT NULL, scope_ids TEXT NOT NULL);
CREATE TABLE events (
     session_key TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL,
     lane BLOB NOT NULL DEFAULT x'6d61696e', v INTEGER NOT NULL DEFAULT 1,
     actor TEXT NOT NULL, origin TEXT NOT NULL, trust TEXT NOT NULL,
     register TEXT, ignorable INTEGER, surface_op TEXT, source_event_seqs TEXT, data TEXT NOT NULL,
     integrity_mode TEXT, integrity_prev TEXT, integrity_digest TEXT,
     PRIMARY KEY (session_key, seq));
INSERT INTO "events" VALUES('upgrade-parent',1,'2026-10-21T00:00:00.000Z','01M5G4Y489X6NXBS06HC26HDZW','user/message',X'6D61696E',1,'{"id":"synthetic","org":"local","role":"owner","deptPath":[],"attrs":{}}','principal','trusted',NULL,NULL,NULL,NULL,'{"content":[{"type":"text","text":"before restart"}]}','anchor',NULL,'dad55be1a45f5f464c92e6cecfdc93808a1402de2828bfe823c63a4957216f01');
INSERT INTO "events" VALUES('upgrade-parent',2,'2026-10-21T00:00:00.000Z','01M5G4Y48BY8XP6Y936826873J','user/message',X'6D61696E',1,'{"id":"synthetic","org":"local","role":"owner","deptPath":[],"attrs":{}}','principal','trusted',NULL,NULL,NULL,NULL,'{"content":[{"type":"text","text":"saved history"}]}','chain','dad55be1a45f5f464c92e6cecfdc93808a1402de2828bfe823c63a4957216f01','03eb18e7e17e9b458208b05be3f1e28390cc4e0649b3847fc034f1caf37371f2');
INSERT INTO "events" VALUES('upgrade-child',3,'2026-10-21T00:00:00.000Z','01M5G4Y48C0XXTQJNHTS1Y1TBK','user/message',X'6D61696E',1,'{"id":"synthetic","org":"local","role":"owner","deptPath":[],"attrs":{}}','principal','trusted',NULL,NULL,NULL,NULL,'{"content":[{"type":"text","text":"child history"}]}','chain','03eb18e7e17e9b458208b05be3f1e28390cc4e0649b3847fc034f1caf37371f2','9e43a26b45068064be2abfa63c7d63a917308ddd09b758e0edc4e4088a6893bd');
CREATE TABLE ledger_integrity_failure_v1 (session_key TEXT PRIMARY KEY, seq INTEGER);
CREATE TABLE ledger_verified_head_v1 (
  session_key TEXT PRIMARY KEY, through_seq INTEGER NOT NULL, head_digest TEXT NOT NULL,
  legacy_through_seq INTEGER NOT NULL, algorithm TEXT NOT NULL, verified_full_at_ms INTEGER NOT NULL,
  written_at_ms INTEGER NOT NULL, checkpoint_digest TEXT NOT NULL);
INSERT INTO "ledger_verified_head_v1" VALUES('upgrade-parent',2,'03eb18e7e17e9b458208b05be3f1e28390cc4e0649b3847fc034f1caf37371f2',0,'agnes-ledger-jcs-sha256-v1',1792540800000,1792540800000,'a09e410b7fc64349a7fd5c7be93160b81dd33ce907fa369306f70de29b9da4ad');
CREATE TABLE registers (
     session_key TEXT NOT NULL, register TEXT NOT NULL, key BLOB NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
     PRIMARY KEY (session_key, register, key));
CREATE TABLE sessions (
     session_key TEXT PRIMARY KEY, format_version INTEGER NOT NULL DEFAULT 1, parent_key TEXT, boundary_seq INTEGER, created_at TEXT NOT NULL,
     head_version INTEGER NOT NULL DEFAULT 0 CHECK (head_version IN (0, 1)), head_seq INTEGER, head_digest TEXT);
INSERT INTO "sessions" VALUES('upgrade-parent',1,NULL,NULL,'2026-10-21T21:12:36.871Z',1,2,'03eb18e7e17e9b458208b05be3f1e28390cc4e0649b3847fc034f1caf37371f2');
INSERT INTO "sessions" VALUES('upgrade-child',1,'upgrade-parent',2,'2026-10-21T21:12:36.876Z',1,3,'9e43a26b45068064be2abfa63c7d63a917308ddd09b758e0edc4e4088a6893bd');
CREATE TABLE writer_claims (
     session_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, until INTEGER NOT NULL, ttl_ms INTEGER NOT NULL,
     generation INTEGER NOT NULL DEFAULT 1);
CREATE INDEX events_type ON events (session_key, type, seq);
CREATE INDEX child_tasks_parent ON child_tasks (parent_key);
CREATE INDEX child_tasks_root ON child_tasks (root_task_id);
CREATE INDEX child_tasks_creating ON child_tasks (child_key) WHERE creation_phase = 'creating';
CREATE UNIQUE INDEX budget_reservations_root_effect ON budget_reservations (root_task_id, effect_id);
CREATE INDEX child_workspaces_child ON child_workspaces (child_key);
COMMIT;
PRAGMA user_version = 1;
