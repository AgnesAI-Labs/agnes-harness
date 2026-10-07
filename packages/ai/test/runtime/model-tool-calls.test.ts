import { describe, expect, it } from 'vitest'
import { toolCallRefusal } from '../../src/runtime/model-adapter/tool-calls.js'

const call = (toolUseId: string) => ({ toolUseId, name: 'tool', args: {}, ordinal: 0 })

describe('runtime model adapter tool call refusals', () => {
  it.each(['a', 'A-b_9', 'x'.repeat(64)])('accepts the id %j', (id) => {
    expect(toolCallRefusal(call(id), '{}')).toBeNull()
  })
  it.each(['', 'x'.repeat(65), 'call.1', 'a b', 'a|b', 'é'])('refuses the id %j by name', (id) => {
    expect(toolCallRefusal(call(id), '{}')).toBe('model_tool_call_id')
  })
  it('refuses a non-string id', () => {
    expect(toolCallRefusal({ ...call('a'), toolUseId: 7 as never }, '')).toBe('model_tool_call_id')
  })
  it.each(['{bad json', '{"a":', '{"a":1}}', 'null,', "{'a':1}"])(
    'refuses argument text %j by name',
    (raw) => {
      expect(toolCallRefusal(call('a'), raw)).toBe('model_tool_call_arguments')
    },
  )
  it.each(['{}', '{"a":[1,{"b":null}]}', ' {"a":1} '])('accepts argument text %j', (raw) => {
    expect(toolCallRefusal(call('a'), raw)).toBeNull()
  })
  it.each(['', '  \n'])('does not call a call without streamed arguments malformed: %j', (raw) => {
    expect(toolCallRefusal(call('a'), raw)).toBeNull()
  })
  it('names the id before the arguments when both are wrong', () => {
    expect(toolCallRefusal(call('x'.repeat(65)), '{bad')).toBe('model_tool_call_id')
  })
})
