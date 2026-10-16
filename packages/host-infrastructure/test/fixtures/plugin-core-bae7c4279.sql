PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE events (
     session_key TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL,
     lane BLOB NOT NULL DEFAULT x'6d61696e', v INTEGER NOT NULL DEFAULT 1,
     actor TEXT NOT NULL, origin TEXT NOT NULL, trust TEXT NOT NULL,
     register TEXT, ignorable INTEGER, surface_op TEXT, source_event_seqs TEXT, data TEXT NOT NULL,
     integrity_mode TEXT, integrity_prev TEXT, integrity_digest TEXT,
     PRIMARY KEY (session_key, seq));
INSERT INTO events VALUES('plain',1,'2026-09-07T00:00:00Z','01J6ZM2Q3R4S5T6V7W8X9Y0Z00','session/start',X'6d61696e',1,'{"id":"u","org":"local","role":"owner","deptPath":[],"attrs":{}}','principal','trusted',NULL,NULL,NULL,NULL,'{"key":"plain","resolvedProfileHash":null,"preset":null,"agnesVersion":"0.0.0"}','anchor',NULL,'90a10b2910d23bad053da20a4e594e84f9b50e1e671cc23e6bb51b38467002e4');
INSERT INTO events VALUES('plain',2,'2026-09-07T00:00:00Z','01J6ZM2Q3R4S5T6V7W8X9Y0Z01','user/message',X'6d61696e',1,'{"id":"u","org":"local","role":"owner","deptPath":[],"attrs":{}}','principal','trusted',NULL,NULL,NULL,NULL,'{"content":[{"type":"text","text":"Synthetic upgrade check"}]}','chain','90a10b2910d23bad053da20a4e594e84f9b50e1e671cc23e6bb51b38467002e4','d1cfc63b85af81c0c3f88186903927a73e643877462cd33d15ecd996874dd1b4');
INSERT INTO events VALUES('plain',3,'2026-09-07T00:00:00Z','01J6ZM2Q3R4S5T6V7W8X9Y0Z02','request/header',X'6d61696e',1,'{"id":"u","org":"local","role":"owner","deptPath":[],"attrs":{}}','principal','trusted',NULL,NULL,NULL,NULL,'{"derived_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","prompt_prefix_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","tool_schema_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parser_version":"1","contract_id":null,"model":"synthetic","envelopeNonce":"fixture"}','chain','d1cfc63b85af81c0c3f88186903927a73e643877462cd33d15ecd996874dd1b4','90ea6edccf0e04b0a739a763aff1a486fb30d208f55e62e586688ac63e704a26');
INSERT INTO events VALUES('plain',4,'2026-09-07T00:00:00Z','01J6ZM2Q3R4S5T6V7W8X9Y0Z03','assistant/message',X'6d61696e',1,'{"id":"u","org":"local","role":"owner","deptPath":[],"attrs":{}}','principal','trusted',NULL,NULL,NULL,NULL,'{"content":[{"type":"text","text":"Synthetic answer"}],"stopReason":"end_turn"}','chain','90ea6edccf0e04b0a739a763aff1a486fb30d208f55e62e586688ac63e704a26','c5f356d130e2726e73bdcdcd763856639ca0987c9b928991be2379673e9f4914');
INSERT INTO events VALUES('tool',1,'2026-09-07T00:00:00Z','01J6ZM2Q3R4S5T6V7W8X9Y0Z04','session/start',X'6d61696e',1,'{"id":"u","org":"local","role":"owner","deptPath":[],"attrs":{}}','principal','trusted',NULL,NULL,NULL,NULL,'{"key":"tool","resolvedProfileHash":null,"preset":null,"agnesVersion":"0.0.0"}','anchor',NULL,'3e5535e8f378d4d5b25148a0ca3528e7280e2a51f7fb14539ef69cee2cbbe224');
INSERT INTO events VALUES('tool',2,'2026-09-07T00:00:00Z','01J6ZM2Q3R4S5T6V7W8X9Y0Z05','user/message',X'6d61696e',1,'{"id":"u","org":"local","role":"owner","deptPath":[],"attrs":{}}','principal','trusted',NULL,NULL,NULL,NULL,'{"content":[{"type":"text","text":"Synthetic upgrade check"}]}','chain','3e5535e8f378d4d5b25148a0ca3528e7280e2a51f7fb14539ef69cee2cbbe224','f0424580819ef321d64af6e498abca74dd60bb75019826bb7e927d3a0dbc2076');
INSERT INTO events VALUES('tool',3,'2026-09-07T00:00:00Z','01J6ZM2Q3R4S5T6V7W8X9Y0Z06','request/header',X'6d61696e',1,'{"id":"u","org":"local","role":"owner","deptPath":[],"attrs":{}}','principal','trusted',NULL,NULL,NULL,NULL,'{"derived_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","prompt_prefix_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","tool_schema_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parser_version":"1","contract_id":null,"model":"synthetic","envelopeNonce":"fixture"}','chain','f0424580819ef321d64af6e498abca74dd60bb75019826bb7e927d3a0dbc2076','8d2061ea64e5bda194b082226cab0ec5bbca6727e10676e63298d196d84c6b71');
INSERT INTO events VALUES('tool',4,'2026-09-07T00:00:00Z','01J6ZM2Q3R4S5T6V7W8X9Y0Z07','tool/call',X'6d61696e',1,'{"id":"u","org":"local","role":"owner","deptPath":[],"attrs":{}}','principal','trusted',NULL,NULL,NULL,NULL,'{"toolUseId":"t1","name":"synthetic_echo","args":{"text":"hello"},"ordinal":0}','chain','8d2061ea64e5bda194b082226cab0ec5bbca6727e10676e63298d196d84c6b71','e99d49107e90c68a6d7bcceabc79543f942195958f35a87a759946b406ebda14');
INSERT INTO events VALUES('tool',5,'2026-09-07T00:00:00Z','01J6ZM2Q3R4S5T6V7W8X9Y0Z08','tool/result',X'6d61696e',1,'{"id":"u","org":"local","role":"owner","deptPath":[],"attrs":{}}','principal','trusted',NULL,NULL,NULL,NULL,'{"toolUseId":"t1","content":[{"type":"text","text":"hello"}],"isError":false,"enforcement":{"level":"none","scope":[]},"authz":{"decisionId":"synthetic"}}','chain','e99d49107e90c68a6d7bcceabc79543f942195958f35a87a759946b406ebda14','f2ca7c2e450d395833b6d2bac12252468021bcc712ab1f4cb7db0f17e9aabb9a');
INSERT INTO events VALUES('tool',6,'2026-09-07T00:00:00Z','01J6ZM2Q3R4S5T6V7W8X9Y0Z09','assistant/message',X'6d61696e',1,'{"id":"u","org":"local","role":"owner","deptPath":[],"attrs":{}}','principal','trusted',NULL,NULL,NULL,NULL,'{"content":[{"type":"text","text":"Synthetic answer"}],"stopReason":"end_turn"}','chain','f2ca7c2e450d395833b6d2bac12252468021bcc712ab1f4cb7db0f17e9aabb9a','c0711f0b34d64924b22256abb2cbc1c75d8c48f13ee74dce4a926f33854805f3');
INSERT INTO events VALUES('attachment',1,'2026-09-07T00:00:00Z','01J6ZM2Q3R4S5T6V7W8X9Y0Z0A','session/start',X'6d61696e',1,'{"id":"u","org":"local","role":"owner","deptPath":[],"attrs":{}}','principal','trusted',NULL,NULL,NULL,NULL,'{"key":"attachment","resolvedProfileHash":null,"preset":null,"agnesVersion":"0.0.0"}','anchor',NULL,'900aad6cbad4857d3f7989b3b6fd0dae5e1b075c428f819e7ea74be185af74d7');
INSERT INTO events VALUES('attachment',2,'2026-09-07T00:00:00Z','01J6ZM2Q3R4S5T6V7W8X9Y0Z0B','user/message',X'6d61696e',1,'{"id":"u","org":"local","role":"owner","deptPath":[],"attrs":{}}','principal','trusted',NULL,NULL,NULL,NULL,'{"content":[{"type":"text","text":"Synthetic upgrade check"}]}','chain','900aad6cbad4857d3f7989b3b6fd0dae5e1b075c428f819e7ea74be185af74d7','ea8d06e1fdd729135307db8af5f97cf2d4a74c7619d95f6413b09fb8dd134347');
INSERT INTO events VALUES('attachment',3,'2026-09-07T00:00:00Z','01J6ZM2Q3R4S5T6V7W8X9Y0Z0C','request/header',X'6d61696e',1,'{"id":"u","org":"local","role":"owner","deptPath":[],"attrs":{}}','principal','trusted',NULL,NULL,NULL,NULL,'{"derived_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","prompt_prefix_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","tool_schema_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parser_version":"1","contract_id":null,"model":"synthetic","envelopeNonce":"fixture"}','chain','ea8d06e1fdd729135307db8af5f97cf2d4a74c7619d95f6413b09fb8dd134347','40802ee79095a09f90cb781629e2c04e2f4dac30edb6d233c04a4a9ac467483a');
INSERT INTO events VALUES('attachment',4,'2026-09-07T00:00:00Z','01J6ZM2Q3R4S5T6V7W8X9Y0Z0D','user/message',X'6d61696e',1,'{"id":"u","org":"local","role":"owner","deptPath":[],"attrs":{}}','principal','trusted',NULL,NULL,NULL,NULL,'{"content":[{"type":"resource_link","uri":"artifact://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"synthetic.txt","mimeType":"text/plain"}]}','chain','40802ee79095a09f90cb781629e2c04e2f4dac30edb6d233c04a4a9ac467483a','a2759670c4be32059e822d59606cecb09f6418ca80b299c15127e9a58e709685');
INSERT INTO events VALUES('attachment',5,'2026-09-07T00:00:00Z','01J6ZM2Q3R4S5T6V7W8X9Y0Z0E','request/header',X'6d61696e',1,'{"id":"u","org":"local","role":"owner","deptPath":[],"attrs":{}}','principal','trusted',NULL,NULL,NULL,NULL,'{"derived_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","prompt_prefix_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","tool_schema_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","parser_version":"1","contract_id":null,"model":"synthetic","envelopeNonce":"media-fixture","media":{"version":1,"selectionOrder":[],"route":"text-only","manifest":[]}}','chain','a2759670c4be32059e822d59606cecb09f6418ca80b299c15127e9a58e709685','b788c9fa430d95c052fc91331b41916dcf80a0686e2ed73666356607a5e7e546');
INSERT INTO events VALUES('attachment',6,'2026-09-07T00:00:00Z','01J6ZM2Q3R4S5T6V7W8X9Y0Z0F','assistant/message',X'6d61696e',1,'{"id":"u","org":"local","role":"owner","deptPath":[],"attrs":{}}','principal','trusted',NULL,NULL,NULL,NULL,'{"content":[{"type":"text","text":"Synthetic answer"}],"stopReason":"end_turn"}','chain','b788c9fa430d95c052fc91331b41916dcf80a0686e2ed73666356607a5e7e546','8c2e2f8efce17690e640c35a9c0e5281b4d28fd0f8dc011712370d96cda43914');
CREATE TABLE registers (
     session_key TEXT NOT NULL, register TEXT NOT NULL, key BLOB NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
     PRIMARY KEY (session_key, register, key));
CREATE TABLE writer_claims (
     session_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, until INTEGER NOT NULL, ttl_ms INTEGER NOT NULL,
     generation INTEGER NOT NULL DEFAULT 1);
CREATE TABLE sessions (
     session_key TEXT PRIMARY KEY, format_version INTEGER NOT NULL DEFAULT 1, parent_key TEXT, boundary_seq INTEGER, created_at TEXT NOT NULL);
INSERT INTO sessions VALUES('plain',1,NULL,NULL,'2026-10-16T09:54:25.120Z');
INSERT INTO sessions VALUES('tool',1,NULL,NULL,'2026-10-16T09:54:25.123Z');
INSERT INTO sessions VALUES('attachment',1,NULL,NULL,'2026-10-16T09:54:25.124Z');
CREATE TABLE child_control_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
INSERT INTO child_control_meta VALUES(1,4);
CREATE TABLE child_tasks (
     child_key TEXT PRIMARY KEY, creation_id TEXT NOT NULL UNIQUE, parent_key TEXT NOT NULL,
     root_task_id TEXT NOT NULL, runtime_owner TEXT NOT NULL, kind TEXT NOT NULL,
     generation_depth INTEGER NOT NULL, generation_limit INTEGER NOT NULL, input_hash TEXT NOT NULL,
     input_text TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL, actor_id TEXT NOT NULL, budget_scope_id TEXT NOT NULL,
     ancestor_scope_ids TEXT NOT NULL, workspace_id TEXT, isolation TEXT NOT NULL,
     state TEXT NOT NULL, state_revision INTEGER NOT NULL, control_format INTEGER NOT NULL,
     attempt_id TEXT NOT NULL, creation_phase TEXT NOT NULL, creation_revision INTEGER NOT NULL,
     attempt_started_at INTEGER NOT NULL, deferred_fact TEXT, cancelled_fact TEXT);
CREATE TABLE budget_scopes (
     scope_id TEXT PRIMARY KEY, root_task_id TEXT NOT NULL, child_key TEXT, parent_scope_id TEXT,
     cap_micro TEXT NOT NULL, settled_micro TEXT NOT NULL, held_micro TEXT NOT NULL);
CREATE TABLE budget_reservations (
     permit_id TEXT PRIMARY KEY, root_task_id TEXT NOT NULL, scope_ids TEXT NOT NULL,
     q_micro TEXT NOT NULL, effect_id TEXT NOT NULL, request_hash TEXT NOT NULL,
     writer_generation INTEGER NOT NULL, status TEXT NOT NULL);
CREATE TABLE cost_origins (
     origin_key TEXT PRIMARY KEY, micro TEXT NOT NULL, scope_ids TEXT NOT NULL);
CREATE TABLE child_workspaces (
     workspace_id TEXT PRIMARY KEY, child_key TEXT NOT NULL, isolation TEXT NOT NULL,
     path TEXT NOT NULL, phase TEXT NOT NULL, root TEXT, branch TEXT);
CREATE TABLE child_ordinals (
     parent_key TEXT NOT NULL, effect_id TEXT NOT NULL, n INTEGER NOT NULL,
     PRIMARY KEY (parent_key, effect_id));
CREATE TABLE child_writer_gens (
     root_task_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
CREATE INDEX events_type ON events (session_key, type, seq);
CREATE UNIQUE INDEX budget_reservations_root_effect ON budget_reservations (root_task_id, effect_id);
COMMIT;
