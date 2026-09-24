export const DDL = [
  // `lane` is a BLOB for the same reason `key` below is, and it is the same value: a lane is the
  // register key for every register except harness/entry and artifact/job. Read back through a TEXT
  // column a lane stops at its first NUL, so the durable event and the register it keys disagreed -
  // and a register map rebuilt by replaying the ledger no longer matched the stored one. The
  // default is written as bytes so that a row inserted without a lane reads back as one too.
  `CREATE TABLE IF NOT EXISTS events (
     session_key TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL,
     lane BLOB NOT NULL DEFAULT x'6d61696e', v INTEGER NOT NULL DEFAULT 1,
     actor TEXT NOT NULL, origin TEXT NOT NULL, trust TEXT NOT NULL,
     register TEXT, ignorable INTEGER, surface_op TEXT, source_event_seqs TEXT, data TEXT NOT NULL,
     integrity_mode TEXT, integrity_prev TEXT, integrity_digest TEXT,
     PRIMARY KEY (session_key, seq))`,
  `CREATE INDEX IF NOT EXISTS events_type ON events (session_key, type, seq)`,
  // `key` is a BLOB, not TEXT. A register cell key is built by joining two halves with a NUL, and
  // the loss is on the way out, not on the way in: SQLite stores all the bytes it is given, but
  // hands a TEXT column back through a NUL-terminated C string, so two cells keyed `skill\0a` and
  // `skill\0b` were two distinct rows that both read back as `skill`. Nothing collided in storage
  // and a tombstone binding the whole key still deleted the right row; what broke was registers(),
  // which reported every harness/entry cell under its bare `kind` - and with it whatever
  // materialises from that call, core's log cache on resume. Bytes round-trip; text does not.
  `CREATE TABLE IF NOT EXISTS registers (
     session_key TEXT NOT NULL, register TEXT NOT NULL, key BLOB NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
     PRIMARY KEY (session_key, register, key))`,
  `CREATE TABLE IF NOT EXISTS writer_claims (
     session_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, until INTEGER NOT NULL, ttl_ms INTEGER NOT NULL,
     generation INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     session_key TEXT PRIMARY KEY, format_version INTEGER NOT NULL DEFAULT 1, parent_key TEXT, boundary_seq INTEGER, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fold_cache (
     session_key TEXT PRIMARY KEY, version INTEGER NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL,
     checksum TEXT NOT NULL, integrity_last_seq INTEGER NOT NULL, legacy_through_seq INTEGER NOT NULL,
     head_digest TEXT)`,
  `CREATE TABLE IF NOT EXISTS child_control_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS child_tasks (
     child_key TEXT PRIMARY KEY, creation_id TEXT NOT NULL UNIQUE, parent_key TEXT NOT NULL,
     root_task_id TEXT NOT NULL, runtime_owner TEXT NOT NULL, kind TEXT NOT NULL,
     generation_depth INTEGER NOT NULL, generation_limit INTEGER NOT NULL, input_hash TEXT NOT NULL,
     input_text TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL, actor_id TEXT NOT NULL, budget_scope_id TEXT NOT NULL,
     ancestor_scope_ids TEXT NOT NULL, workspace_id TEXT, isolation TEXT NOT NULL,
     state TEXT NOT NULL, state_revision INTEGER NOT NULL, control_format INTEGER NOT NULL,
     attempt_id TEXT NOT NULL, creation_phase TEXT NOT NULL, creation_revision INTEGER NOT NULL,
     attempt_started_at INTEGER NOT NULL, deferred_fact TEXT, cancelled_fact TEXT)`,
  `CREATE TABLE IF NOT EXISTS budget_scopes (
     scope_id TEXT PRIMARY KEY, root_task_id TEXT NOT NULL, child_key TEXT, parent_scope_id TEXT,
     cap_micro TEXT NOT NULL, settled_micro TEXT NOT NULL, held_micro TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS budget_reservations (
     permit_id TEXT PRIMARY KEY, root_task_id TEXT NOT NULL, scope_ids TEXT NOT NULL,
     q_micro TEXT NOT NULL, effect_id TEXT NOT NULL, request_hash TEXT NOT NULL,
     writer_generation INTEGER NOT NULL, status TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cost_origins (
     origin_key TEXT PRIMARY KEY, micro TEXT NOT NULL, scope_ids TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS child_workspaces (
     workspace_id TEXT PRIMARY KEY, child_key TEXT NOT NULL, isolation TEXT NOT NULL,
     path TEXT NOT NULL, phase TEXT NOT NULL, root TEXT, branch TEXT)`,
  `CREATE TABLE IF NOT EXISTS child_ordinals (
     parent_key TEXT NOT NULL, effect_id TEXT NOT NULL, n INTEGER NOT NULL,
     PRIMARY KEY (parent_key, effect_id))`,
  `CREATE TABLE IF NOT EXISTS child_writer_gens (
     root_task_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)`,
]
