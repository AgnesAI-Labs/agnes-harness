import { describe, expect, it } from 'vitest'
import { TOOL_PATH_REFERENCES, type ToolPathReferences, type ToolResult } from '../src/index.js'

describe('path references', () => {
  it('names the payload with a versioned schema id', () => {
    expect(TOOL_PATH_REFERENCES).toBe('agh.path-references/1')
  })
  it('travels in ToolResult.structured as plain JSON', () => {
    const structured: ToolPathReferences = {
      schema: TOOL_PATH_REFERENCES,
      references: [
        { kind: 'directory', path: 'src' },
        { kind: 'file', path: 'src/a.ts' },
      ],
      total: 3,
      truncated: true,
    }
    const result: ToolResult = { content: [{ type: 'text', text: 'src/\nsrc/a.ts' }], structured }
    expect(JSON.parse(JSON.stringify(result.structured))).toEqual(structured)
  })
})
