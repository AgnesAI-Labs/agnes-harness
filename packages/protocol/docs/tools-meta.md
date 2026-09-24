# ToolDef meta, the eight keys

Generated from schema/tooldef.json by tools/gen-docs.ts. Do not edit by hand.

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
