# ToolDef meta

Generated from schema/tooldef.json by tools/gen-docs.ts. Do not edit by hand.

Eight keys are required: `isReadOnly`, `isDestructive`, `isConcurrencySafe`, `isOpenWorld`, `replay`, `costHint`, `deferLoading`, and `requiresApproval`. `isPresentational` and `paths` are optional.

| key | shape | meaning and consumer |
|---|---|---|
| `isReadOnly` | `{"type":"boolean"}` | The tool declares no writes. Tainted-call policy and sandbox requirements consult this flag; it does not override explicit approval or concurrency flags. |
| `isDestructive` | `{"type":"boolean"}` | The tool performs a destructive action. Consumed by the approval stage, which gates the call before it runs. |
| `isConcurrencySafe` | `{"type":"boolean"}` | The tool may run alongside other calls. The inner batch scheduler and the code runtime's sub-calls read this same judgement. |
| `isOpenWorld` | `{"type":"boolean"}` | The result comes from outside. The row carrying it is written untrusted, injection defence trims it, and surface projection reads this. |
| `replay` | `{"enum":["safe","never","idempotent"]}` | How crash recovery treats an unsettled call: safe reruns it verbatim, idempotent reruns it under the same effectId, never synthesises an unknown outcome. Consumed by the effect sandwich. |
| `costHint` | `{"oneOf":[{"type":"null"},{"type":"object","additionalProperties":false,"properties":{"credits":{"type":"number","minimum":0},"wallMs":{"type":"integer","minimum":0}}}]}` | An estimate for the budget preflight; null means the author declared no hint. Consumed by the budget stage. |
| `deferLoading` | `{"type":["boolean","null"]}` | true keeps the tool out of the default disclosure until a search loads it. null defers to the package default, which the MCP importer reads as true; until that importer lands, null behaves as false. Consumed by disclosure. |
| `requiresApproval` | `{"oneOf":[{"enum":["never","destructive","always"]},{"type":"null"}]}` | The approval band; null lets isDestructive and the command policy table decide. Consumed by the approval stage. |
| `isPresentational` | `{"type":"boolean"}` | Optional. The effect only publishes display state to the user and has no external side effect. It cannot be combined with isDestructive or isOpenWorld. Tainted-call policy does not escalate this flag; requiresApproval always and a destructive band still ask. |
| `paths` | `{"type":"array","maxItems":32,"items":{"type":"object","additionalProperties":false,"required":["arg","access"],"properties":{"arg":{"type":"string","pattern":"^[A-Za-z_][A-Za-z0-9_]{0,127}$"},"access":{"enum":["read","write"]},"default":{"type":"string","minLength":1,"maxLength":4096},"nonWorkspaceSchemes":{"type":"array","maxItems":16,"items":{"type":"string","pattern":"^[a-z][a-z0-9+.-]{0,63}$"}}}}}` | Optional declarations of top-level workspace path arguments. The runtime preflights access before every approval mode; URI schemes delegated to resource services never widen the filesystem fence. |
