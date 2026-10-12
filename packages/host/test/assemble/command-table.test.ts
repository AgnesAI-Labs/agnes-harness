import type { PresetDoc } from '@agnes/host-common/presets/types'
import { describe, expect, it } from 'vitest'
import { readCommandTable } from '../../src/runtime/assemble/command-table.js'

const doc = (command_policy?: unknown) =>
  ({ name: 'p', approval: { command_policy } }) as unknown as PresetDoc

describe('assembly command table', () => {
  it('reads no table as no rules', () => {
    expect(readCommandTable({ name: 'p' } as unknown as PresetDoc)).toEqual([])
  })

  it('reads the rules the default preset states', () => {
    const rules = [{ tool: 'shell', argv: '^rm', action: 'deny' }]
    expect(readCommandTable(doc(rules))).toEqual(rules)
  })

  it('stops assembly naming the bad rule rather than degrading at run time', () => {
    expect(() =>
      readCommandTable(
        doc([
          { tool: 'shell', argv: 'ls', action: 'allow' },
          { tool: 'shell', argv: '(', action: 'deny' },
        ]),
      ),
    ).toThrow(/command_policy\[1\] \(tool shell\)/)
    try {
      readCommandTable(doc('ls'))
    } catch (e) {
      expect(e).toMatchObject({ code: 'E_PRESET_UNSUPPORTED' })
    }
  })
})
