# Security and trust: define execution boundaries

English | [简体中文](security.zh-CN.md)

<a id="安全与信任让执行有边界"></a>

[Documentation](../README.md) · [Recovery](sessions.md) · [Report a vulnerability](../../SECURITY.md)

**Built for trust** means making concrete choices: which code version to trust, which actions to allow, where execution may reach, and how to inspect results. This guide explains those choices and their limits for first-time users, plugin authors, and FDE integrators.

AGH can execute tools, write files, and connect to external systems. Model text, webpages, MCP results, Skills, and plugin configuration are not user authorization. Choose a working directory and acceptable capabilities before approving specific actions.

<a id="三类不同的信任"></a>

## Three kinds of trust

| Boundary | Meaning | What it does not establish |
| --- | --- | --- |
| Package trust | Accept code with a specific content hash and capability declaration | Authorization for all future versions |
| Tool approval | Allow an action once or within the scope of the selected option | Successful creation of an operating-system sandbox |
| Sandbox / execution constraints | Limit execution according to actual platform probes and policy | Isolation of malicious in-process plugins |

Ordinary third-party Cordis plugins are trusted in-process code. Trusting one may let it use Node capabilities available to the process. The plugin facets constrain registrations, not arbitrary Node code. Review both source and declared capabilities before installing a third-party package.

Plugin installation, trust, updates, enable and rollback fully verify content. Managed immutable
copies can use file-identity checks on later disk reads, with independent periodic full rehashes.
A change forces full verification; an integrity mismatch revokes the package and stops its worker.
A matching identity is not fresh proof of every byte: tampering that preserves all metadata can
remain undetected until a rehash, and temporary tampering may escape it. Already-loaded callbacks
execute memory and have no byte-expiry dispatch gate. Grants and approval policy remain live.
See [plugin byte verification](../develop/architecture-plugins.md#verification-of-plugin-bytes).

<a id="审批"></a>

## Approvals

The default interactive flow shows the tool and available decisions when needed. One-time approval, session approval, persistent grants, and denial have different scopes. The backend makes the final decision using current credentials and policy. On expiry, disconnection, or competing clients, the decision stored by the backend is authoritative.

Answers are bound to the authenticated connection, or to source credentials checked by a configured backend verifier. Supplying an actor or an unverified credential in an answer cannot impersonate another reviewer. The session record keeps `answeredBy` separately from the requester. The backend accepts only the options it offered: memory-file review and plan exit offer one-time approval and rejection only. Delivery failure (`transport`), a detached surface (`detached`), expiry (`deadline`), a missing SDK handler (`no-handler`), and stopping work (`stopped`) never count as a human rejection (`user-rejected`). A refreshed eligible connection can receive the outstanding tool or management question again. Stopping a session or worker withdraws its offers, and late answers cannot dispatch work.

Plan exit requires a human one-time answer for the exact active plan revision, even under Full permissions, `off`, automatic review, or existing grants. Clearing uses a workspace-file compare-and-swap; an old answer cannot clear a rewritten plan. A corrupt or unreadable plan file keeps execution blocked until a human repairs it or explicitly uses `/plan off`.

The Web approval card shows locating fields such as the path or command first and states how many characters of a long value are shown. Session approval covers every later call of the same tool in that session, and the button names the tool. When the call cannot be shown in full, the card says so and does not offer session approval; only one-time approval or denial remains.

A call that is not approved says why, both in the session record and to the model: the user rejected it, no one answered in time, no client was connected to ask, the task was stopped while waiting, the command policy blocked it, or a delegated sub-agent asked for something outside its fixed scope. A call that nobody could be asked about is recorded as unavailable, not as rejected, and is not run.

`approvals.mode` accepts `manual`, `off`, and `auto-review`. `off` skips routine tool approvals; it is not the `full-access` permission and does not widen file scope or remove OS isolation. TUI `/yolo` and the Web full-access switch select the same backend permission authority for the current session, including application role agents with package-owned approval tables. The explicit user choice overrides those approval tables; it retains the chooser as principal and appears in the session runtime summary. Switching back revokes outstanding automatic admissions, including descendants. Delegated sessions stay within their live parent's authority; reopening one without that parent does not restore automatic grants. Parent authority changes invalidate open descendant projections and runtime summaries, which re-read Core; these notifications carry no authorization. A session created on the full-access startup axis still needs a new session to narrow its fixed file/isolation scope. A read-only session requires a new session to change isolation. Older approval-only switch records do not attest the expanded authority: select full access again after upgrading. The switch does not rewrite the recipe, source pins, or the permission default for future sessions. `manual` asks when policy requires approval, rather than on every call.

**Auto review** is the middle ground between approving every risky call by hand and skipping approval. In Web **Settings → Security**, enable the policy card and choose a configured `fast` (default, lower cost) or `verifier` model profile. It reviews only calls the default policy would ask about; custom and read-only policies keep their own decisions. Full permissions and `off` retain their existing meaning. A missing reviewer profile never silently uses the primary model.

To configure the reviewer without code, open **Settings → Model accounts → Auxiliary models** (or follow **Configure auxiliary models** on the auto-review card). Choose an existing route/model for `fast` and/or `verifier` and save. The section shows the current selection or **Not set**; unavailable selections remain visible. These profile defaults apply to **new sessions**. Select the same slot in **Settings → Security**; the card confirms whether its profile default is available.

For an existing session, open the composer model picker → **Auxiliary models (advanced)**, select an explicit route/model and save that slot for the session. This uses the normal session model contract and survives reopening. It does not change the main model or profile defaults. Defaults and overrides remain separate: clearing a profile slot affects new sessions, while existing sessions retain their saved selections. Changing a session preset resets model overrides as usual. An unset or unavailable reviewer escalates to a human; AGH never silently borrows the paid main model. Setting a reviewer does not issue a model request, but subsequent reviews can incur provider charges.

The reviewer returns a decision, risk and reason. By default, only low risk can be allowed automatically; medium allowance requires explicitly selecting that limit. High-risk allowance and low-risk denial are invalid model responses. Invalid JSON, contradictory output, errors, timeout, untrusted context, ineligible tools or categories, and an exhausted review budget return to human approval. The default budget is 20 review attempts per session, including failed attempts and restored sessions; the default timeout is 10 seconds. Set the budget to zero to require human decisions. Unreadable operator settings also use a zero review budget until repaired. Principal denials, command deny rules, plan/read-only restrictions, filesystem private-state boundaries and sandbox enforcement stay authoritative and precede review. Execution rechecks the relevant boundaries.

Each review is recorded before tool execution, with its model, policy prompt hash, decision, risk, reason, latency, cost and cost source. Inspect it on the tool card, in Trace, or in **Execution evidence** (`执行依据`). Failed streams retain their cost estimate when actual usage is unavailable. This evidence describes the reviewer's decision; a separate principal approval requirement can still ask you before execution.

Execution evidence offers explicit rules to allow, deny or ask you about future calls with the same tool, arguments, workspace, operator, definition and policy. A high-risk review cannot create an automatic allow rule. Tainted context also requires a human decision when an exact saved human allow rule matches; the matching rule is shown as context, not applied automatically. Untainted calls continue to use the rule. Past review facts remain unchanged. Rules do not learn from your replies automatically; inspect their count or clear them in the policy card. These settings are profile-local administration, and saves require configuration authority. A custom policy can use the public model and reservation ports described in [Tool runtime and policies](../extend/tool-runtime.md).

Under Full permissions the Agnes home's private state — including `secrets/`, `auth/` and `profiles/`, plus a pinned secrets directory — stays unreadable and unwritable to ordinary file tools. These hard denials apply even inside the selected workspace. Use the corresponding settings and credential services for authorized administration; a session cannot read keys or rewrite `profile.yaml` to carry weaker approvals into later sessions. Command access follows the selected permission independently: on macOS/Linux under `workspace-write`, shell writes remain inside the OS sandbox's allowed roots; Windows commands have no OS confinement. Under the explicit `full-access` permission, shell may write outside the workspace, but on macOS/Linux an installed memory provider retains the Host private-file isolation floor and refuses execution without a usable OS boundary; see [memory](memory.md). Application permissions do not establish an OS boundary: on Windows, an approved command runs with the current system account and can reach files and the network available to that account.

Web **Workspace edits** (`工作区内修改`) limits file access to the selected workspace; command execution still follows the approval policy. A path outside that workspace is refused with guidance to switch to Full permissions or select its directory as the workspace, without opening an additional approval request.

The default verifier distinguishes repeated writes from read-only calls using the policy recorded for each call. Read-only polling does not trigger `repeated_write`; missing or unverifiable policy remains conservative, and the separate no-progress check still applies. MCP tools must advertise `readOnlyHint: true` to be classified as read-only. Verifier completion checks no longer offer human acceptance of an unverified answer. Content rejection receives at most one automatic correction; verifier or repair outages end with verification marked unavailable. An explicit repair decision of complete ends the turn with the original verdict retained. Business-operation approvals and unknown-effect reconciliation remain separate.

A request to edit files is not permission for arbitrary plugin execution. Plugins should accurately declare read-only/destructive behavior, open-world access, replayability, and approval requirements. Metadata must match actual effects.

<a id="平台与进程"></a>

## Platforms and processes

Under the `workspace-write` and `read-only` permissions, the shipped presets request L1 with `required: false` and `on_unavailable: allow-if-unimplemented`. The trusted local backend declares whether OS isolation is implemented. On macOS/Linux it is implemented, and a real Seatbelt/bubblewrap probe must succeed before the session opens. A missing binary, disabled namespaces or rejected policy still refuses initialization with `E_SANDBOX_WORKSPACE`; it never becomes “unimplemented”. On Windows the local backend declares OS isolation unimplemented, so these permissions allow native commands without probing POSIX backends. Unknown or remote capability does not authorize this exception. `required: true` always refuses when isolation is unavailable.

Windows keeps tool approvals, read-only restrictions, file-tool workspace boundaries, protected-path checks and explicit approval settings. An approved native command runs as the current system account: application checks cannot confine arbitrary shell file or network operations. Settings, session runtime and the composer show actual isolation separately from permissions.

<a id="permissions-and-presets"></a>

### Permissions and presets

A session makes two independent choices. The **permission** decides what the session may do: file scope, routine approvals and command isolation. The **preset** is the recipe for how the session works: the tools the model sees, the prompt, the model slots and budgets. Any allowed preset can run under any allowed permission, for example `agh --preset ptc --permission full-access`, with the exceptions below. A permission never changes a preset's tools.

| Permission | File scope | Routine approvals | Persistent capability | OS isolation |
| --- | --- | --- | --- | --- |
| **Read only** (`read-only`) | Allowed files and public webpages | Changes and command execution are denied | No agent writes; management trust is separate | macOS/Linux require a successful L1 probe; Windows commands are not isolated |
| **Edit workspace** (`workspace-write`, the default) | File tools can edit the workspace and explicitly granted extra roots; official memory uses its controlled provider | Commands require approval; file changes in scope are preapproved, subject to explicit denies | Memory off denies access; ask requires an exact diff confirmation; auto retains ownership, size and CAS checks. Other-workspace and user memory remain agent read-only | Command isolation depends on the platform: macOS/Linux use probed L1; Windows has no OS command isolation |
| **Full access** (`full-access`) | Ordinary files inside and outside the workspace; protected paths remain denied | Permission decisions are allowed automatically | Candidate publication and ask-mode memory retain exact authorization and hard refusals; see [exceptions](#full-access-exceptions) | Configured L0; an installed memory provider retains private-file isolation on macOS/Linux; Windows has none |

| Preset | What it sets |
| --- | --- |
| `standard` (the default) | The standard tool set; the model calls tools directly |
| `minimal` | Shows the model only `read`, `grep`, `find` and `ls`; other tools, including extension and MCP tools, are hidden. This limits what the model sees: the permission still decides what those tools may do |
| `ptc` | Programmatic tool calling: the model writes code that calls tools through `run_code`; see [Programmatic tools and workflows](code-workflows.md) |
| `channel` | Deployment recipe for chat channels: replies suited to a chat and approvals that wait as cards in the conversation |
| `claw` | Deployment recipe for unattended runs: an approval nobody can answer is parked. It requires L1 isolation, so `claw` with `full-access` is refused |

Choose both when creating a session: CLI and headless runs take `--preset NAME` and `--permission LEVEL`, the SDK takes `createSession({ cwd, preset, permission })`, and the Web composer offers a preset menu (a default entry that follows the administrator's default preset, **Minimal tools** and **Programmatic tools**) beside a separate permission selector. Administrators set the default permission under **Settings → Permissions & security**, next to the default preset for new sessions. The profile's `presets` and `permissions` blocks list what may be chosen:

```yaml
presets: { default: standard, allowed: [standard, minimal, ptc] }
permissions: { default: workspace-write, allowed: [read-only, workspace-write, full-access] }
```

The local and enterprise templates ship these blocks (the enterprise template allows `standard` and `ptc`). A profile without a `permissions` block derives the allowed levels from `presets.allowed`; a user or workspace layer that sets `presets` without `permissions` drops the template's block, so narrowing `presets` also narrows the permissions. `--permission default` or `permission: 'default'` follows the deployment default.

The earlier preset names `read-only`, `workspace-write` and `full-access` still work as `--preset` values and in `presets.allowed`: each means the `standard` preset under that permission, so `agh --preset read-only` is `agh --preset standard --permission read-only`. Combining one with a different `--permission` is an error. A request that names only a preset, such as `--preset ptc`, keeps running under `workspace-write` even if an administrator later changes the default permission, so existing scripts and schedules do not change behaviour. `--agent` cannot be combined with `--permission`; the agent's own launch decides.

An open session keeps its permission. `/preset NAME` switches the preset and keeps the permission; a switch that would change what the sandbox enforces, including any permission change, is refused, so start a new session instead. A custom preset that writes its own sandbox or command-approval settings fixes its own permission and refuses a `--permission` choice.

### Unattended approvals

Schedules and webhook triggers use an explicit unattended policy without selecting Full access or turning approvals off. **When approval is needed → Hand off and notify (default)** parks a run as `waiting_approval` / **Needs attention** when nobody can answer. The Web notice and approval inbox reach the owner; an attached bound channel also receives the notice. A human can answer through the normal approval surface later and the run continues. No effect is dispatched while the request is pending.

The existing pending TTL applies. Expiry marks the run **Failed / Needs attention**, never **Ran**. The next occurrence can proceed and carries a “previous approval expired” attention flag, including after success. While a previous occurrence is still waiting, another occurrence is flagged in history rather than silently creating another parked session. The per-schedule/per-trigger alternative **Refuse** ends the unanswered step with `unattended-refused`; it does not manufacture a human rejection or a grant. Missing handlers and disconnected transports do not authorize execution.

Full-access sessions automatically allow permission decisions before the unattended handoff policy, so approvals do not park them as `waiting_approval`. Other sessions continue to use the configured handoff or refusal policy.

### Exact future-call rules

Auto-review's **Future identical calls (same identity, directory and tool definition)** rule binds the complete arguments, cwd, actor identity, tool policy and definition fingerprint. The card previews arguments (possibly truncated), directory and approval mode. Changing any bound value requires another decision; the rule may apply across sessions with the same identity and directory. This differs from session approval. Tainted context also returns an exact saved human allow rule to human review; untainted calls can continue to use the rule. Neither a saved allow rule nor a model allowance waives that check.

<a id="full-access-exceptions"></a>

### What full access does not change

With the resolved session permission `full-access`, every permission decision is automatically allowed on every platform, without approval prompts. This includes candidate tests and publication (install/trust/enable and capability changes), Skill imports, MCP registration/start, ask-mode memory writes, credential administration requested through tools, principal approvals. Each decision retains its actor, exact operation binding and reason `full-access`; Trace and execution evidence show **Auto-allowed (Full access)**. Other permission levels retain their normal human review flow. Budget over-cap quotations are permission decisions; configured hard budget denials still refuse the request. Skill installation retains its exact, revocable authorization and cancellation signal throughout the background task. It rechecks that authorization after receipt persistence, before atomic file publication and before each resource effect. MCP registration, trust, local-start approval and enablement each recheck the consumed configuration-bound authorization, including its deadline. Narrowing, session closure, cancellation, expiry or an actor change stops remaining effects. Skill resource journals carry the same private lease through queued writes, discovery refresh and reconciliation. They recheck live authority and expiry after queue acquisition and file flush, immediately before publication. An unfinished automatic operation cannot resume after restart without fresh authorization; human administration retains its normal recovery path.

Plugin installation, updates, trust and enablement carry the same private authorization lease into the profile-lock transaction. Each transaction rechecks it after lock acquisition and asynchronous work, after temporary-file flushes, and immediately before atomic publication. Runtime target publication checks it inside its serialized lane and durable transaction; a refusal after runtime apply restores the previous runtime. Ask-mode memory writes carry their exact consumed decision into the SQLite commit lock and recheck the live session epoch and deadline before the file rename. Refused operations remove unpublished temporary files; ordinary human administration keeps its existing path.

Automatic permission results bind a backend session identity and authorization epoch. Changing the preset revokes pending automatic grants and unused results; already consumed effect receipts remain history. The backend checks the epoch again after journal persistence and before effect admission. Candidate auto-publication also requires the candidate's origin session to match the current session. The private `permission-decisions.jsonl` authorization journal retains exact non-secret session/call/scope/hash bindings, actor, timestamps and consumption state; it omits free-form summaries. General audit redaction is unchanged. Ordinary extension questions (`decisions.request`) and unknown purposes are never classified as permissions from their buttons. Business consent follows the explicit contract below; content questions (`ask_user`, plan exit, fact checks and author free-form questions) still need human content.

Candidate author tests keep the Host OS sandbox on macOS/Linux and run against a disposable candidate copy. A missing POSIX sandbox refuses execution. Windows remains unisolated. Under full access, all platforms automatically allow the exact-hash test decision; the `workspace-write` permission still shows the package, hash, execution mode, risk and scope for one confirmation. Changed hashes refuse stale authority. The decision is retained in `candidate-test-audit.jsonl`; testing alone never publishes. Submitting a passing candidate under full access completes the existing installation, trust, enablement and runtime activation transaction automatically.

Regulated e-signatures are business acts, separate from tool permission. Showcase applications request `business.confirm` through the public decision port for quality records, GMP release, MRB disposition, configuration changes, rule enablement and zeroing closure. They bind the reviewed arguments, object, revision, evidence and meaning. Full access includes these business confirmations: Host submits the exact declared approving `presentation.responseValue` for the session’s human principal and records **auto-confirmed under full access**, never a manual click or a model/system signature. The Core authorization journal (`decision/state`), business receipt, audit trail and release certificate/closure record retain that identity, mode and decision binding. Only the unambiguous single-use `allowed-once`/`rejected` contract with declared signature values can auto-confirm (English first, otherwise locale keys in code-point order); incomplete or schema-incompatible contracts stay pending with a recorded reason. Other permission levels still ask the human. Consumption and the private effect admission retain the same session identity, epoch, cancellation and expiry checks through transaction commit; narrowing permission before commit blocks the write. Nested business writes retain every joined private admission through the outermost transaction; its real commit rechecks them all, including capabilities from already-returned inner calls. Refusal, cancellation, expiry and stale revisions remain non-signatures.

`ask_user` questions, explicitly chosen plan/read-only modes, ordinary file-tool refusals for private `secrets/`, `auth/` and `profiles/`, and read-before-edit/stale-read checks remain in force. Selecting full access itself can require one initial grant confirmation. Factual reconciliation of an unknown external outcome is not a permission grant and cannot assert that an effect happened automatically.

To allow files outside the workspace, select `full-access` explicitly, for example `agh --permission full-access` (the older `agh --preset full-access` still works). On macOS/Linux without a usable L1 backend, mediated file tools remain available but an installed memory provider refuses unconfined commands. Windows uses the explicitly declared unimplemented exception; memory API rules remain in effect. A profile can make it the default for new sessions:

```yaml
permissions:
  default: full-access
  allowed: [read-only, workspace-write, full-access]
```

A custom recipe can retain approvals while explicitly overriding `sandbox: { level: L0, required: false, on_unavailable: allow }`; such a recipe fixes its own permission settings. This permits unconfined commands when no installed provider requires private-file isolation, or on the trusted local Windows backend where that isolation is unimplemented. Changing only `on_unavailable` does not override `required: true`. The conditional value is invalid with an L0 request. Web Full permissions and `/yolo` do not disable the selected preset's OS sandbox. L1 backends currently reject non-empty command-network host allowlists; `web_fetch` uses its separate public-network policy. A profile can select another sandbox provider at startup; see [Sandbox providers](sandbox-providers.md). The running process keeps that choice until it starts again.

Local Web relies on loopback binding and exact Origin/Host checks, rather than internet user authentication. Do not expose it directly to the public internet. A manual `--connect` must identify the target explicitly. Windows named pipes also check process ownership against discovery records.

Computer Use is another privileged surface. Its local profile configuration still requires runtime components, a suitable model, and operating-system permissions. `computer-use permissions grant` starts an authorization flow; `install/restart` changes runtime components. Begin read-only diagnosis with `computer-use status` and `doctor computer-use`; do not automatically grant system permissions for documentation checks.

<a id="skill-管理的删除边界"></a>

## Skill deletion boundaries

Permanent deletion and priority changes require server-side admin authority and `resources.skills.write`, through the Web management BFF or Node SDK. Priority overrides do not grant trust or enablement and do not expand ordinary plugin API permissions.

Permanent disk Skill deletion covers every file in the selected directory. User sources may be shared by other applications. Package/runtime sources cannot be deleted through this interface. Deletion verifies the registered source, revision, and file identities before proceeding, and cannot be canceled after acceptance. Partial failure retains deletion markers, blocks re-enabling, and permits explicit constrained retries. Another same-name candidate may take over, subject to its own authorization. See [Skills](skills.md#permanently-delete-a-disk-skill) for the complete procedure and limits.

<a id="密钥和持久数据"></a>

## Secrets and persistent data

Local model accounts use private files under `AGH_HOME/secrets` (also on macOS), shared with session model adapters. On a credential write, AGH narrows a home owned by the current user from owner-writable, non-group/world-writable permissions such as 0755 to 0700. It does not repair existing credential directories or files: directories must be 0700 and files 0600. Storage failures refuse the account operation and record the error class, reason, allowlisted OS code and affected path in `AGH_HOME/data/audit/configuration.jsonl`, without credential contents. Settings distinguishes permission failures, read-only filesystems and unsafe or invalid storage.

The configuration service stores provider keys in a credential backend. Public configuration retains only `secret://...` references. MCP CLI rejects plaintext options such as `--token` and `--env`, accepting constrained references instead. A reference does not grant arbitrary permission to read a secret.

`AGH_HOME` contains sessions, configuration, grants, audits, and caches. Reduced logging does not mean conversation text is free of sensitive information. Review user input, tool arguments, and paths before exporting, taking screenshots, or publishing errors. Do not commit `secrets/`, `auth/`, a complete home, real traces, or credential files. `publicConfig` reaches the browser and must never contain secrets or secret references.

File tools and sandbox policies protect workspace `.agh/secrets`. On Linux, Host prepares its `.agh` ancestor before compiling the command sandbox: it creates only this empty AGH-owned directory with normal permissions when missing, never follows symlinks, and refuses a symlink or non-directory with `E_SANDBOX_WORKSPACE` (`workspace-ancestor-not-directory`). The ancestor remains a real mount anchor so a command cannot rename it to expose secrets. `.agnes/secrets` belongs to another product and has no implicit AGH protection or migration. Do not point AGH's home at another product's data directory. Legacy `AGNES_HOME` is a compatibility option with no automatic migration.

Check the target system before retrying an operation with unknown side effects. Recovering a backend database cannot recall an email, undo a network write, or reverse a physical device action.

The persistence contract separates ledger, metadata/KV, durable child-control, reclaim and integrity. The full Host requires these five capabilities and accepts complete non-SQL providers, including the [JSONL example](../../examples/persistence/). Synchronous SQL is an optional `sqlite` port (`dialect: sqlite`); SQL-dependent third-party extensions must choose a provider supporting it. Default package domains and Host authorization/receipt stores consume owner-scoped metadata. Switching providers requires restart and never migrates files automatically; see [provider contracts and export/import migration](../extend/persistence.md).

Provider authors declare `capabilities: { ledger: true, ... }` and expose `metadata`, `childControl`, `reclaim` and `scanIntegrity` explicitly. SQLite ledger/child files remain compatible. Legacy grant and receipt schemas are validated before copying to metadata; revocations remain durable before observers are notified. Legacy SQL tables remain for rollback evidence, but metadata changes are not reflected back into them.

Implementation: [default profile](../../packages/host-common/templates/local-dev.yaml), [ordinary row API](../../packages/host-extensions/src/ext-host/row-extension-api.ts), [MCP argument policy](../../packages/resource-control-cli/src/resources.ts), [Web server](../../packages/web-server/src/server.ts).

## Package provenance and source policy

New installations record the resolved source and version, packed tree SHA256, publisher evidence when available, installation time, installer and trust decision. `agh plugins provenance <id> --json` reads that record; App Server `_agnes/v1/packages.provenance` and `_agnes/v1/packages.sourcePolicy` are admin read methods. The review dialog and plugin details display the same summary. A verified publisher does not isolate plugin code: in-process plugins still require review of their declared permissions.

Install verifies downloaded bytes; loading installed packages and immutable generation snapshots verifies the tree through the managed byte checks described above, or full hashing without an owner. A mismatch fails closed (`E_PACKAGE_INTEGRITY`); invalid provenance evidence uses `E_PACKAGE_PROVENANCE`. Existing lock records remain readable but gain no verified publisher identity automatically. npm attestations, when present, are verified with Sigstore and must name the exact pinned package/version and packed archive digest. Missing evidence remains visibly unverified; invalid evidence refuses installation.

Administrative provenance includes the declared resolved source location. Diagnostic messages remain fixed safe summaries and do not disclose unrelated local paths.

Administrators configure `<AGH_HOME>/profiles/<profile>/package-sources.json`:

```json
{ "allowedSources": "any-with-confirmation" }
```

`any-with-confirmation` is the default and retains the existing digest-bound trust approval. `official-only` accepts signed official catalog tuples. `official+npm-with-provenance` additionally accepts npm packages with verified publisher evidence. Policy is checked at acquisition and installed inventory load. Changing policy does not silently replace code already pinned by a running session.

The official catalog has a maintainer-owned Ed25519 key slot: `officialKeys` maps key IDs to PEM public keys; `officialCatalog` holds `{ "statement": { "keyId", "issuedAt", "entries" }, "signature" }`. Each signed entry binds `id`, `version`, resolved `source`, `treeIntegrity` and `publisher`. Signature bytes are Ed25519 over UTF-8 canonical sorted-key JSON of the statement, encoded as base64. An optional signed `mcpDefinitions` list contains `sha256-<hex>` hashes of JCS-serialized full MCP definitions. Only an exact verified definition receives the official stdio default. Keys are configured by the administrator, never accepted from downloaded packages. Tests generate development keys; provisioning the real official signing key and catalog is a maintainer action.

Repository `.agh/plugins` code is disabled and untrusted on discovery. Settings → Runtime details → Local plugins offers a counted confirmation bound to the current snapshots and `.agh/hooks.json` digest. Trust is recorded in the user profile, not the repository. Editing those executable inputs requires review again. Skills are instruction text; their helper files and repository package scripts/MCP configuration are not executed just by starting a session. Command hooks require exact content trust in addition to their sandbox checks.

On Windows with PowerShell, a command Hook without process isolation additionally needs a `commandHooks.trustedUnconfined` grant matching its configuration source, exact content digest and canonical workspace. The Hook uses the current workspace's Host-bound execution capability; Host decides whether execution is permitted, including `allow-if-unimplemented`, explicit denial and `required: true`. The grant is checked against each invocation’s canonical workspace, including sessions in other workspaces. Hook trust never overrides that decision. Untrusted workspace hooks are omitted from the invocation; a trusted Hook whose execution is refused still follows the event's normal failure behavior. This does not change macOS/Linux isolation requirements, tool approvals, or the Windows memory limitations described above.
