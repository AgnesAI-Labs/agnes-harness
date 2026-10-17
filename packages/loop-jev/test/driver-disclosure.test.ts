import { describe, expect, it } from 'vitest'
import { run, textReply } from './helpers/drive.js'
import { PICK_LS, PICK_RESPOND } from './helpers/fake-jev.js'

const STANDARD = ['ls', 'read', 'grep', 'find', 'write', 'edit', 'shell', 'tool_search', 'tool_describe']
const WITH_CODE = [...STANDARD, 'run_code']

describe('the Jev loop under a code or hybrid disclosure', () => {
  it.each<{ name: string; tools: string[]; disclosed: string[] }>([
    { name: 'hybrid', tools: WITH_CODE, disclosed: WITH_CODE },
    { name: 'code', tools: WITH_CODE, disclosed: ['run_code'] },
    { name: 'code without a code runtime', tools: STANDARD, disclosed: [] },
  ])('ends a $name turn with JEV_UNSUPPORTED_DISCLOSURE before any call', async ({ tools, disclosed }) => {
    const r = await run([{ pick: PICK_LS }], {
      view: { tools, platform: { disclosed } },
      replies: [textReply('never sent')],
    })
    expect(r.finished).toEqual([
      'error',
      {
        code: 'JEV_UNSUPPORTED_DISCLOSURE',
        message: expect.stringMatching(
          /does not support the code or hybrid tool disclosure.*agnes\.default/s,
        ),
      },
    ])
    expect(r.jev.prepared).toHaveLength(0)
    expect(r.requests).toHaveLength(0)
    expect(r.tools.executed).toHaveLength(0)
    expect(r.steps).toHaveLength(0)
    expect(r.metrics).toEqual([expect.objectContaining({ endReason: 'error', steps: 0 })])
  })
  it('runs a turn under the standard disclosure although run_code is in the catalog', async () => {
    const r = await run([{ pick: PICK_LS }, { pick: PICK_RESPOND }], {
      view: { tools: WITH_CODE, platform: { disclosed: STANDARD } },
      replies: [textReply('The workspace has notes.txt.')],
    })
    expect(r.finished?.[0]).toBe('completed')
    expect(r.tools.executed.map((c) => c.name)).toEqual(['ls'])
  })
  it('runs a turn when the view does not list the disclosed tools', async () => {
    const r = await run([{ pick: PICK_LS }, { pick: PICK_RESPOND }], {
      view: { tools: WITH_CODE },
      replies: [textReply('ok')],
    })
    expect(r.finished?.[0]).toBe('completed')
  })
})
