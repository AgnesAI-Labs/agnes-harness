# ToolDef meta

Generated from schema/tooldef.json by tools/gen-docs.ts. Do not edit by hand.

Five keys are required: `isReadOnly`, `isDestructive`, `isConcurrencySafe`, `isOpenWorld` and `replay`. Other fields are optional; omitted costHint, deferLoading and requiresApproval mean no estimate, initial discovery and approval inferred from isDestructive.

| key | shape | meaning and consumer |
|---|---|---|
| `isReadOnly` | `{"type":"boolean"}` | The tool declares no writes. Tainted-call policy and sandbox requirements consult this flag; it does not override explicit approval or concurrency flags. |
| `isDestructive` | `{"type":"boolean"}` | The tool performs a destructive action. Consumed by the approval stage, which gates the call before it runs. |
| `isConcurrencySafe` | `{"type":"boolean"}` | The tool may run alongside other calls. The inner batch scheduler and the code runtime's sub-calls read this same judgement. |
| `isOpenWorld` | `{"type":"boolean"}` | The result comes from outside. The row carrying it is written untrusted, injection defence trims it, and surface projection reads this. |
| `replay` | `{"enum":["safe","never","idempotent"]}` | How crash recovery treats an unsettled call: safe reruns it verbatim, idempotent reruns it under the same effectId, never synthesises an unknown outcome. Consumed by the effect sandwich. |
| `costHint` | `{"oneOf":[{"type":"null"},{"type":"object","additionalProperties":false,"properties":{"credits":{"type":"number","minimum":0},"wallMs":{"type":"integer","minimum":0}}}]}` | Optional estimate for budget preflight. Omission or null means no estimate. |
| `deferLoading` | `{"oneOf":[{"type":["boolean","null"]},{"const":"auto"}]}` | Optional. true defers model discovery until loaded by search; omission, false or null means initial discovery; auto lets the runtime defer the turn's auto tools together once there are more than 15 of them or their schemas exceed about 4000 tokens. |
| `discoveryGroup` | `{"type":"string","pattern":"^[^\\r\\n\\t]{1,120}$"}` | Optional one-line label, such as an MCP server name. Deferred tools sharing a label are listed to the model as one line with their count. |
| `requiresApproval` | `{"oneOf":[{"enum":["never","destructive","always"]},{"type":"null"}]}` | Optional approval band. Omission or null means destructive for destructive tools, otherwise never; command policy still applies. |
| `invalidArgumentLimit` | `{"type":"integer","minimum":1,"maximum":5}` | Consecutive invalid argument failures before disabling this tool for the rest of the turn. Default 2. Valid arguments reset the count before exhaustion; exhausted tools cannot be re-enabled within the turn. |
| `attestsHistory` | `{"type":"boolean"}` | Optional. Evidence exports and reports wait for full session history verification before dispatch. Omission means ordinary execution; it does not attest ledger integrity. |
| `isPresentational` | `{"type":"boolean"}` | Optional. The effect only publishes display state to the user and has no external side effect. It cannot be combined with isDestructive or isOpenWorld. Tainted-call policy does not escalate this flag; requiresApproval always and a destructive band still ask. |
| `paths` | `{"type":"array","maxItems":32,"items":{"type":"object","additionalProperties":false,"required":["arg","access"],"properties":{"arg":{"type":"string","pattern":"^[A-Za-z_][A-Za-z0-9_]{0,127}$"},"access":{"enum":["read","write"]},"default":{"type":"string","minLength":1,"maxLength":4096},"nonWorkspaceSchemes":{"type":"array","maxItems":16,"items":{"type":"string","pattern":"^[a-z][a-z0-9+.-]{0,63}$"}}}}}` | Optional declarations of top-level workspace path arguments. The runtime preflights access before every approval mode; URI schemes delegated to resource services never widen the filesystem fence. |
| `modelVisible` | `{"type":"boolean"}` | Optional, defaults to true. false hides the tool from model schemas and discovery; internal invocation and authorization remain available. |
| `requiresImageInput` | `{"type":"boolean"}` | Optional, defaults to false. Only a model with native image input can discover or execute this tool. |
| `requiresUser` | `{"type":"boolean"}` | Optional, defaults to false. The tool asks a person who is present, or shows them something to look at or act on now (a question, a form, a live UI surface). A turn whose input declares that nobody is attending (agh -p, agh run, runHeadless) does not offer it to the model or execute a model call to it. |
| `presentation` | `{"$ref":"session-v1.json#/$defs/ToolPresentation"}` | Optional human-readable action and purpose for cards and approvals. Display only; exact arguments and authorization remain unchanged. |
| `commandArg` | `{"type":"string","pattern":"^[A-Za-z_][A-Za-z0-9_]{0,63}$"}` | Optional. Names the top-level string argument that carries the command text this tool runs. The command table matches its rules against that text, whitespace-folded, instead of the canonical JSON of all arguments. |
