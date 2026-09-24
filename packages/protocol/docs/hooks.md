# HookMap

Generated from schema/hooks.json by tools/gen-docs.ts. Do not edit by hand.

| event | mode | category | failPolicy | timeoutMs | replayOnResume |
|---|---|---|---|---|---|
| `session_start` | parallel | observe | open | 500 | yes |
| `resources_discover` | waterfall | transform | open | 1000 | yes |
| `before_step` | serial | directive | closed | 1000 | no |
| `context` | waterfall | transform | closed | 1500 | no |
| `before_request` | waterfall | transform | closed | 1500 | no |
| `before_provider_headers` | waterfall | transform | closed | 500 | no |
| `request_error` | parallel | observe | open | 500 | no |
| `tool_call` | serial | directive | closed | 2000 | no |
| `tool_result` | waterfall | transform | open | 2000 | no |
| `turn_stopping` | serial | directive | open | 1000 | no |
| `approval_request` | waterfall | transform | closed | 1000 | no |
| `before_compact` | waterfall | transform | closed | 3000 | no |
| `compact` | parallel | observe | open | 1000 | no |
| `subagent_start` | emit | observe | open | 200 | no |
| `subagent_end` | emit | observe | open | 200 | no |
| `format_deviation` | parallel | observe | open | 500 | no |
| `shutdown` | parallel | observe | open | 1000 | no |

## payload and return

| event | payload | return |
|---|---|---|
| `session_start` | `reason`, `preset`, `cwd`, `parent?` | `void` |
| `resources_discover` | `actor`, `cwd`, `registered` | `resources?`, `additionalContext?` |
| `before_step` | `turn`, `step`, `depth`, `budget` | `block?`, `reason?` |
| `context` | `sections`, `surfaceDigest` | `sections?`, `additionalContext?` |
| `before_request` | `request`, `slot`, `model`, `attempt` | `patch?` |
| `before_provider_headers` | `route`, `headers` | `headers?` |
| `request_error` | `code`, `message`, `attempt`, `retryable` | `void` |
| `tool_call` | `toolUseId`, `name`, `args`, `meta`, `actor`, `taint`, `resolvedPolicy?`, `executionDomain?`, `definitionFingerprint?`, `policyHash?` | `allow` \| `allow`, `reason` |
| `tool_result` | `toolUseId`, `name`, `args`, `result`, `enforcement` | `result?` |
| `turn_stopping` | `turn`, `step`, `proposedReason`, `plan?`, `verifier?` | `action` \| `action`, `note` |
| `approval_request` | `request` | `request?` |
| `before_compact` | `contextTokens`, `contextWindow`, `reserveTokens`, `reason`, `previousSummarySeq?`, `customInstructions?` | `void` \| `{}` |
| `compact` | `replaceSeq`, `range`, `tokensBefore`, `tokensAfter` | `void` |
| `subagent_start` | `childKey`, `kind`, `budget` | `void` |
| `subagent_end` | `childKey`, `outcome`, `credits` | `void` |
| `format_deviation` | `rule`, `model`, `sampleHash` | `void` |
| `shutdown` | `reason` | `void` |
