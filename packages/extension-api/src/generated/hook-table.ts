// generated from packages/protocol/schema/hooks.json by tools/gen-tables.ts — do not edit
import type { HookEvent, HookSpec } from '../hooks.js'

export const HOOK_TABLE = Object.freeze({
  session_start: Object.freeze({"mode":"parallel","category":"observe","failPolicy":"open","timeoutMs":500,"replayOnResume":true}),
  resources_discover: Object.freeze({"mode":"waterfall","category":"transform","failPolicy":"open","timeoutMs":1000,"replayOnResume":true}),
  before_step: Object.freeze({"mode":"serial","category":"directive","failPolicy":"closed","timeoutMs":1000,"replayOnResume":false}),
  context: Object.freeze({"mode":"waterfall","category":"transform","failPolicy":"closed","timeoutMs":1500,"replayOnResume":false}),
  before_request: Object.freeze({"mode":"waterfall","category":"transform","failPolicy":"closed","timeoutMs":1500,"replayOnResume":false}),
  before_provider_headers: Object.freeze({"mode":"waterfall","category":"transform","failPolicy":"closed","timeoutMs":500,"replayOnResume":false}),
  request_error: Object.freeze({"mode":"parallel","category":"observe","failPolicy":"open","timeoutMs":500,"replayOnResume":false}),
  tool_call: Object.freeze({"mode":"serial","category":"directive","failPolicy":"closed","timeoutMs":2000,"replayOnResume":false}),
  tool_result: Object.freeze({"mode":"waterfall","category":"transform","failPolicy":"open","timeoutMs":2000,"replayOnResume":false}),
  turn_stopping: Object.freeze({"mode":"serial","category":"directive","failPolicy":"open","timeoutMs":1000,"replayOnResume":false}),
  approval_request: Object.freeze({"mode":"waterfall","category":"transform","failPolicy":"closed","timeoutMs":1000,"replayOnResume":false}),
  before_compact: Object.freeze({"mode":"waterfall","category":"transform","failPolicy":"closed","timeoutMs":3000,"replayOnResume":false}),
  compact: Object.freeze({"mode":"parallel","category":"observe","failPolicy":"open","timeoutMs":1000,"replayOnResume":false}),
  subagent_start: Object.freeze({"mode":"emit","category":"observe","failPolicy":"open","timeoutMs":200,"replayOnResume":false}),
  subagent_end: Object.freeze({"mode":"emit","category":"observe","failPolicy":"open","timeoutMs":200,"replayOnResume":false}),
  format_deviation: Object.freeze({"mode":"parallel","category":"observe","failPolicy":"open","timeoutMs":500,"replayOnResume":false}),
  shutdown: Object.freeze({"mode":"parallel","category":"observe","failPolicy":"open","timeoutMs":1000,"replayOnResume":false}),
} as const satisfies Record<HookEvent, HookSpec>)
