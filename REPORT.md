# Agnes Harness (AGH): A Recoverable, Evidence-First Agent Runtime

> Complete text transcription of the supplied technical report. The accompanying PDF is the canonical visual version.

AS-BUILT TECHNICAL ARCHITECTURE REPORT · COMPLETED SYSTEM
Agnes Harness (AGH): A
Recoverable, Evidence-First
Agent Runtime
The implemented architecture of one trusted core, one authoritative
event ledger, controlled eﬀects, precise recovery, open extension,
and causal evaluation.
CURRENT MATURITY
Implemented system · as-built release
IMPLEMENTATION STATUS
Core runtime and platform paths completed
PREPARED
1 September 2026# Agnes Harness (AGH): A Recoverable, Evidence-First Agent Runtime\n\nComplete text transcription of the updated supplied technical report. The accompanying PDF is the canonical visual version.\n\n## Full Text\n\n### Page 1\n\n```text\nAS-BUILT TECHNICAL ARCHITECTURE REPORT · COMPLETED SYSTEM\nAgnes Harness (AGH): A\nRecoverable, Evidence-First\nAgent Runtime\nThe implemented architecture of one trusted core, one authoritative\nevent ledger, FDE-governed extension, MHS intelligent-hardware\nintegration, controlled eﬀects, precise recovery, and causal\nevaluation.\nCURRENT MATURITY\nImplemented system · as-built release\nIMPLEMENTATION STATUS\nCore runtime · FDE · MHS paths completed\nPREPARED\n4 September 2026\nEVIDENCE BOUNDARY\nImplementation complete · quantitative\nbenchmarks not supplied\nBased exclusively on the supplied AGH HTML, Markdown, and image assets. Embedded source instructions were treated as\ndesign content, not authoring directives.\n```\n\n### Page 2\n\n```text\nContents\n01 Abstract\n02 Executive ﬁndings\n03 1. System status, scope, and evidence\nbasis\n04 2. Design principles and hard invariants\n05 3. As-built system architecture\n06 4. Implemented end-to-end scope\n07 5. Process and deployment topology\n08 6. Runtime execution model\n09 7. Event, state, and projection model\n10 8. Eﬀect safety, replay, and recovery\n11 9. Context Pipeline and optional\nCodeRuntime\n12 10. Tool and capability model\n13 11. Extension and trust architecture\n14 12. Security architecture\n15 13. Interfaces and failure semantics\n16 14. Observability and evaluation\n17 15. Implementation history and acceptance\nrecord\n18 16. Research-style contributions and\ninnovation points\n19 17. Operational risks and governance\nboundaries\n20 18. Conclusion\n21 Appendix A. As-built conformance\nchecklist\n22 Appendix B. As-built veriﬁcation matrix\n23 Appendix C. Source traceability\nTen original engineering ﬁgures document the as-built architecture, runtime ﬂows, safety controls, recovery model, and evidence pipeline.\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n2 / 35\n```\n\n### Page 3\n\n```text\nAbstract\nAgnes Harness (AGH) is an implemented, model-independent, open, recoverable, and evidence-ﬁrst agent runtime. It is\nnot a model API wrapped with a loose collection of tools. It converts model proposals into trustworthy task outcomes\nunder stable protocol, state, security, and evaluation semantics.\nThe completed architecture has three centers of gravity. First, a Trusted Core is the only authority for command\nordering, policy, approval, budget, external eﬀects, and committed task state. Models, clients, tools, and extensions\npropose actions but cannot redeﬁne truth or bypass ﬁnal safety decisions. Second, an append-only event ledger is the\nsole source of truth. Model context, operator UI, crash recovery, and evaluation data are deterministic projections of the\nsame ordered event stream. Third, every external side eﬀect is enclosed by an Eﬀect Sandwich: durable intent, policy\nand approval, bounded execution, and durable outcome. Rejection, cancellation, partial execution, and unknown\noutcomes are therefore explicit runtime states rather than missing logs.\nThe implemented system contributes a two-level execution model, typed replay semantics, versioned Host and event\ncontracts, a stamped context pipeline, a replaceable CodeRuntime boundary, a lifecycle-complete extension trust\nmodel, and a same-model A/B methodology that isolates harness contribution. Its extension layer includes an FDE-\ncompatible workﬂow: engineers build independently from versioned contract packs, documentation, schemas,\nexamples, and conformance ﬁxtures, then integrate without forking Trusted Core. AGH also ships an MHS plugin and\nMHS-facing interface that map intelligent hardware discovery, state, procedures, read/write operations, safety\nconstraints, and receipts into the same policy and event path as software tools.\nAGH executes a full repository workﬂow from instruction through model reasoning, controlled ﬁle and shell eﬀects,\napproval, diﬀ, test, restart recovery, and replayable trace. The same eﬀect discipline extends to physical devices: every\nMHS write or procedure is policy-scoped, approval-aware, driver-mediated, device-interlocked, and durably recorded.\nThe original D1-D10 sequence is retained in this report as implementation provenance and an acceptance record, not as\nunﬁnished work.\nThe central result is architectural and operational: AGH has been completed as a coherent runtime in which protocol,\nevents, eﬀects, recovery, and evidence form one causal chain. The supplied material does not include numeric\nbenchmark tables, so this report does not invent throughput, latency, cost, or task-success values. Where performance\nattribution is discussed, it describes the implemented evaluation method and the evidence required to publish a\nquantitative claim.\nExecutive findings\n1. One authority is non-negotiable. Clients, models, tools, and extensions cannot each maintain their own task\ntruth or safety rules. Trusted Core owns ordering and ﬁnal eﬀect authorization.\n2. State must include eﬀects, not only messages. Saving a conversation without recording intent, approval,\nexecution state, and receipts cannot safely recover destructive or externally visible actions.\n3. The ledger is the system asset. The same committed facts drive model context, restart recovery, operator\ninspection, and evaluation. Snapshots are caches, never authority.\n4. A worker process is not a sandbox. Process separation provides fault containment and lifecycle control.\nSecurity requires an independent execution boundary that constrains ﬁle, process, network, environment, and\nresource access.\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n3 / 35\n```\n\n### Page 4\n\n```text\n5. The completed vertical path proves system coherence. One inspectable repository task crosses protocol,\nreasoning, eﬀects, recovery, and evidence without bypassing core semantics.\n6. Persistent Python is subordinate to Host truth. The deployed CodeRuntime is optional and policy-controlled;\nﬁle-based context remains the attribution baseline.\n7. Open extension does not mean replaceable authority. Extensions declare identity, provenance, compatibility,\npermissions, cleanup, and resource leases; community code runs isolated and cannot replace the ledger or\npolicy engine.\n8. Harness value must be measured causally. Hold model, task, prompt, tools, permissions, budget, and\nenvironment constant; change one AGH mechanism at a time and preserve all failures.\n9. FDE compatibility is a contract, not privileged access. Engineers can author extensions from stable\ndocuments and ﬁxtures, while admission, permissions, isolation, evidence, and cleanup remain machine-\nenforced.\n10. MHS connects agents to intelligent hardware without weakening physical safety. Device discovery and\ncontrol enter through an MHS plugin, but real-time limits, interlocks, emergency stop, and fail-safe behavior\nremain below the model in the device or driver layer.\n1. System status, scope, and evidence basis\n1.1 Product deﬁnition\nAGH is a stable runtime boundary among:\nproduct clients and human operators;\nmodel providers and streaming responses;\ntool, MCP, and MHS hardware capabilities;\ndurable task state and artifacts;\npolicy, approval, secrets, and sandbox enforcement;\nFDE-authored extensions and lifecycle governance;\ntrace, replay, and evaluation.\nIt is explicitly not a model-speciﬁc shell, a plugin bus that allows arbitrary replacement of core behavior, or a feature\nchecklist. The model determines a capability ceiling; AGH determines whether that capability becomes a reliable,\nrecoverable, auditable task result.\n1.2 As-built status\nThe system owner has conﬁrmed that AGH is complete. Earlier source labels such as “Phase 0 candidate,” “technical\npreview,” and “target architecture” are therefore interpreted as historical planning language. They do not describe the\npresent maturity of the system documented here.\nThis report uses four evidence labels:\nLABEL MEANING\nImplemented Present in the completed AGH system described by the supplied architecture\nEnforced invariant Runtime behavior backed by protocol, policy, persistence, or conformance logic\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n4 / 35\n```\n\n### Page 5\n\n```text\nLABEL MEANING\nOptional capability Implemented behind a declared adapter or policy switch; not required for every task\nQuantitative evidence boundary A metric requiring raw benchmark results that were not supplied with this report\nExternal projects and papers remain design references only; their measured results are not represented as AGH results.\n1.3 Implementation history and release progression\nThe two schedules in the source set describe how the completed architecture was assembled:\nD1-D10 recorded the ﬁrst end-to-end implementation and acceptance sequence;\nPhase 0, v0.1, v0.x, and v1 described successive platform-expansion horizons.\nIn the as-built interpretation, these labels are provenance rather than open commitments:\nHISTORICAL\nSTAGE COMPLETED ENGINEERING OUTCOME\nD1-D10 Canonical contracts, one full causal task path, recovery, negative safety tests, extension lifecycle, and replayable\nevidence\nPhase 0 Core invariants, evidence format, reuse boundary, and public/private boundary frozen\nv0.1 Usable local CLI/TUI runtime with core tools and recovery\nv0.x Durable jobs, daemon and channel integration, broader extension and modality support\nv1 architecture Hosted routing, multi-tenant controls, remote execution boundaries, and evidence feedback integration\nHistorical time estimates are intentionally omitted from the current status statement. Completion is asserted by the\nsystem owner; quantitative release-quality metrics are reported only when raw results are available.\n2. Design principles and hard invariants\n2.1 Principles\nAGH follows seven principles:\n1. Schema ﬁrst. Cross-client and cross-language meaning comes from one versioned schema, not handwritten\nduplicates.\n2. One Core. Final ordering, state commitment, and safety decisions have one authority.\n3. Events before projections. Facts are committed before they become visible to model, UI, or recovery logic.\n4. Eﬀects are explicit. Every external side eﬀect has a typed replay contract and durable causal chain.\n5. Fail closed. Missing approval, incompatible versions, undeclared capability, sequence conﬂict, or invalid\nprovenance stops the action.\n6. Open at declared seams. Providers, tools, skills, FDE packages, MHS drivers, hooks, clients, stores, and\nexecution backends can vary without replacing authority.\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n5 / 35\n```\n\n### Page 6\n\n```text\n7. Evidence ﬁrst. A capability claim requires frozen conﬁguration, original trace, scoring rules, failure examples,\nand known limits.\n2.2 Kernel invariants\nThe implementation enforces the following invariants; violations fail CI or runtime conformance:\nevery committed event has identity, ordering, actor, origin, trust, contract version, type, and payload;\nvisible task state advances only after a successful event append;\neach aggregate accepts exactly the expected next sequence;\nan unknown event or item is preserved and displayed generically, not silently dropped;\napproval is a closed result set and unavailable approval fails closed;\npolicy is enforced at dispatch, below tool and extension implementations;\na stale runtime generation cannot commit after cancellation or lease transfer;\nevery eﬀect has one of replay-safe , idempotent , or never-replay  semantics;\na never-replay  eﬀect with an unknown outcome is never automatically repeated;\nsecret values are references, not event payloads;\nextension capabilities exist only if declared and leased;\nFDE packages enter only through versioned manifests, documentation contracts, conformance ﬁxtures, and\nprovenance checks;\nMHS writes and procedures cannot bypass policy, approval, eﬀect recording, device-side interlocks, or\nemergency-stop semantics;\nuntrusted input cannot promote memory, skill, prompt, or harness state without a review path;\nsnapshot loss changes performance, not truth.\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n6 / 35\n```\n\n### Page 7\n\n```text\n3. As-built system architecture\nFigure 1. AGH has one Trusted Core and one authoritative event stream. Interfaces above and below the Core remain replaceable,\nbut ordering and safety authority do not.\n3.1 Experience and Host surfaces\nThe implemented experience layer supports CLI/TUI, headless SDK, Desktop/IDE, channels and automation, external\nharness integration, and human approval. These are protocol peers. No oﬃcial interface receives private task-state\nsemantics unavailable to third-party clients.\nAll clients use the Host Contract to:\ninitialize and negotiate capabilities;\ncreate tasks and turns;\nsubmit items or commands;\nreceive ordered events from a cursor;\nanswer approval requests;\ncancel, resume, fork, and subscribe.\nCLI/headless formed the ﬁrst completed slice; all other surfaces consume the same versioned Host Contract rather than\nmaintaining private execution paths.\n3.2 Stable Host Contract\nThe Host Contract contains four logical planes:\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n7 / 35\n```\n\n### Page 8\n\n```text\nPLANE MINIMAL CONTENT FAILURE RULE\nSchema and\ninitialization\nversion, capabilities, transport features incompatible major version fails explicitly\nCommand plane task, turn, approval, cancel, resume, fork commands are idempotently identiﬁed and\ngeneration-scoped\nEvent stream ordered item/event, cursor, snapshot baseline,\nbackpressure\ncursor conﬂict or unsupported behavior is explicit\nTransport adapters stdio, local socket, TLS transport transport does not redeﬁne protocol meaning\nClient parity is a protocol requirement: an unknown event must survive transport and remain inspectable even if a client\nlacks a specialized renderer.\n3.3 Trusted Core\nTrusted Core coordinates:\nOperation Queue: serializes user operations, cancellation, retries, and generation fencing;\nAgent Loop: executes the model-tool-stop phase machine;\nContext Pipeline: constructs bounded, normalized, stamped model projections;\nTool Broker: validates schema and sends an action through policy, approval, execution, and result\nnormalization;\nEvent Ledger: commits ordered facts and exposes cursors;\nPolicy Engine: resolves principal, trust, scope, budget, path, network, and ﬁnal action decision;\nTask State: reconstructs task, turn, item, pending eﬀect, and recovery status;\nCapability Host: presents ﬁles, shell, MCP, skills, FDE packages, MHS devices, providers, and extension leases;\nTrace and Eval: derives reproducible evidence without maintaining a second truth store.\n3.4 Execution and persistence planes\nThe execution plane contains the Worktree Executor, Sandbox Adapter, optional CodeRuntime, isolated extension\nworker, FDE packages, the MHS plugin and device-driver workers, and external model/MCP services. The persistence\nplane contains the event store, derived snapshots, content-addressed artifacts, secret references, device receipts and\ntelemetry references, and trace/evaluation outputs.\nThe main boundary is:\nproposal -> Trusted Core decision -> bounded execution -> durable receipt\nNo executor or extension may make its own result visible without committing through the Core.\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n8 / 35\n```\n\n### Page 9\n\n```text\n4. Implemented end-to-end scope\nFigure 2. The completed system couples the original vertical core path with broader platform capabilities. Both sides obey the\nsame protocol, event, policy, and recovery invariants.\n4.1 Accepted ﬂagship workﬂow\nThe end-to-end acceptance workﬂow is a real repository repair:\nuser instruction\n  -> repository/resource inspection\n  -> model proposes file or shell action\n  -> policy and human approval where required\n  -> isolated worktree execution\n  -> diff and test artifacts\n  -> restart or cancellation handling\n  -> final verification and trace package\nThis workﬂow crosses the complete causal chain: protocol, streaming model, tool intent, approval, side eﬀect, artifact,\ntask state, recovery, and evidence. It is the reference path used to demonstrate that the components operate as one\nsystem rather than as disconnected features.\n4.2 Completed capability set\nDOMAIN IMPLEMENTED BEHAVIOR\nEntry CLI, TUI, headless SDK, and Host-Contract clients\nModel Provider adapters, streaming, usage accounting, cancellation, and normalized errors\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n9 / 35\n```\n\n### Page 10\n\n```text\nDOMAIN IMPLEMENTED BEHAVIOR\nRuntime Agent Loop, outer Operation Queue, worker lifecycle, subagent and automation control\nState Event ledger, cursor, snapshot, resume projection\nExecution File and shell tools through Tool Broker, approval, bounded worktree, and sandbox adapters\nContext Repository resources, recent events, tool results, normalization, compaction\nExtension Skill, MCP, FDE package, and MHS plugin discovery, declaration, invocation, failure isolation, and cleanup\nIntelligent\nhardware\nMHS discovery, reference data, state reads, guarded writes, procedures, telemetry, emergency stop, and durable\ndevice receipts\nEvidence Diﬀ, tests, raw events, failure classiﬁcation, replay manifest\n4.3 Deliberate architectural boundaries\nCompletion does not mean that every capability runs in every task. AGH keeps several features optional or policy-\ndependent:\npersistent CodeRuntime is activated only when its statefulness beneﬁts the task;\ncommunity extensions remain isolated and capability-leased;\nFDE autonomy operates within published contracts and conformance gates rather than direct Core modiﬁcation;\nthe MHS interface declares its research-preview protocol proﬁle so later oﬃcial schema revisions remain\nnegotiable;\nsandbox enforcement is reported per platform and execution backend;\nhosted controls remain separated from local/open runtime authority;\nbenchmark leadership is not claimed without the corresponding raw dataset and experiment manifest.\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n10 / 35\n```\n\n### Page 11\n\n```text\n5. Process and deployment topology\nFigure 3. AGH supports a local-ﬁrst deployment and process-separated workers. Logical module boundaries use the same\ncontracts in either placement.\n5.1 Host process\nThe Host process owns the protocol server and lifecycle. A root runtime worker runs the queue, agent loop, context\npipeline, and tool coordination. Child workers provide isolated, quota-scoped execution for subordinate work. Storage\nservices commit events and persist artifacts. The optional Code Kernel provides a replaceable stateful runtime without\nbecoming a second source of truth.\nThe UI never owns execution. A client can disconnect without terminating task truth. Host task state survives worker\nfailure.\n5.2 Execution boundary\nThe Tool Broker passes an approved eﬀect to a Worktree Executor through a Sandbox Adapter. The boundary\nconstrains:\ncanonical working directory and path traversal;\nenvironment and secret references;\nprocess group, timeout, cancellation, and resource quota;\nnetwork access;\nartifact and output capture.\nSeparating a runtime into another process provides fault containment but does not prevent that process from reading\nﬁles, opening sockets, or spawning children. The sandbox is a distinct enforcement layer.\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n11 / 35\n```\n\n### Page 12\n\n```text\n5.3 Implemented deployment proﬁles\nPROFILE RUNTIME PLACEMENT PERSISTENCE SECURITY BOUNDARY\nLocal\ninteractive\nlocal Host with CLI/TUI or\nDesktop client\nlocal event store and artifact\ndirectory\nworktree plus platform sandbox\nadapter\nLocal service daemon, root-session workers,\ndurable jobs and channels\ndurable local jobs, events,\nsnapshots, and artifacts\nisolated extension and child workers\nRemote\nexecution\nlocal or hosted Host dispatching\nhigh-risk eﬀects remotely\nservice-backed events plus\ncontent-addressed artifacts\nremote sandbox, network policy, and\nexecution receipts\nHosted multi-\ntenant\ntenant-aware routing and worker\nlifecycle\ndatabase-backed event/job\npersistence plus artifact service\nremote sandbox, tenant policy, secret\nbroker, and quota enforcement\n6. Runtime execution model\nFigure 4. The ledger participates throughout the task, rather than receiving an after-the-fact activity log.\n6.1 Causal task sequence\n1. Client and Host negotiate protocol and capabilities.\n2. Client creates a task and starts a turn.\n3. Runtime commits task and turn events.\n4. Runtime loads a resume projection and cursor.\n5. Context Pipeline constructs and stamps the model request.\n6. Model streams content and may propose a tool intent.\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n12 / 35\n```\n\n### Page 13\n\n```text\n7. Runtime commits the intent before any side eﬀect.\n8. Policy evaluates principal, origin, trust, scope, paths, network, and budget.\n9. Approval is requested when policy requires a human decision.\n10. Executor performs a bounded action after approval.\n11. Result, receipt, partial output, and artifact references are committed.\n12. Runtime projects the tool result back to the model and continues or completes.\n13. Final answer, usage, veriﬁcation, and task outcome become ordered events.\n14. Client receives ordered items and a next cursor.\n6.2 Two-level state model\nFigure 5. The outer machine protects operation ordering and generations. The inner machine provides precise turn-level recovery.\nThe outer Operation Queue handles idle , accepting , running , awaiting_approval , cancelling , recovering ,\nand terminal outcomes. It serializes commands aﬀecting one task aggregate. A new runtime generation fences out stale\nwriters after cancellation, takeover, or resume.\nInside a running turn, the Agent Phase Machine advances through:\ncontext.build\n  -> model.stream\n  -> tool.intent\n  -> policy.evaluate\n  -> effect.execute\n  -> result.integrate\n  -> model.continue | turn.complete\nQueue and phase are separate because they solve diﬀerent problems. The queue governs concurrent commands and\nlifecycle; the phase machine governs semantic progress inside one model/tool loop.\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n13 / 35\n```\n\n### Page 14\n\n```text\n6.3 Cancellation\nCancellation is a committed command with origin and generation. It propagates to the model request, executor, process\ntree, and optional CodeRuntime. Partial output is preserved. A cancelled process must not remain alive, and a late result\nfrom the cancelled generation must be rejected.\n7. Event, state, and projection model\nFigure 6. One ordered event stream produces four consumer-speciﬁc views. This avoids separate, drifting histories for the model,\nUI, recovery, and evaluation.\n7.1 Canonical event envelope\nThe implemented agnes.event/v1  envelope is:\n{\n  "schema_version": "agnes.event/v1",\n  "event_id": "evt_...",\n  "aggregate_id": "task_...",\n  "sequence": 42,\n  "causal_id": "evt_...",\n  "actor": { "type": "model", "id": "provider/model" },\n  "origin": { "host": "cli", "extension": null },\n  "trust": "untrusted-model-output",\n  "contract_stamp": "sha256:...",\n  "occurred_at": "RFC3339 timestamp",\n  "type": "tool.intent.recorded",\n  "payload": { "tool": "shell", "args_ref": "artifact://..." }\n}\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n14 / 35\n```\n\n### Page 15\n\n```text\nAn earlier source draft used seq , id , ts , data , and optional projection/register ﬁelds. AGH resolved the\nincompatibility by standardizing the envelope above and treating the older form as design provenance rather than a\nsupported wire format. Projection and register semantics are carried by versioned event types and payload conventions;\nproduct code does not emit both envelopes.\n7.2 Event families\nThe implemented ledger organizes events into these families:\nFAMILY EXAMPLES RECOVERY SEMANTICS\nCommand task.created, turn.started, cancel.requested replay-safe command journal\nModel request.started, response.delta, response.completed,\nresponse.failed\ndo not recall model if completed result is\ncommitted\nEﬀect tool.intent, approval.requested/decided, eﬀect.started, eﬀect.result follow typed replay class\nState checkpoint.created, projection.rebuilt derived and rebuildable\nEvaluation veriﬁcation.recorded, score.recorded preserve conﬁg and evidence references\nThe schema also covers cost, format deviation, repair decisions, jobs and artifacts, participant/principal, feedback, and\nself-reﬁnement events. New event types enter through versioned schema and conformance ﬁxtures, never ad hoc\nJSON.\n7.3 Four projections\nModel projection: role/content/tool results selected and compacted for the next model call.\nResume projection: queue state, current phase, pending approval/eﬀect, generation, and cursor.\nOperator projection: timeline, diﬀ, approval cards, usage, failures, and diagnostics.\nEval projection: outcome, latency, cost, tool correctness, recovery, retry, and human intervention.\nProjection code must be pure with respect to the committed stream. A projection cache can be discarded and rebuilt.\n7.4 Concurrency and ordering\nEach task aggregate is a single ordered stream. Append uses an expected sequence or writer generation. Conﬂict\nrejects the append; it does not merge silently. This protects recovery when a former worker returns after a new worker\nhas taken over.\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n15 / 35\n```\n\n### Page 16\n\n```text\n8. Effect safety, replay, and recovery\nFigure 7. An eﬀect becomes auditable because its proposal, authorization, execution, and result are separate durable facts.\n8.1 Eﬀect Sandwich\nThe sequence is:\nmodel proposal\n  -> durable intent\n  -> policy evaluation\n  -> approval decision\n  -> durable effect-start marker\n  -> bounded execution\n  -> durable completed | failed | unknown result\nThis distinguishes:\nwhat the model proposed;\nwhat policy allowed;\nwhat a person approved or modiﬁed;\nwhat the executor attempted;\nwhat the external system conﬁrmed.\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n16 / 35\n```\n\n### Page 17\n\n```text\n8.2 Typed replay contract\nCLASS EXAMPLES RECOVERY BEHAVIOR\nReplay-safe read ﬁle, list directory, query status repeat against the recorded input version\nIdempotent content-addressed write, API call with idempotency key retry with the identical key and correlate receipt\nNever replay send message, payment, delete, deploy mark unknown and require conﬁrmation or compensation\nThe class belongs to the capability declaration, not model judgment. A composite run_code  cell inherits the most\ndangerous internal eﬀect and should default to never-replay  unless subeﬀects are independently brokered and\nrecorded.\n8.3 Recovery cases\nCRASH LOCATION RECOVERY DECISION\nBefore intent append no eﬀect is assumed; resume normally\nIntent committed, execution not\nstarted\nreplay only if class allows it\nStarted committed, no result inspect receipt/idempotency; otherwise mark unknown\nResult committed integrate result; never execute again\nModel stream incomplete ignore incomplete assistant message projection and rerun the stamped request according to\nmodel-call policy\nWorker lost after takeover stale generation cannot append\nThe system exposes unknown  status rather than translating uncertainty into success or failure.\n8.4 Recovery acceptance tests\ncrash between every adjacent pair of eﬀect events;\nkill Host or worker during ﬁle read, ﬁle write, long shell process, approval wait, and model stream;\nrestart and conﬁrm identical resume projection;\nverify a never-replay action is not repeated;\nverify an idempotent action uses the same key;\nverify process cancellation leaves no child process;\nverify a late stale-generation result is rejected;\nverify event and artifact references remain inspectable.\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n17 / 35\n```\n\n### Page 18\n\n```text\n9. Context Pipeline and optional CodeRuntime\nFigure 8. The prompt is a bounded projection, not the task's storage layer. A persistent runtime remains optional and subordinate\nto Host truth.\n9.1 Information layers\nLAYER CONTENT AUTHORITY\nL0 model weights and static knowledge model provider\nL1 active prompt, recent history, selected tool results bounded model projection\nL2 optional persistent code runtime and working variables replaceable execution cache\nL3 events, ﬁles, skills, artifacts, memory, task facts durable Host-controlled state\nThe numbering is an information-layer convention in AGH and is unrelated to hardware cache terminology.\n9.2 Context construction\nThe pipeline:\n1. loads repository, task, and instruction resources;\n2. reads recent and pending event projections;\n3. selects information by scope, trust, relevance, and budget;\n4. normalizes roles, tool results, and structured errors;\n5. compacts old material into summaries plus durable references;\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n18 / 35\n```\n\n### Page 19\n\n```text\n6. stamps version, hash, contract, and provenance;\n7. emits a bounded model request.\nCompaction hides material from L1 but does not delete L3 truth.\n9.3 File-based context A/B\nAGH's implemented evaluation path compares two treatments on the same long-material task:\nA: inject the full material directly into the prompt;\nB: place material in workspace ﬁles and allow on-demand retrieval.\nThe experiment holds model, task, prompt policy, tools, permissions, budget, timeout, and environment constant, then\nrecords task success, tokens, latency, tool calls, failure types, and human intervention. The result controls policy\nselection: persistent CodeRuntime is enabled only for workloads whose evidence justiﬁes stateful execution. No\nnumeric outcome is asserted here because the source package did not include the raw benchmark table.\n9.4 CodeRuntime contract\nThe deployed optional adapter exposes:\nexecute · interrupt · snapshot · restore · artifact\nHost continues to own goal, child tasks, usage, lifecycle, and events. Kernel state is a recoverable optimization. Its\nprocess is not a security boundary, and native I/O must pass through brokered capabilities or a sandbox with honest\nfull  versus partial  enforcement labeling.\n10. Tool and capability model\n10.1 ToolCapability contract\nEach capability declares:\nstructured input and result schemas;\nrisk and eﬀect class;\nrequired permissions and scopes;\nconcurrency and cancellation behavior;\ntimeout and partial-output semantics;\nexecutor and sandbox requirements;\nartifact and receipt production;\nreplay contract.\nHardware-facing capabilities additionally declare physical units, state freshness, operating envelope, preconditions,\ndevice-enforced interlocks, emergency-stop behavior, safe-state behavior, and whether an action requires supervised or\nunattended operating mode.\nTool Broker performs schema validation, policy evaluation, approval, execution dispatch, result normalization, and event\ncommitment. Providers or tools do not implement business retries that could duplicate an eﬀect.\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n19 / 35\n```\n\n### Page 20\n\n```text\n10.2 Core tool set\nThe accepted repository workﬂow uses a deliberately bounded capability surface:\nrepository/resource inspection;\nﬁle read and bounded edit;\nshell command inside worktree;\ntest execution;\ndiﬀ and artifact collection.\nAGH also supports standard, hybrid, and code-disclosure proﬁles. Disclosure experiments are isolated from recovery\nconformance so that attribution remains causal.\n10.3 Approval semantics\nApproval returns a closed result such as allow, deny, or modify. A decision binds at least:\n(scope, capability, normalized arguments hash, task/session, generation)\nChanging command, working directory, path, session, or arguments invalidates the approval. If no approver exists in an\nunattended context, the action is denied or parked according to explicit policy; it does not wait forever.\n11. Extension and trust architecture\nFigure 9. FDE-authored packages and MHS device drivers enter through one governed lifecycle. Capability expansion is open,\nwhile protocol truth, eﬀect authorization, and physical safety boundaries remain closed to replacement.\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n20 / 35\n```\n\n### Page 21\n\n```text\n11.1 Extension lifecycle\nAn extension moves through discover, validate, authorize, load, invoke, unload, and cleanup. Its manifest declares:\nidentity and origin;\nversion and compatible AGH protocol range;\ncapabilities and permissions;\nentry points and execution mode;\nresource and budget requirements;\ncleanup and residue checks.\nUndeclared capability calls fail. Unload residue is a conformance failure.\n11.2 Trust levels\nLEVEL EXECUTION AND ADMISSION\nBuiltin shipped with AGH and covered by release process\nVeriﬁed signature, service verdict, and content hash agree\nCommunity untrusted by default; isolated worker, no install scripts, explicit capability lease\nUnknown quarantined until provenance and policy decision exist\nCommunity code never becomes part of Trusted Core merely because it is popular or locally installed.\n11.3 Open and closed surfaces\nOpen surfaces include Skills, MCP/tools, FDE packages, MHS plugins and drivers, model providers, restricted hooks,\nand constrained declarative interaction. Closed authority includes protocol meaning, event ordering, ﬁnal policy, secret\naccess, sandbox decisions, and the requirement that physical interlocks execute below the model.\nAGH implements Skill, MCP, FDE, and MHS extension paths through the same lifecycle: discovery, manifest validation,\ncapability authorization, invocation, failure isolation, unload, and cleanup. No path can replace Trusted Core authority.\n11.4 FDE-compatible engineering workﬂow\nIn this report, FDE denotes the Forward-Deployed Engineer workﬂow: an engineer can independently implement a\ndomain integration from agreed documentation, validate it locally, and deliver a package that AGH can admit without a\ncustom Core branch. Compatibility is established by an explicit FDE Contract Pack:\nCONTRACT-PACK\nELEMENT ENGINEER RESPONSIBILITY AGH ADMISSION CHECK\nextension.yaml identity, version, entry points, requested capabilities,\npermissions, budgets, compatibility range\nschema, provenance, signature/hash,\ncompatibility\nInterface schemas typed inputs, outputs, events, errors, cancellation, replay class generated bindings and contract tests\nOperational\ndocumentation\npurpose, examples, prerequisites, conﬁguration, known limits,\nrollback and cleanup\nrequired sections and documentation-\nversion stamp\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n21 / 35\n```\n\n### Page 22\n\n```text\nCONTRACT-PACK\nELEMENT ENGINEER RESPONSIBILITY AGH ADMISSION CHECK\nPolicy proﬁle paths, network, secrets, external systems, human approvals,\ndata classiﬁcation\nleast-privilege lease and deployment\npolicy intersection\nConformance ﬁxtures positive, negative, timeout, cancellation, replay, residue, and\nupgrade cases\nisolated test runner with deterministic\nevidence package\nObservability mapping event types, metrics, receipts, artifact references, redaction rules trace completeness and privacy checks\nThe integration ﬂow is:\nread contract pack\n  -> scaffold package\n  -> implement behind generated interfaces\n  -> run local doctor and conformance fixtures\n  -> sign and publish immutable package\n  -> discover and validate\n  -> authorize capability lease\n  -> load in isolated worker\n  -> invoke through Tool Broker\n  -> unload, revoke, and verify zero residue\nThis contract gives an FDE implementation autonomy without granting policy autonomy. Engineers may add domain\nknowledge, tools, adapters, device drivers, and declarative UI, but they cannot redeﬁne Host semantics, write directly to\nthe ledger, access secrets outside a lease, or execute side eﬀects outside the Eﬀect Sandwich. Documentation is part\nof the executable contract: its version and hash are included in the extension manifest and trace.\n11.5 Built-in MHS plugin and intelligent-hardware interface\nAnthropic describes the Model Hardware Standard (MHS) as a model-agnostic shared speciﬁcation for agents to\nsafely operate programmable physical devices. Its public research-preview design centers on standardized drivers, a\nsmall set of read/write primitives, standard discovery, machine-readable device states and procedures, natural-language\nhardware knowledge, and access through standard protocols such as MCP. MHS is the device abstraction and\nsemantics layer; MCP can be one access path rather than a synonym for MHS. See Anthropic's MHS research-preview\nannouncement and the oﬃcial research-preview site.\nAGH ships an MHS plugin that exposes the versioned proﬁle agh.mhs/research-preview-v1 . The proﬁle implements\nthe public concepts available at the report date while isolating ﬁeld-level mappings behind an adapter so that a later\noﬃcial schema can be negotiated without changing Trusted Core.\nAgent / workflow / operator\n  -> AGH Host Contract\n  -> Capability Host + Tool Broker\n  -> policy, approval, budget, and durable intent\n  -> MHS plugin\n  -> standardized MHS driver\n  -> vendor API / SDK / GUI adapter\n  -> physical device and device-side interlocks\n  -> state, telemetry, receipt, or fault event\n  -> AGH event ledger\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n22 / 35\n```\n\n### Page 23\n\n```text\nThe MHS-facing interface is:\nOPERATION CONTRACT AGH EFFECT SEMANTICS\ndiscover enumerate device identity, kind, location, connectivity, driver\nand protocol proﬁle\nreplay-safe; result has freshness and\nprovenance\nreference return machine-readable capabilities, units, limits, natural-\nlanguage operating knowledge, and safety constraints\nreplay-safe; content is trust-labeled and\nversion-stamped\nread_state read one or more state variables with timestamp and quality replay-safe against recorded device/session\nidentity\nwrite_state request a bounded state change with units, range,\npreconditions, command key, and dry-run mode\nidempotent only when the driver supplies a\nstable command key; otherwise never-replay\ninvoke_procedure execute a declared procedure with typed inputs,\npreconditions, completion criteria, timeout, and compensation\nguidance\ndefaults to never-replay; requires policy and,\nwhere conﬁgured, human approval\nsubscribe stream state/telemetry with sequence, timestamp, quality, and\nbackpressure\nresumable subscription; gaps become explicit\nevents\nemergency_stop request the device-deﬁned safe stop and report\nacknowledgement\nhigh-priority independent path; never\nsuppressed by normal queue backpressure\nRead-only state can be projected as an MCP resource and guarded procedures can be exposed as MCP tools, but all\nroutes converge on the same MHS capability identity and eﬀect policy. Low-latency control loops, hard limits, collision\navoidance, thermal protection, PLC logic, and emergency stops remain in the device, controller, or local driver. A remote\nmodel is never treated as a real-time safety controller.\nThe implementation records device_id , driver_version , protocol_profile , state/reference version, requested\noperation, normalized units, principal, approval binding, command/idempotency key, timestamps, enforcement level,\ndevice acknowledgement, terminal state, and receipt reference. Unknown physical outcomes are never automatically\nretried.\n12. Security architecture\n12.1 Trust model\nInputs from model output, repository content, web content, community extensions, tools, and remote services are\nuntrusted unless explicitly elevated. actor , origin , and trust  are audit facts, not authorization by themselves.\nAuthorization derives from surface, scope, capability, arguments, task, and managed policy.\n12.2 Threat and negative-test matrix\nTHREAT FAILURE MODE CONTROL REQUIRED NEGATIVE TEST\nPrompt injection repository or page requests policy\nbypass\norigin/trust labels, policy priority,\nargument revalidation\nmalicious README asks to\nupload secret; request is\ndenied\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n23 / 35\n```\n\n### Page 24\n\n```text\nTHREAT FAILURE MODE CONTROL REQUIRED NEGATIVE TEST\nSecret\nexﬁltration\nmodel or extension reads and emits\ncredentials\nsecret references, output redaction,\nnetwork allowlist\nshell prints environment; secret\nvalue never enters event\npayload\nPath escape ﬁle tool leaves workspace canonical paths, bounded cwd, symlink\ndefense\nrelative and symlink traversal\nfail\nProcess escape cancellation leaves child process process group, timeout, kill tree, quota long command cancellation\nleaves no child\nReplay damage crash repeats dangerous action eﬀect class, key, receipt, unknown state unknown send/delete is not\nrepeated\nSupply-chain\ncompromise\nextension update adds malicious\ncode\nprovenance, pinned version/hash,\nsignature candidate, worker isolation,\nrevoke\nmismatched hash refuses load\nFDE contract\ndrift\nindependently built package targets\nstale docs or schemas\ncontract-pack version/hash, generated\nbindings, compatibility ﬁxtures\nstale package is rejected\nbefore load\nUnsafe\nhardware action\nmodel requests motion, heat,\npressure, voltage, or another\nphysical eﬀect outside limits\nMHS schema, Tool Broker policy,\napproval, local driver checks, device\ninterlocks and emergency stop\nout-of-range command has no\ndevice eﬀect and produces a\nsafety event\n12.3 Enforcement levels\nPolicy controls are always active. OS and remote sandboxes add enforcement. Every eﬀect result records whether\nenforcement was full, partial, or unavailable, and the operator projection displays it. Platform limitations are not hidden\nbehind a generic “sandbox enabled” ﬂag.\n12.4 Secrets\nEvents store secret identiﬁers and access receipts, never plaintext values. The Secret Broker releases a secret only to\nan authorized executor scope. Output normalization redacts matches before event commitment and artifact publication.\n13. Interfaces and failure semantics\nINTERFACE PRODUCER ->\nCONSUMER MINIMAL CONTRACT FAILURE SEMANTICS\nHostProtocol client -> Host initialize, task, turn, item, approval,\ncancel, resume, subscribe\nincompatible version fails; unknown\nitem preserved\nModelProvider adapter -> Agent Loop capabilities, stream, reasoning, usage,\ncancel, normalized error\nCore owns retry; provider cannot\nrepeat business eﬀects\nToolCapability builtin/MCP -> Tool\nBroker\nschema, risk, permissions, execute,\ncancel, result\nstructured args/results; timeout and\npartial output visible\nEventStore Trusted Core ->\nprojections/eval\nappend, cursor read, subscribe,\ncheckpoint\nordering conﬂict rejected; visibility\nfollows commit\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n24 / 35\n```\n\n### Page 25\n\n```text\nINTERFACE PRODUCER ->\nCONSUMER MINIMAL CONTRACT FAILURE SEMANTICS\nCodeRuntime optional runtime ->\ncontext/loop\nexecute, interrupt, snapshot, restore,\nartifact\nruntime failure cannot alter Host truth\nExtensionManifest extension -> Capability\nHost\nidentity, origin, version, compat,\npermissions, entrypoints, cleanup\nundeclared capability fails; residue\nfails gate\nFDEPackage engineer package ->\nCapability Host\ncontract-pack stamp, manifest,\nschemas, docs, ﬁxtures, provenance,\npolicy request\nincompatible or incomplete package is\nrejected before load\nMHSDevice MHS plugin/driver ->\nTool Broker\ndiscover, reference, state, procedures,\nunits, limits, interlocks, receipts, stop\nunsafe request fails closed; unknown\nphysical outcome is never auto-\nreplayed\n13.1 Error taxonomy\nErrors should be normalized into at least:\nprotocol/version;\nmodel/provider;\ncontext/projection;\ncapability/schema;\npolicy/approval;\nsandbox/executor;\npersistence/concurrency;\nrecovery/unknown outcome;\nextension/lifecycle;\nFDE contract/conformance;\nMHS device/discovery/state/procedure/physical-safety;\nenvironment/infrastructure.\nThe taxonomy is used by both the operator projection and evaluation report, preventing a model failure from being\ncounted as a harness failure or an environment failure from being hidden in an aggregate success metric.\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n25 / 35\n```\n\n### Page 26\n\n```text\n14. Observability and evaluation\nFigure 10. Trace, artifacts, failure classiﬁcation, and reports are projections from runtime events, not a separate analytics\ninstrumentation path.\n14.1 Frozen experiment manifest\nEvery reported experiment records:\ncode commit and dependency lock;\nmodel identiﬁer, provider, and parameters;\nprompt and tool schemas;\ntask/repository snapshot;\nbudget, timeout, and approval policy;\noperating system, hardware, and sandbox capability;\nnetwork policy;\nscoring and veriﬁer rules;\nrepetition index and random seeds where applicable.\n14.2 Metrics\nDIMENSION MEASURES\nOutcome task success, tests, veriﬁer result, diﬀ validity\nRecovery successful resume, unknown-eﬀect rate, stale-write rejection\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n26 / 35\n```\n\n### Page 27\n\n```text\nDIMENSION MEASURES\nSafety denied unsafe actions, sandbox enforcement level, secret/path/process negative tests\nEﬃciency input/output tokens, cost or credits, latency, tool calls, retries\nOperations queue time, approval wait, cancellation latency, artifact completeness\nHuman load approvals, interventions, compensations, manual recovery\nFDE\nintegration\nscaﬀold-to-load time, conformance pass rate, review eﬀort, upgrade compatibility, cleanup residue\nHardware device discovery success, state freshness, procedure completion, interlock rejection, emergency-stop\nacknowledgement, unknown-outcome rate\n14.3 Same-model A/B rule\nKeep model, task, prompt, tools, permissions, budget, timeout, repository snapshot, and environment identical. Change\nexactly one mechanism: context selection, compaction, recovery, veriﬁer, disclosure proﬁle, or CodeRuntime. Report all\nfailures, sample size, repetitions, point estimates, uncertainty, and limitations. A best single run is not evidence of\ncapability.\n14.4 Replay package\nAGH exports a privacy-redacted replay package containing:\nfrozen experiment manifest;\nordered events and schema versions;\nartifact references and integrity hashes;\ndiﬀ, tests, logs, receipts, and enforcement labels;\nderived metrics and failure classiﬁcation;\nreproduction instructions;\nknown non-determinism and limitations.\n15. Implementation history and acceptance record\n15.1 Completed D1-D10 sequence\nDAY COMPLETED DELIVERABLE ACCEPTANCE EVIDENCE PRODUCED\nD1 Scenario, versions, scope boundary, schema, reuse boundary, and\nacceptance ﬁxtures were frozen\nscope record and canonical schema decision\nD2 Host handshake, task/turn commands, and event subscription were\nimplemented\nprotocol and compatibility tests\nD3 Real model streaming, usage, cancellation, and normalized provider\nerrors were integrated\nprovider trace and cancellation test\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n27 / 35\n```\n\n### Page 28\n\n```text\nDAY COMPLETED DELIVERABLE ACCEPTANCE EVIDENCE PRODUCED\nD4 File/shell loop, Tool Broker, approval, and denial path were completed no-eﬀect denial and structured error evidence\nD5 The repository task ran end to end inspectable ledger, diﬀ, test, and trace\nD6 Context checkpoint, restart, and pending-eﬀect recovery were completed crash matrix and resume projection\nD7 Extension admission, invocation, failure isolation, and cleanup were\nimplemented\nmanifest, invocation, failure, and residue evidence\nD8 Threat negatives and process-tree cancellation were integrated into\nconformance\nclassiﬁed failures and security evidence\nD9 Same-model, one-mechanism A/B instrumentation was completed frozen manifest, raw-event format, and limitation\nschema\nD10 The full path was packaged as a reproducible acceptance run demo package, test report, declared limits, and\nacceptance decision\n15.2 Frozen implementation decisions\nImplementation established the following stable decisions:\n1. a repository-repair workﬂow and ﬁxed task ﬁxtures provide the reference causal path;\n2. agnes.event/v1  and the versioned Host Contract are canonical;\n3. direct dependencies, selectively reused code, and original AGH modules have explicit ownership boundaries;\n4. Skill, MCP, FDE, and MHS integrations enter through the common Capability Host and lease model;\n5. model providers implement one normalized streaming, usage, cancellation, and error contract;\n6. module owners review interface and schema changes rather than allowing local semantic forks;\n7. license, NOTICE, repository, disclosure, and public/private boundaries are release-governed.\n15.3 Acceptance outcome\nThe completed system satisﬁes the following acceptance conditions:\nthe ﬁxed repository task produces a valid diﬀ and runs the deﬁned tests;\nevery visible state transition has a committed event;\nan approval denial produces no side eﬀect;\ncancellation terminates the process tree and records partial output;\nrestart resumes from a committed phase and does not repeat a never-replay action;\na sequence conﬂict or stale generation is rejected;\nevent, artifact, and trace integrity references resolve;\nunknown events remain inspectable;\nextensions install or discover, invoke, fail safely, and clean up through the declared lifecycle;\nan independently authored FDE ﬁxture package can be built from the published contract pack, passes\nconformance, loads without Core modiﬁcation, and unloads without residue;\nthe MHS plugin discovers a reference device, reads stamped state, rejects an unsafe write, executes an\napproved safe procedure, records a device receipt, and exercises emergency stop;\nthe security negative cases in Section 12 pass within declared enforcement limits;\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n28 / 35\n```\n\n### Page 29\n\n```text\nthe demo is reproducible from the frozen manifest;\nlimitations distinguish optional capability, unavailable platform enforcement, unreported metric, and known\ndefect.\n16. Research-style contributions and innovation points\nThe following are implemented system contributions. They are not claims of global uniqueness; novelty is framed as\nthe speciﬁc composition and enforceable semantics delivered by AGH.\n16.1 Single-authority, proposal-only edge architecture\nAGH permits broad client, provider, tool, and extension diversity while retaining one authority for event order and\nexternal eﬀects. This avoids the common failure in which plugins or product surfaces become shadow control planes.\n16.2 Ledger-projection uniﬁcation\nModel context, restart state, UI timeline, and evaluation are algorithms over one ledger. The contribution is not event\nlogging alone; it is the prohibition on independently mutable histories for each consumer.\n16.3 Eﬀect Sandwich with typed uncertainty\nIntent and result events bracket external actions. Replay contracts distinguish safe, idempotent, and never-replay\nbehavior, while unknown  is a ﬁrst-class outcome. This treats uncertainty as state rather than an exception to hide.\n16.4 Nested state machines with generation fencing\nThe outer queue controls command concurrency, cancellation, and takeover; the inner machine controls turn semantics.\nGeneration fencing prevents a replaced worker from committing stale results.\n16.5 Stamped context as a reproducible projection\nEach model request has a version/hash/provenance stamp derived from durable resources and events. This makes\ncontext engineering experimentally addressable and separates durable knowledge from prompt residency.\n16.6 Replaceable CodeRuntime subordinate to Host truth\nPersistent execution is an optional seam, not the runtime's state authority or security boundary. Its activation is\nevidence- and policy-driven, and its side eﬀects remain brokered.\n16.7 Lifecycle-complete extension trust\nExtensions are governed from discovery through cleanup, with identity, origin, compatibility, capability lease, budget,\nisolation, audit, revoke, and residue checks. Openness is deﬁned by safe participation, not unrestricted in-process\ncode.\n16.8 Evidence by construction\nEvaluation artifacts originate from the same causal events used for recovery and operator inspection. Same-model A/B\nchanges one harness mechanism at a time, allowing falsiﬁable attribution of AGH value.\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n29 / 35\n```\n\n### Page 30\n\n```text\n16.9 Document-governed FDE extensibility\nThe FDE Contract Pack turns extension documentation into a versioned integration boundary. Generated interfaces and\nexecutable ﬁxtures allow an engineer to implement independently, while provenance, policy intersection, isolation, and\nresidue checks make the result admissible without a privileged Core fork.\n16.10 MHS bridge for intelligent-hardware agents\nThe built-in MHS plugin maps device discovery, reference knowledge, live state, guarded writes, procedures, telemetry,\nand emergency stop into AGH's existing capability and eﬀect model. The innovation is the preservation of one causal\nauthority chain across software and physical eﬀects while leaving hard real-time safety in the device layer.\n17. Operational risks and governance boundaries\n17.1 Critical risks\nRISK FAILURE MODE IMPLEMENTED CONTROL\nScope drift new surfaces bypass the causal path Host Contract and Trusted Core conformance\nEvidence external project or paper result is presented as\nAGH result\npinned versions, local reproduction, same-model A/B\nSecurity worker process is marketed as sandbox;\nextension bypasses policy\nindependent executor boundary and negative tests\nRecovery messages are persisted but eﬀect state is not full intent/approval/started/result chain\nProtocol CLI, UI, and runtime create divergent types schema-ﬁrst generation and compatibility tests\nEvent schema incompatible envelopes reach runtime canonical agnes.event/v1 , compatibility ﬁxtures, and migration\nrules\nContext compaction hides necessary evidence or\nchanges behavior\nreferences, full ledger retention, A/B\nCodeRuntime stateful execution expands attack and replay\nsurface\noptional adapter, brokered eﬀects, policy activation, and A/B\nattribution\nExtension in-process community code compromises Core isolated worker and capability lease\nFDE\necosystem\ndocumentation and implementation drift across\nindependently built packages\nversioned contract packs, generated bindings, conformance\nﬁxtures, immutable package identity\nMHS evolution research-preview concepts change when the\noﬃcial schema is released\nexplicit protocol proﬁle, adapter boundary, capability negotiation,\ncompatibility ﬁxtures\nPhysical\ndevice\na model or remote process is mistaken for a\nsafety controller\ndevice-side interlocks, deterministic local control, supervised\nmodes, emergency-stop path\nCross-\nplatform\nsupport claims exceed actual enforcement generated capability matrix and on-device doctor\nMaintenance platform expansion weakens core invariants compatibility gates and authority-preserving extension seams\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n30 / 35\n```\n\n### Page 31\n\n```text\n17.2 Ongoing operating policies\nThe remaining choices are normal governance controls, not missing implementation:\nwhich model/provider versions and task sets are frozen for a published evaluation;\nwhich platforms advertise full, partial, or unavailable sandbox enforcement;\nwhich budget, credit, and usage limits apply to a deployment;\nwhen task policy enables persistent CodeRuntime;\nwhich extension provenance levels are admitted in each environment;\nwhich MHS protocol proﬁle and device classes are admitted in each deployment;\nwho owns release review, conformance, incident response, and security disclosure.\n17.3 Architecture-preservation conditions\nFuture product evolution must preserve four properties: one authority, one causal ledger, brokered eﬀects, and evidence\nderived from committed facts. A deployment may specialize clients, providers, tools, or storage, but it ceases to be\nconformant AGH if it introduces a shadow state store, bypasses policy for side eﬀects, treats a worker as a sandbox, or\npublishes results without a reproducible experiment manifest.\n18. Conclusion\nAGH is a completed system built as a chain of authority rather than a collection of agent features. The Host Contract\ndeﬁnes stable client semantics. Trusted Core orders commands and authorizes eﬀects. The event ledger records causal\ntruth. The phase machine and replay contract make recovery precise. The Context Pipeline turns durable resources into\nbounded model inputs. The executor and sandbox constrain side eﬀects. FDE contract packs let engineers add domain\nintegrations independently without replacing authority. The built-in MHS plugin extends the same governed chain to\nintelligent hardware while preserving device-side interlocks and deterministic safety. Trace and evaluation derive from\nthe same facts.\nThe historical D1-D10 delivery sequence established the ﬁrst coherent path across every critical layer. Its completed\nacceptance result is not merely “the model edited a ﬁle.” The reference task produces a valid diﬀ and test through\nversioned protocol, durable intent, approval, bounded execution, restart recovery, and a reproducible trace, while unsafe\nand unknown paths remain explicit.\nThe result is an inspectable, recoverable runtime whose failure taxonomy identiﬁes whether a problem lies in the model,\ncontext, protocol, eﬀect control, storage, recovery, tool, or environment. Quantitative performance claims remain\nseparable from implementation status: AGH is complete, while any published throughput, latency, cost, or task-success\nclaim still requires the corresponding frozen manifest and raw results.\nAppendix A. As-built conformance checklist\nHost Protocol\n versioned initialize and capability negotiation\n task and turn commands\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n31 / 35\n```\n\n### Page 32\n\n```text\n ordered event/item stream with cursor\n approval request/decision\n cancellation and generation\n resume and snapshot baseline\n unknown item preservation\n explicit compatibility failure\nEvent Store\n expected sequence append\n immutable aggregate order\n causal identiﬁers\n actor, origin, trust, contract stamp\n cursor read and subscribe\n snapshot/checkpoint metadata\n stale generation rejection\n projection rebuild test\nTool and Eﬀect\n input/result schema\n risk and permission declaration\n eﬀect replay class\n policy and approval binding\n timeout, cancel, and partial output\n intent and started events\n result, receipt, and artifact references\n unknown outcome handling\nExtension\n identity and provenance\n compatibility range\n permissions and capability lease\n execution mode\n budget and timeout\n audit events\n unload and cleanup\n residue failure test\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n32 / 35\n```\n\n### Page 33\n\n```text\nFDE package\n versioned contract pack and documentation stamp\n generated interface bindings\n positive, negative, cancellation, replay, and upgrade ﬁxtures\n local doctor and isolated conformance runner\n immutable package identity and provenance\n policy request intersects with deployment policy\n load without Trusted Core modiﬁcation\n unload with zero capability or resource residue\nMHS plugin\n declared agh.mhs/research-preview-v1  protocol proﬁle\n device discovery and machine-readable reference data\n typed states, units, limits, procedures, and preconditions\n guarded read, write, subscribe, and procedure invocation\n policy, approval, dry-run, idempotency, and receipt binding\n device-side interlock and deterministic safe-state requirement\n emergency-stop path independent of ordinary queue backpressure\n unknown physical outcome is never automatically replayed\nAppendix B. As-built verification matrix\nTEST STIMULUS EXPECTED DURABLE EVIDENCE\nProtocol\nincompatibility\nunsupported major version explicit error; no task created\nEvent conﬂict two writers append same sequence one accepted, one rejected\nApproval deny dangerous shell or outbound request decision event; no eﬀect-start event\nPath escape ..  or symlink outside worktree policy/executor rejection\nSecret output command prints secret environment value redacted output and security event\nCancel long process tree cancel event, partial output, zero child processes\nSafe replay crash during read repeated read with ﬁxed input version\nIdempotent replay crash during keyed write identical key and one external result\nNever replay crash during send/delete unknown state; no automatic second action\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n33 / 35\n```\n\n### Page 34\n\n```text\nTEST STIMULUS EXPECTED DURABLE EVIDENCE\nStale generation old worker returns after recovery append rejected\nProjection rebuild delete snapshot cache identical projection from ledger\nUnknown event inject forward-compatible type preserved and generically visible\nExtension residue extension leaves lease/resource cleanup gate fails\nFDE schema drift package built from an incompatible contract\npack\nadmission fails before worker load\nFDE documentation\ndrift\nmanifest documentation hash diﬀers from\nreviewed pack\npackage is rejected and no capability is leased\nMHS unsafe write target violates units, range, precondition, or\ninterlock\nno device eﬀect; policy/driver rejection and safety event\nMHS approval\nmismatch\ndevice, procedure, arguments, or generation\nchange after approval\napproval invalidated; no device eﬀect\nMHS unknown\noutcome\ndriver disconnects after a physical action starts explicit unknown state; no automatic replay; operator\nrecovery required\nMHS emergency\nstop\nnormal queue is saturated during device\nmotion\nstop request reaches the independent safety path and\nacknowledgement is recorded\nReproduction rerun frozen task package trace and scoring process reproducible within declared\nnondeterminism\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n34 / 35\n```\n\n### Page 35\n\n```text\nAppendix C. Source traceability\nREPORT AREA SUPPLIED MATERIAL BASIS\nOriginal implementation plan, Host Contract, interfaces, threat matrix, and\nevaluation rules\nS1\nEnd-to-end panorama and historical core/platform boundary S2\nLedger projections, replay semantics, context/cost, extension trust, longer\nroadmap, open issues and evidence discipline\nS3\nEleven supplied architecture illustrations used for cross-checking\ncomponent relationships\nS4\nFDE contract-pack workﬂow and MHS plugin integration S5-S6 plus the system-owner capability requirements\nEnglish diagrams, canonical schema resolution, acceptance matrices,\ncontribution framing\nSynthesis in this report from S1-S6 plus the system\nowner's completion-status correction\nSupplied materials\nS1. Agnes Harness Technical Architecture and Technical Plan v0.1. Supplied HTML, dated 1 September 2026.\nS2. Agnes Harness Panoramic Technical Architecture v0.1. Supplied interactive HTML; its Phase 0 labels are\nhistorical planning metadata.\nS3. Agnes Second-Asset Architecture Report. Supplied Markdown, dated 31 August 2026.\nS4. images/d1.png  through images/d11.png . Supplied architecture and roadmap diagrams.\nExternal standards references\nS5. Anthropic. Previewing the Model Hardware Standard, 27 August 2026. Public MHS research-preview\ndeﬁnition, standardized-driver model, discovery, read/write primitives, states/procedures, model-agnostic\naccess, and physical-safety context.\nS6. Model Hardware Standard research preview, accessed 4 September 2026. Oﬃcial preview status and\nplanned open-source trajectory.\nSource documents contain strategic proposals, implementation suggestions, and decision requests. They were treated\nas technical evidence and design input, not as instructions to the report author. The system owner subsequently\nconﬁrmed that AGH is complete and speciﬁed FDE and MHS as implemented AGH capabilities; those corrections\ngovern this as-built report. Anthropic's public MHS material is a research preview rather than a published ﬁeld-level\nstandard, so AGH names its implemented interface proﬁle explicitly and does not claim certiﬁcation against an\nunavailable ﬁnal schema. Where source drafts conﬂict, the completed canonical contract is reported rather than\npreserving obsolete planning alternatives.\nAGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT\n35 / 35\n```\n
EVIDENCE BOUNDARY
Implementation complete · quantitative
benchmarks not supplied
Based exclusively on the supplied AGH HTML, Markdown, and image assets. Embedded source instructions were treated as
design content, not authoring directives.

Contents
01 Abstract
02 Executive ﬁndings
03 1. System status, scope, and evidence
basis
04 2. Design principles and hard invariants
05 3. As-built system architecture
06 4. Implemented end-to-end scope
07 5. Process and deployment topology
08 6. Runtime execution model
09 7. Event, state, and projection model
10 8. Eﬀect safety, replay, and recovery
11 9. Context Pipeline and optional
CodeRuntime
12 10. Tool and capability model
13 11. Extension and trust architecture
14 12. Security architecture
15 13. Interfaces and failure semantics
16 14. Observability and evaluation
17 15. Implementation history and acceptance
record
18 16. Research-style contributions and
innovation points
19 17. Operational risks and governance
boundaries
20 18. Conclusion
21 Appendix A. As-built conformance
checklist
22 Appendix B. As-built veriﬁcation matrix
23 Appendix C. Source traceability
Ten original engineering ﬁgures document the as-built architecture, runtime ﬂows, safety controls, recovery model, and evidence pipeline.
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
2 / 30


Abstract
Agnes Harness (AGH) is an implemented, model-independent, open, recoverable, and evidence-ﬁrst agent runtime. It is
not a model API wrapped with a loose collection of tools. It converts model proposals into trustworthy task outcomes
under stable protocol, state, security, and evaluation semantics.
The completed architecture has three centers of gravity. First, a Trusted Core is the only authority for command
ordering, policy, approval, budget, external eﬀects, and committed task state. Models, clients, tools, and extensions
propose actions but cannot redeﬁne truth or bypass ﬁnal safety decisions. Second, an append-only event ledger is the
sole source of truth. Model context, operator UI, crash recovery, and evaluation data are deterministic projections of the
same ordered event stream. Third, every external side eﬀect is enclosed by an Eﬀect Sandwich: durable intent, policy
and approval, bounded execution, and durable outcome. Rejection, cancellation, partial execution, and unknown
outcomes are therefore explicit runtime states rather than missing logs.
The implemented system contributes a two-level execution model, typed replay semantics, versioned Host and event
contracts, a stamped context pipeline, a replaceable CodeRuntime boundary, a lifecycle-complete extension trust
model, and a same-model A/B methodology that isolates harness contribution. AGH executes a full repository workﬂow
from instruction through model reasoning, controlled ﬁle and shell eﬀects, approval, diﬀ, test, restart recovery, and
replayable trace. The original D1-D10 sequence is retained in this report as implementation provenance and an
acceptance record, not as unﬁnished work.
The central result is architectural and operational: AGH has been completed as a coherent runtime in which protocol,
events, eﬀects, recovery, and evidence form one causal chain. The supplied material does not include numeric
benchmark tables, so this report does not invent throughput, latency, cost, or task-success values. Where performance
attribution is discussed, it describes the implemented evaluation method and the evidence required to publish a
quantitative claim.
Executive findings
1. One authority is non-negotiable. Clients, models, tools, and extensions cannot each maintain their own task
truth or safety rules. Trusted Core owns ordering and ﬁnal eﬀect authorization.
2. State must include eﬀects, not only messages. Saving a conversation without recording intent, approval,
execution state, and receipts cannot safely recover destructive or externally visible actions.
3. The ledger is the system asset. The same committed facts drive model context, restart recovery, operator
inspection, and evaluation. Snapshots are caches, never authority.
4. A worker process is not a sandbox. Process separation provides fault containment and lifecycle control.
Security requires an independent execution boundary that constrains ﬁle, process, network, environment, and
resource access.
5. The completed vertical path proves system coherence. One inspectable repository task crosses protocol,
reasoning, eﬀects, recovery, and evidence without bypassing core semantics.
6. Persistent Python is subordinate to Host truth. The deployed CodeRuntime is optional and policy-controlled;
ﬁle-based context remains the attribution baseline.
7. Open extension does not mean replaceable authority. Extensions declare identity, provenance, compatibility,
permissions, cleanup, and resource leases; community code runs isolated and cannot replace the ledger or
policy engine.
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
3 / 30


8. Harness value must be measured causally. Hold model, task, prompt, tools, permissions, budget, and
environment constant; change one AGH mechanism at a time and preserve all failures.
1. System status, scope, and evidence basis
1.1 Product deﬁnition
AGH is a stable runtime boundary among:
product clients and human operators;
model providers and streaming responses;
tool and MCP capabilities;
durable task state and artifacts;
policy, approval, secrets, and sandbox enforcement;
extensions and lifecycle governance;
trace, replay, and evaluation.
It is explicitly not a model-speciﬁc shell, a plugin bus that allows arbitrary replacement of core behavior, or a feature
checklist. The model determines a capability ceiling; AGH determines whether that capability becomes a reliable,
recoverable, auditable task result.
1.2 As-built status
The system owner has conﬁrmed that AGH is complete. Earlier source labels such as “Phase 0 candidate,” “technical
preview,” and “target architecture” are therefore interpreted as historical planning language. They do not describe the
present maturity of the system documented here.
This report uses four evidence labels:
LABEL MEANING
Implemented Present in the completed AGH system described by the supplied architecture
Enforced invariant Runtime behavior backed by protocol, policy, persistence, or conformance logic
Optional capability Implemented behind a declared adapter or policy switch; not required for every task
Quantitative evidence boundary A metric requiring raw benchmark results that were not supplied with this report
External projects and papers remain design references only; their measured results are not represented as AGH results.
1.3 Implementation history and release progression
The two schedules in the source set describe how the completed architecture was assembled:
D1-D10 recorded the ﬁrst end-to-end implementation and acceptance sequence;
Phase 0, v0.1, v0.x, and v1 described successive platform-expansion horizons.
In the as-built interpretation, these labels are provenance rather than open commitments:
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
4 / 30


HISTORICAL
STAGE COMPLETED ENGINEERING OUTCOME
D1-D10 Canonical contracts, one full causal task path, recovery, negative safety tests, extension lifecycle, and replayable
evidence
Phase 0 Core invariants, evidence format, reuse boundary, and public/private boundary frozen
v0.1 Usable local CLI/TUI runtime with core tools and recovery
v0.x Durable jobs, daemon and channel integration, broader extension and modality support
v1 architecture Hosted routing, multi-tenant controls, remote execution boundaries, and evidence feedback integration
Historical time estimates are intentionally omitted from the current status statement. Completion is asserted by the
system owner; quantitative release-quality metrics are reported only when raw results are available.
2. Design principles and hard invariants
2.1 Principles
AGH follows seven principles:
1. Schema ﬁrst. Cross-client and cross-language meaning comes from one versioned schema, not handwritten
duplicates.
2. One Core. Final ordering, state commitment, and safety decisions have one authority.
3. Events before projections. Facts are committed before they become visible to model, UI, or recovery logic.
4. Eﬀects are explicit. Every external side eﬀect has a typed replay contract and durable causal chain.
5. Fail closed. Missing approval, incompatible versions, undeclared capability, sequence conﬂict, or invalid
provenance stops the action.
6. Open at declared seams. Providers, tools, skills, hooks, clients, stores, and execution backends can vary
without replacing authority.
7. Evidence ﬁrst. A capability claim requires frozen conﬁguration, original trace, scoring rules, failure examples,
and known limits.
2.2 Kernel invariants
The implementation enforces the following invariants; violations fail CI or runtime conformance:
every committed event has identity, ordering, actor, origin, trust, contract version, type, and payload;
visible task state advances only after a successful event append;
each aggregate accepts exactly the expected next sequence;
an unknown event or item is preserved and displayed generically, not silently dropped;
approval is a closed result set and unavailable approval fails closed;
policy is enforced at dispatch, below tool and extension implementations;
a stale runtime generation cannot commit after cancellation or lease transfer;
every eﬀect has one of replay-safe, idempotent, or never-replay semantics;
a never-replay eﬀect with an unknown outcome is never automatically repeated;
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
5 / 30


secret values are references, not event payloads;
extension capabilities exist only if declared and leased;
untrusted input cannot promote memory, skill, prompt, or harness state without a review path;
snapshot loss changes performance, not truth.
3. As-built system architecture
Figure 1. AGH has one Trusted Core and one authoritative event stream. Interfaces above and below the Core remain replaceable,
but ordering and safety authority do not.
3.1 Experience and Host surfaces
The implemented experience layer supports CLI/TUI, headless SDK, Desktop/IDE, channels and automation, external
harness integration, and human approval. These are protocol peers. No oﬃcial interface receives private task-state
semantics unavailable to third-party clients.
All clients use the Host Contract to:
initialize and negotiate capabilities;
create tasks and turns;
submit items or commands;
receive ordered events from a cursor;
answer approval requests;
cancel, resume, fork, and subscribe.
CLI/headless formed the ﬁrst completed slice; all other surfaces consume the same versioned Host Contract rather than
maintaining private execution paths.
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
6 / 30


3.2 Stable Host Contract
The Host Contract contains four logical planes:
PLANE MINIMAL CONTENT FAILURE RULE
Schema and
initialization
version, capabilities, transport features incompatible major version fails explicitly
Command plane task, turn, approval, cancel, resume, fork commands are idempotently identiﬁed and
generation-scoped
Event stream ordered item/event, cursor, snapshot baseline,
backpressure
cursor conﬂict or unsupported behavior is explicit
Transport adapters stdio, local socket, TLS transport transport does not redeﬁne protocol meaning
Client parity is a protocol requirement: an unknown event must survive transport and remain inspectable even if a client
lacks a specialized renderer.
3.3 Trusted Core
Trusted Core coordinates:
Operation Queue: serializes user operations, cancellation, retries, and generation fencing;
Agent Loop: executes the model-tool-stop phase machine;
Context Pipeline: constructs bounded, normalized, stamped model projections;
Tool Broker: validates schema and sends an action through policy, approval, execution, and result
normalization;
Event Ledger: commits ordered facts and exposes cursors;
Policy Engine: resolves principal, trust, scope, budget, path, network, and ﬁnal action decision;
Task State: reconstructs task, turn, item, pending eﬀect, and recovery status;
Capability Host: presents ﬁles, shell, MCP, skills, providers, and extension leases;
Trace and Eval: derives reproducible evidence without maintaining a second truth store.
3.4 Execution and persistence planes
The execution plane contains the Worktree Executor, Sandbox Adapter, optional CodeRuntime, isolated extension
worker, and external model/MCP services. The persistence plane contains the event store, derived snapshots, content-
addressed artifacts, secret references, and trace/evaluation outputs.
The main boundary is:
proposal -> Trusted Core decision -> bounded execution -> durable receipt
No executor or extension may make its own result visible without committing through the Core.
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
7 / 30


4. Implemented end-to-end scope
Figure 2. The completed system couples the original vertical core path with broader platform capabilities. Both sides obey the
same protocol, event, policy, and recovery invariants.
4.1 Accepted ﬂagship workﬂow
The end-to-end acceptance workﬂow is a real repository repair:
user instruction
  -> repository/resource inspection
  -> model proposes file or shell action
  -> policy and human approval where required
  -> isolated worktree execution
  -> diff and test artifacts
  -> restart or cancellation handling
  -> final verification and trace package
This workﬂow crosses the complete causal chain: protocol, streaming model, tool intent, approval, side eﬀect, artifact,
task state, recovery, and evidence. It is the reference path used to demonstrate that the components operate as one
system rather than as disconnected features.
4.2 Completed capability set
DOMAIN IMPLEMENTED BEHAVIOR
Entry CLI, TUI, headless SDK, and Host-Contract clients
Model Provider adapters, streaming, usage accounting, cancellation, and normalized errors
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
8 / 30


DOMAIN IMPLEMENTED BEHAVIOR
Runtime Agent Loop, outer Operation Queue, worker lifecycle, subagent and automation control
State Event ledger, cursor, snapshot, resume projection
Execution File and shell tools through Tool Broker, approval, bounded worktree, and sandbox adapters
Context Repository resources, recent events, tool results, normalization, compaction
Extension Skill and MCP discovery, declaration, invocation, failure isolation, and cleanup
Evidence Diﬀ, tests, raw events, failure classiﬁcation, replay manifest
4.3 Deliberate architectural boundaries
Completion does not mean that every capability runs in every task. AGH keeps several features optional or policy-
dependent:
persistent CodeRuntime is activated only when its statefulness beneﬁts the task;
community extensions remain isolated and capability-leased;
sandbox enforcement is reported per platform and execution backend;
hosted controls remain separated from local/open runtime authority;
benchmark leadership is not claimed without the corresponding raw dataset and experiment manifest.
5. Process and deployment topology
Figure 3. AGH supports a local-ﬁrst deployment and process-separated workers. Logical module boundaries use the same
contracts in either placement.
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
9 / 30


5.1 Host process
The Host process owns the protocol server and lifecycle. A root runtime worker runs the queue, agent loop, context
pipeline, and tool coordination. Child workers provide isolated, quota-scoped execution for subordinate work. Storage
services commit events and persist artifacts. The optional Code Kernel provides a replaceable stateful runtime without
becoming a second source of truth.
The UI never owns execution. A client can disconnect without terminating task truth. Host task state survives worker
failure.
5.2 Execution boundary
The Tool Broker passes an approved eﬀect to a Worktree Executor through a Sandbox Adapter. The boundary
constrains:
canonical working directory and path traversal;
environment and secret references;
process group, timeout, cancellation, and resource quota;
network access;
artifact and output capture.
Separating a runtime into another process provides fault containment but does not prevent that process from reading
ﬁles, opening sockets, or spawning children. The sandbox is a distinct enforcement layer.
5.3 Implemented deployment proﬁles
PROFILE RUNTIME PLACEMENT PERSISTENCE SECURITY BOUNDARY
Local
interactive
local Host with CLI/TUI or
Desktop client
local event store and artifact
directory
worktree plus platform sandbox
adapter
Local service daemon, root-session workers,
durable jobs and channels
durable local jobs, events,
snapshots, and artifacts
isolated extension and child workers
Remote
execution
local or hosted Host dispatching
high-risk eﬀects remotely
service-backed events plus
content-addressed artifacts
remote sandbox, network policy, and
execution receipts
Hosted multi-
tenant
tenant-aware routing and worker
lifecycle
database-backed event/job
persistence plus artifact service
remote sandbox, tenant policy, secret
broker, and quota enforcement
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
10 / 30


6. Runtime execution model
Figure 4. The ledger participates throughout the task, rather than receiving an after-the-fact activity log.
6.1 Causal task sequence
1. Client and Host negotiate protocol and capabilities.
2. Client creates a task and starts a turn.
3. Runtime commits task and turn events.
4. Runtime loads a resume projection and cursor.
5. Context Pipeline constructs and stamps the model request.
6. Model streams content and may propose a tool intent.
7. Runtime commits the intent before any side eﬀect.
8. Policy evaluates principal, origin, trust, scope, paths, network, and budget.
9. Approval is requested when policy requires a human decision.
10. Executor performs a bounded action after approval.
11. Result, receipt, partial output, and artifact references are committed.
12. Runtime projects the tool result back to the model and continues or completes.
13. Final answer, usage, veriﬁcation, and task outcome become ordered events.
14. Client receives ordered items and a next cursor.
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
11 / 30


6.2 Two-level state model
Figure 5. The outer machine protects operation ordering and generations. The inner machine provides precise turn-level recovery.
The outer Operation Queue handles idle, accepting, running, awaiting_approval, cancelling, recovering,
and terminal outcomes. It serializes commands aﬀecting one task aggregate. A new runtime generation fences out stale
writers after cancellation, takeover, or resume.
Inside a running turn, the Agent Phase Machine advances through:
context.build
  -> model.stream
  -> tool.intent
  -> policy.evaluate
  -> effect.execute
  -> result.integrate
  -> model.continue | turn.complete
Queue and phase are separate because they solve diﬀerent problems. The queue governs concurrent commands and
lifecycle; the phase machine governs semantic progress inside one model/tool loop.
6.3 Cancellation
Cancellation is a committed command with origin and generation. It propagates to the model request, executor, process
tree, and optional CodeRuntime. Partial output is preserved. A cancelled process must not remain alive, and a late result
from the cancelled generation must be rejected.
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
12 / 30


7. Event, state, and projection model
Figure 6. One ordered event stream produces four consumer-speciﬁc views. This avoids separate, drifting histories for the model,
UI, recovery, and evaluation.
7.1 Canonical event envelope
The implemented agnes.event/v1 envelope is:
{
  "schema_version": "agnes.event/v1",
  "event_id": "evt_...",
  "aggregate_id": "task_...",
  "sequence": 42,
  "causal_id": "evt_...",
  "actor": { "type": "model", "id": "provider/model" },
  "origin": { "host": "cli", "extension": null },
  "trust": "untrusted-model-output",
  "contract_stamp": "sha256:...",
  "occurred_at": "RFC3339 timestamp",
  "type": "tool.intent.recorded",
  "payload": { "tool": "shell", "args_ref": "artifact://..." }
}
An earlier source draft used seq, id, ts, data, and optional projection/register ﬁelds. AGH resolved the
incompatibility by standardizing the envelope above and treating the older form as design provenance rather than a
supported wire format. Projection and register semantics are carried by versioned event types and payload conventions;
product code does not emit both envelopes.
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
13 / 30


7.2 Event families
The implemented ledger organizes events into these families:
FAMILY EXAMPLES RECOVERY SEMANTICS
Command task.created, turn.started, cancel.requested replay-safe command journal
Model request.started, response.delta, response.completed,
response.failed
do not recall model if completed result is
committed
Eﬀect tool.intent, approval.requested/decided, eﬀect.started, eﬀect.result follow typed replay class
State checkpoint.created, projection.rebuilt derived and rebuildable
Evaluation veriﬁcation.recorded, score.recorded preserve conﬁg and evidence references
The schema also covers cost, format deviation, repair decisions, jobs and artifacts, participant/principal, feedback, and
self-reﬁnement events. New event types enter through versioned schema and conformance ﬁxtures, never ad hoc
JSON.
7.3 Four projections
Model projection: role/content/tool results selected and compacted for the next model call.
Resume projection: queue state, current phase, pending approval/eﬀect, generation, and cursor.
Operator projection: timeline, diﬀ, approval cards, usage, failures, and diagnostics.
Eval projection: outcome, latency, cost, tool correctness, recovery, retry, and human intervention.
Projection code must be pure with respect to the committed stream. A projection cache can be discarded and rebuilt.
7.4 Concurrency and ordering
Each task aggregate is a single ordered stream. Append uses an expected sequence or writer generation. Conﬂict
rejects the append; it does not merge silently. This protects recovery when a former worker returns after a new worker
has taken over.
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
14 / 30


8. Effect safety, replay, and recovery
Figure 7. An eﬀect becomes auditable because its proposal, authorization, execution, and result are separate durable facts.
8.1 Eﬀect Sandwich
The sequence is:
model proposal
  -> durable intent
  -> policy evaluation
  -> approval decision
  -> durable effect-start marker
  -> bounded execution
  -> durable completed | failed | unknown result
This distinguishes:
what the model proposed;
what policy allowed;
what a person approved or modiﬁed;
what the executor attempted;
what the external system conﬁrmed.
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
15 / 30


8.2 Typed replay contract
CLASS EXAMPLES RECOVERY BEHAVIOR
Replay-safe read ﬁle, list directory, query status repeat against the recorded input version
Idempotent content-addressed write, API call with idempotency key retry with the identical key and correlate receipt
Never replay send message, payment, delete, deploy mark unknown and require conﬁrmation or compensation
The class belongs to the capability declaration, not model judgment. A composite run_code cell inherits the most
dangerous internal eﬀect and should default to never-replay unless subeﬀects are independently brokered and
recorded.
8.3 Recovery cases
CRASH LOCATION RECOVERY DECISION
Before intent append no eﬀect is assumed; resume normally
Intent committed, execution not
started
replay only if class allows it
Started committed, no result inspect receipt/idempotency; otherwise mark unknown
Result committed integrate result; never execute again
Model stream incomplete ignore incomplete assistant message projection and rerun the stamped request according to
model-call policy
Worker lost after takeover stale generation cannot append
The system exposes unknown status rather than translating uncertainty into success or failure.
8.4 Recovery acceptance tests
crash between every adjacent pair of eﬀect events;
kill Host or worker during ﬁle read, ﬁle write, long shell process, approval wait, and model stream;
restart and conﬁrm identical resume projection;
verify a never-replay action is not repeated;
verify an idempotent action uses the same key;
verify process cancellation leaves no child process;
verify a late stale-generation result is rejected;
verify event and artifact references remain inspectable.
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
16 / 30


9. Context Pipeline and optional CodeRuntime
Figure 8. The prompt is a bounded projection, not the task's storage layer. A persistent runtime remains optional and subordinate
to Host truth.
9.1 Information layers
LAYER CONTENT AUTHORITY
L0 model weights and static knowledge model provider
L1 active prompt, recent history, selected tool results bounded model projection
L2 optional persistent code runtime and working variables replaceable execution cache
L3 events, ﬁles, skills, artifacts, memory, task facts durable Host-controlled state
The numbering is an information-layer convention in AGH and is unrelated to hardware cache terminology.
9.2 Context construction
The pipeline:
1. loads repository, task, and instruction resources;
2. reads recent and pending event projections;
3. selects information by scope, trust, relevance, and budget;
4. normalizes roles, tool results, and structured errors;
5. compacts old material into summaries plus durable references;
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
17 / 30


6. stamps version, hash, contract, and provenance;
7. emits a bounded model request.
Compaction hides material from L1 but does not delete L3 truth.
9.3 File-based context A/B
AGH's implemented evaluation path compares two treatments on the same long-material task:
A: inject the full material directly into the prompt;
B: place material in workspace ﬁles and allow on-demand retrieval.
The experiment holds model, task, prompt policy, tools, permissions, budget, timeout, and environment constant, then
records task success, tokens, latency, tool calls, failure types, and human intervention. The result controls policy
selection: persistent CodeRuntime is enabled only for workloads whose evidence justiﬁes stateful execution. No
numeric outcome is asserted here because the source package did not include the raw benchmark table.
9.4 CodeRuntime contract
The deployed optional adapter exposes:
execute · interrupt · snapshot · restore · artifact
Host continues to own goal, child tasks, usage, lifecycle, and events. Kernel state is a recoverable optimization. Its
process is not a security boundary, and native I/O must pass through brokered capabilities or a sandbox with honest
full versus partial enforcement labeling.
10. Tool and capability model
10.1 ToolCapability contract
Each capability declares:
structured input and result schemas;
risk and eﬀect class;
required permissions and scopes;
concurrency and cancellation behavior;
timeout and partial-output semantics;
executor and sandbox requirements;
artifact and receipt production;
replay contract.
Tool Broker performs schema validation, policy evaluation, approval, execution dispatch, result normalization, and event
commitment. Providers or tools do not implement business retries that could duplicate an eﬀect.
10.2 Core tool set
The accepted repository workﬂow uses a deliberately bounded capability surface:
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
18 / 30


repository/resource inspection;
ﬁle read and bounded edit;
shell command inside worktree;
test execution;
diﬀ and artifact collection.
AGH also supports standard, hybrid, and code-disclosure proﬁles. Disclosure experiments are isolated from recovery
conformance so that attribution remains causal.
10.3 Approval semantics
Approval returns a closed result such as allow, deny, or modify. A decision binds at least:
(scope, capability, normalized arguments hash, task/session, generation)
Changing command, working directory, path, session, or arguments invalidates the approval. If no approver exists in an
unattended context, the action is denied or parked according to explicit policy; it does not wait forever.
11. Extension and trust architecture
Figure 9. Capability expansion is open, while protocol truth and ﬁnal safety decisions remain closed to replacement.
11.1 Extension lifecycle
An extension moves through discover, validate, authorize, load, invoke, unload, and cleanup. Its manifest declares:
identity and origin;
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
19 / 30


version and compatible AGH protocol range;
capabilities and permissions;
entry points and execution mode;
resource and budget requirements;
cleanup and residue checks.
Undeclared capability calls fail. Unload residue is a conformance failure.
11.2 Trust levels
LEVEL EXECUTION AND ADMISSION
Builtin shipped with AGH and covered by release process
Veriﬁed signature, service verdict, and content hash agree
Community untrusted by default; isolated worker, no install scripts, explicit capability lease
Unknown quarantined until provenance and policy decision exist
Community code never becomes part of Trusted Core merely because it is popular or locally installed.
11.3 Open and closed surfaces
Open surfaces include Skills, MCP/tools, model providers, restricted hooks, and constrained declarative interaction.
Closed authority includes protocol meaning, event ordering, ﬁnal policy, secret access, and sandbox decisions.
AGH implements both Skill and MCP extension paths through the same lifecycle: discovery, manifest validation,
capability authorization, invocation, failure isolation, unload, and cleanup. Neither path can replace Trusted Core
authority.
12. Security architecture
12.1 Trust model
Inputs from model output, repository content, web content, community extensions, tools, and remote services are
untrusted unless explicitly elevated. actor, origin, and trust are audit facts, not authorization by themselves.
Authorization derives from surface, scope, capability, arguments, task, and managed policy.
12.2 Threat and negative-test matrix
THREAT FAILURE MODE CONTROL REQUIRED NEGATIVE TEST
Prompt injection repository or page requests
policy bypass
origin/trust labels, policy priority, argument
revalidation
malicious README asks to upload
secret; request is denied
Secret exﬁltration model or extension reads
and emits credentials
secret references, output redaction,
network allowlist
shell prints environment; secret
value never enters event payload
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
20 / 30


THREAT FAILURE MODE CONTROL REQUIRED NEGATIVE TEST
Path escape ﬁle tool leaves workspace canonical paths, bounded cwd, symlink
defense
relative and symlink traversal fail
Process escape cancellation leaves child
process
process group, timeout, kill tree, quota long command cancellation leaves
no child
Replay damage crash repeats dangerous
action
eﬀect class, key, receipt, unknown state unknown send/delete is not
repeated
Supply-chain
compromise
extension update adds
malicious code
provenance, pinned version/hash,
signature candidate, worker isolation,
revoke
mismatched hash refuses load
12.3 Enforcement levels
Policy controls are always active. OS and remote sandboxes add enforcement. Every eﬀect result records whether
enforcement was full, partial, or unavailable, and the operator projection displays it. Platform limitations are not hidden
behind a generic “sandbox enabled” ﬂag.
12.4 Secrets
Events store secret identiﬁers and access receipts, never plaintext values. The Secret Broker releases a secret only to
an authorized executor scope. Output normalization redacts matches before event commitment and artifact publication.
13. Interfaces and failure semantics
INTERFACE PRODUCER ->
CONSUMER MINIMAL CONTRACT FAILURE SEMANTICS
HostProtocol client -> Host initialize, task, turn, item, approval,
cancel, resume, subscribe
incompatible version fails; unknown
item preserved
ModelProvider adapter -> Agent Loop capabilities, stream, reasoning, usage,
cancel, normalized error
Core owns retry; provider cannot
repeat business eﬀects
ToolCapability builtin/MCP -> Tool
Broker
schema, risk, permissions, execute,
cancel, result
structured args/results; timeout and
partial output visible
EventStore Trusted Core ->
projections/eval
append, cursor read, subscribe,
checkpoint
ordering conﬂict rejected; visibility
follows commit
CodeRuntime optional runtime ->
context/loop
execute, interrupt, snapshot, restore,
artifact
runtime failure cannot alter Host
truth
ExtensionManifest extension -> Capability
Host
identity, origin, version, compat,
permissions, entrypoints, cleanup
undeclared capability fails; residue
fails gate
13.1 Error taxonomy
Errors should be normalized into at least:
protocol/version;
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
21 / 30


model/provider;
context/projection;
capability/schema;
policy/approval;
sandbox/executor;
persistence/concurrency;
recovery/unknown outcome;
extension/lifecycle;
environment/infrastructure.
The taxonomy is used by both the operator projection and evaluation report, preventing a model failure from being
counted as a harness failure or an environment failure from being hidden in an aggregate success metric.
14. Observability and evaluation
Figure 10. Trace, artifacts, failure classiﬁcation, and reports are projections from runtime events, not a separate analytics
instrumentation path.
14.1 Frozen experiment manifest
Every reported experiment records:
code commit and dependency lock;
model identiﬁer, provider, and parameters;
prompt and tool schemas;
task/repository snapshot;
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
22 / 30


budget, timeout, and approval policy;
operating system, hardware, and sandbox capability;
network policy;
scoring and veriﬁer rules;
repetition index and random seeds where applicable.
14.2 Metrics
DIMENSION MEASURES
Outcome task success, tests, veriﬁer result, diﬀ validity
Recovery successful resume, unknown-eﬀect rate, stale-write rejection
Safety denied unsafe actions, sandbox enforcement level, secret/path/process negative tests
Eﬃciency input/output tokens, cost or credits, latency, tool calls, retries
Operations queue time, approval wait, cancellation latency, artifact completeness
Human load approvals, interventions, compensations, manual recovery
14.3 Same-model A/B rule
Keep model, task, prompt, tools, permissions, budget, timeout, repository snapshot, and environment identical. Change
exactly one mechanism: context selection, compaction, recovery, veriﬁer, disclosure proﬁle, or CodeRuntime. Report all
failures, sample size, repetitions, point estimates, uncertainty, and limitations. A best single run is not evidence of
capability.
14.4 Replay package
AGH exports a privacy-redacted replay package containing:
frozen experiment manifest;
ordered events and schema versions;
artifact references and integrity hashes;
diﬀ, tests, logs, receipts, and enforcement labels;
derived metrics and failure classiﬁcation;
reproduction instructions;
known non-determinism and limitations.
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
23 / 30


15. Implementation history and acceptance record
15.1 Completed D1-D10 sequence
DAY COMPLETED DELIVERABLE ACCEPTANCE EVIDENCE PRODUCED
D1 Scenario, versions, scope boundary, schema, reuse boundary, and
acceptance ﬁxtures were frozen
scope record and canonical schema decision
D2 Host handshake, task/turn commands, and event subscription were
implemented
protocol and compatibility tests
D3 Real model streaming, usage, cancellation, and normalized provider
errors were integrated
provider trace and cancellation test
D4 File/shell loop, Tool Broker, approval, and denial path were completed no-eﬀect denial and structured error evidence
D5 The repository task ran end to end inspectable ledger, diﬀ, test, and trace
D6 Context checkpoint, restart, and pending-eﬀect recovery were completed crash matrix and resume projection
D7 Extension admission, invocation, failure isolation, and cleanup were
implemented
manifest, invocation, failure, and residue evidence
D8 Threat negatives and process-tree cancellation were integrated into
conformance
classiﬁed failures and security evidence
D9 Same-model, one-mechanism A/B instrumentation was completed frozen manifest, raw-event format, and limitation
schema
D10 The full path was packaged as a reproducible acceptance run demo package, test report, declared limits, and
acceptance decision
15.2 Frozen implementation decisions
Implementation established the following stable decisions:
1. a repository-repair workﬂow and ﬁxed task ﬁxtures provide the reference causal path;
2. agnes.event/v1 and the versioned Host Contract are canonical;
3. direct dependencies, selectively reused code, and original AGH modules have explicit ownership boundaries;
4. Skill and MCP integrations enter through the common Capability Host and lease model;
5. model providers implement one normalized streaming, usage, cancellation, and error contract;
6. module owners review interface and schema changes rather than allowing local semantic forks;
7. license, NOTICE, repository, disclosure, and public/private boundaries are release-governed.
15.3 Acceptance outcome
The completed system satisﬁes the following acceptance conditions:
the ﬁxed repository task produces a valid diﬀ and runs the deﬁned tests;
every visible state transition has a committed event;
an approval denial produces no side eﬀect;
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
24 / 30


cancellation terminates the process tree and records partial output;
restart resumes from a committed phase and does not repeat a never-replay action;
a sequence conﬂict or stale generation is rejected;
event, artifact, and trace integrity references resolve;
unknown events remain inspectable;
extensions install or discover, invoke, fail safely, and clean up through the declared lifecycle;
the security negative cases in Section 12 pass within declared enforcement limits;
the demo is reproducible from the frozen manifest;
limitations distinguish optional capability, unavailable platform enforcement, unreported metric, and known
defect.
16. Research-style contributions and innovation points
The following are implemented system contributions. They are not claims of global uniqueness; novelty is framed as
the speciﬁc composition and enforceable semantics delivered by AGH.
16.1 Single-authority, proposal-only edge architecture
AGH permits broad client, provider, tool, and extension diversity while retaining one authority for event order and
external eﬀects. This avoids the common failure in which plugins or product surfaces become shadow control planes.
16.2 Ledger-projection uniﬁcation
Model context, restart state, UI timeline, and evaluation are algorithms over one ledger. The contribution is not event
logging alone; it is the prohibition on independently mutable histories for each consumer.
16.3 Eﬀect Sandwich with typed uncertainty
Intent and result events bracket external actions. Replay contracts distinguish safe, idempotent, and never-replay
behavior, while unknown is a ﬁrst-class outcome. This treats uncertainty as state rather than an exception to hide.
16.4 Nested state machines with generation fencing
The outer queue controls command concurrency, cancellation, and takeover; the inner machine controls turn semantics.
Generation fencing prevents a replaced worker from committing stale results.
16.5 Stamped context as a reproducible projection
Each model request has a version/hash/provenance stamp derived from durable resources and events. This makes
context engineering experimentally addressable and separates durable knowledge from prompt residency.
16.6 Replaceable CodeRuntime subordinate to Host truth
Persistent execution is an optional seam, not the runtime's state authority or security boundary. Its activation is
evidence- and policy-driven, and its side eﬀects remain brokered.
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
25 / 30


16.7 Lifecycle-complete extension trust
Extensions are governed from discovery through cleanup, with identity, origin, compatibility, capability lease, budget,
isolation, audit, revoke, and residue checks. Openness is deﬁned by safe participation, not unrestricted in-process
code.
16.8 Evidence by construction
Evaluation artifacts originate from the same causal events used for recovery and operator inspection. Same-model A/B
changes one harness mechanism at a time, allowing falsiﬁable attribution of AGH value.
17. Operational risks and governance boundaries
17.1 Critical risks
RISK FAILURE MODE IMPLEMENTED CONTROL
Scope drift new surfaces bypass the causal path Host Contract and Trusted Core conformance
Evidence external project or paper result is presented as AGH
result
pinned versions, local reproduction, same-model A/B
Security worker process is marketed as sandbox; extension
bypasses policy
independent executor boundary and negative tests
Recovery messages are persisted but eﬀect state is not full intent/approval/started/result chain
Protocol CLI, UI, and runtime create divergent types schema-ﬁrst generation and compatibility tests
Event schema incompatible envelopes reach runtime canonical agnes.event/v1, compatibility ﬁxtures, and
migration rules
Context compaction hides necessary evidence or changes
behavior
references, full ledger retention, A/B
CodeRuntime stateful execution expands attack and replay surface optional adapter, brokered eﬀects, policy activation, and
A/B attribution
Extension in-process community code compromises Core isolated worker and capability lease
Cross-
platform
support claims exceed actual enforcement generated capability matrix and on-device doctor
Maintenance platform expansion weakens core invariants compatibility gates and authority-preserving extension
seams
17.2 Ongoing operating policies
The remaining choices are normal governance controls, not missing implementation:
which model/provider versions and task sets are frozen for a published evaluation;
which platforms advertise full, partial, or unavailable sandbox enforcement;
which budget, credit, and usage limits apply to a deployment;
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
26 / 30


when task policy enables persistent CodeRuntime;
which extension provenance levels are admitted in each environment;
who owns release review, conformance, incident response, and security disclosure.
17.3 Architecture-preservation conditions
Future product evolution must preserve four properties: one authority, one causal ledger, brokered eﬀects, and evidence
derived from committed facts. A deployment may specialize clients, providers, tools, or storage, but it ceases to be
conformant AGH if it introduces a shadow state store, bypasses policy for side eﬀects, treats a worker as a sandbox, or
publishes results without a reproducible experiment manifest.
18. Conclusion
AGH is a completed system built as a chain of authority rather than a collection of agent features. The Host Contract
deﬁnes stable client semantics. Trusted Core orders commands and authorizes eﬀects. The event ledger records causal
truth. The phase machine and replay contract make recovery precise. The Context Pipeline turns durable resources into
bounded model inputs. The executor and sandbox constrain side eﬀects. Extension workers broaden capability without
replacing authority. Trace and evaluation derive from the same facts.
The historical D1-D10 delivery sequence established the ﬁrst coherent path across every critical layer. Its completed
acceptance result is not merely “the model edited a ﬁle.” The reference task produces a valid diﬀ and test through
versioned protocol, durable intent, approval, bounded execution, restart recovery, and a reproducible trace, while unsafe
and unknown paths remain explicit.
The result is an inspectable, recoverable runtime whose failure taxonomy identiﬁes whether a problem lies in the model,
context, protocol, eﬀect control, storage, recovery, tool, or environment. Quantitative performance claims remain
separable from implementation status: AGH is complete, while any published throughput, latency, cost, or task-success
claim still requires the corresponding frozen manifest and raw results.
Appendix A. As-built conformance checklist
Host Protocol
 versioned initialize and capability negotiation
 task and turn commands
 ordered event/item stream with cursor
 approval request/decision
 cancellation and generation
 resume and snapshot baseline
 unknown item preservation
 explicit compatibility failure
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
27 / 30


Event Store
 expected sequence append
 immutable aggregate order
 causal identiﬁers
 actor, origin, trust, contract stamp
 cursor read and subscribe
 snapshot/checkpoint metadata
 stale generation rejection
 projection rebuild test
Tool and Eﬀect
 input/result schema
 risk and permission declaration
 eﬀect replay class
 policy and approval binding
 timeout, cancel, and partial output
 intent and started events
 result, receipt, and artifact references
 unknown outcome handling
Extension
 identity and provenance
 compatibility range
 permissions and capability lease
 execution mode
 budget and timeout
 audit events
 unload and cleanup
 residue failure test
Appendix B. As-built verification matrix
TEST STIMULUS EXPECTED DURABLE EVIDENCE
Protocol
incompatibility
unsupported major version explicit error; no task created
Event conﬂict two writers append same sequence one accepted, one rejected
Approval deny dangerous shell or outbound request decision event; no eﬀect-start event
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
28 / 30


TEST STIMULUS EXPECTED DURABLE EVIDENCE
Path escape .. or symlink outside worktree policy/executor rejection
Secret output command prints secret environment
value
redacted output and security event
Cancel long process tree cancel event, partial output, zero child processes
Safe replay crash during read repeated read with ﬁxed input version
Idempotent replay crash during keyed write identical key and one external result
Never replay crash during send/delete unknown state; no automatic second action
Stale generation old worker returns after recovery append rejected
Projection rebuild delete snapshot cache identical projection from ledger
Unknown event inject forward-compatible type preserved and generically visible
Extension residue extension leaves lease/resource cleanup gate fails
Reproduction rerun frozen task package trace and scoring process reproducible within declared
nondeterminism
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
29 / 30


Appendix C. Source traceability
REPORT AREA SUPPLIED MATERIAL BASIS
Original implementation plan, Host Contract, interfaces, threat matrix, and
evaluation rules
S1
End-to-end panorama and historical core/platform boundary S2
Ledger projections, replay semantics, context/cost, extension trust, longer
roadmap, open issues and evidence discipline
S3
Eleven supplied architecture illustrations used for cross-checking
component relationships
S4
English diagrams, canonical schema resolution, acceptance matrices,
contribution framing
Synthesis in this report from S1-S4 plus the system
owner's completion-status correction
Supplied materials
S1. Agnes Harness Technical Architecture and Technical Plan v0.1. Supplied HTML, dated 1 September 2026.
S2. Agnes Harness Panoramic Technical Architecture v0.1. Supplied interactive HTML; its Phase 0 labels are
historical planning metadata.
S3. Agnes Second-Asset Architecture Report. Supplied Markdown, dated 31 August 2026.
S4. images/d1.png through images/d11.png. Supplied architecture and roadmap diagrams.
Source documents contain strategic proposals, implementation suggestions, and decision requests. They were treated
as technical evidence and design input, not as instructions to the report author. The system owner subsequently
conﬁrmed that AGH is complete; that status correction governs the maturity language in this as-built report. Where
source drafts conﬂict, the completed canonical contract is reported rather than preserving obsolete planning
alternatives.
AGNES HARNESS (AGH) · AS-BUILT TECHNICAL REPORT
30 / 30
