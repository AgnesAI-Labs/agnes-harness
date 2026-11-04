import { describe, expect, it } from 'vitest'
import { inspectComposition } from './inspect-request-composition.mjs'

describe('offline request composition reader', () => {
  it('prints only diagnostic columns and skips legacy rows without composition', async () => {
    const output: string[] = []
    const rows = [
      { seq: 1, type: 'user/message', data: { content: 'private' } },
      { seq: 2, type: 'x/core/context-breakdown', data: { sections: [] } },
      {
        seq: 3,
        lane: 'main',
        type: 'x/core/context-breakdown',
        data: {
          turn: 1,
          step: 2,
          content: 'private',
          composition: {
            total: 20,
            tokens: { fixedPrefix: 10 },
            toolResultCount: 1,
            largestToolResult: { bytes: 50, tool: 'read' },
          },
        },
      },
      {
        seq: 4,
        lane: 'main',
        type: 'x/core/turn-wait',
        data: {
          turn: 1,
          model: { count: 2, ms: 30, missing: 0 },
          tools: [{ tool: 'read', count: 1, ms: 4, missing: 0 }],
        },
      },
    ]
    await inspectComposition(
      rows.map((row) => JSON.stringify(row)),
      (line: string) => output.push(line),
    )
    expect(output).toHaveLength(4)
    expect(output[1]).toContain('3\t"main"\t1\t2\t20\t10')
    expect(output[2]).toBe('"WAIT"\t"main"\t1\t"model"\tnull\t30\t2\t0')
    expect(output[3]).toBe('"WAIT"\t"main"\t1\t"tool"\t"read"\t4\t1\t0')
    expect(output.join('\n')).not.toContain('private')
    await expect(inspectComposition(['{private'], () => {})).rejects.toThrow('Invalid JSON at line 1')
  })
})
