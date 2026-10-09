import type { UiSurface } from '@agnes/protocol'
import { surfaceText } from '@agnes/protocol/intelligent-ui'
import { describe, expect, it } from 'vitest'
import { Text } from '../../src/tui/component.js'

// DBH LOG-001 survives the table migration: declared columns need not match every row's keys.
// TUI renders the protocol surface text, rather than the retired inline-slot array table.
function table(columns: string[], rows: UiSurface['data'][string]): UiSurface {
  return {
    id: 'rows',
    revision: 1,
    title: 'Rows',
    placement: { inline: true, workbench: true },
    components: [
      {
        id: 'table',
        kind: 'table',
        dataKey: 'rows',
        rowKey: 'id',
        selection: 'none',
        columns: columns.map((key) => ({ key, label: key })),
      },
    ],
    data: { rows },
    actions: [],
  }
}

describe('DBH LOG-001: surface tables survive rows with missing or extra keys', () => {
  it('[control] renders the declared columns of a well-formed table', () => {
    expect(
      surfaceText(table(['a', 'b'], [{ id: '1', a: '1', b: '22' }]))
        .split('\n')
        .slice(1),
    ).toEqual(['a | b', '1 | 22'])
  })

  it('[preserve] leaves a missing cell empty while keeping the declared column', () => {
    expect(
      surfaceText(table(['a', 'b'], [{ id: '1', a: '1' }]))
        .split('\n')
        .slice(1),
    ).toEqual(['a | b', '1 | '])
  })

  it('does not throw or display undeclared cells when a row has extra keys', () => {
    const surface = table(['a'], [{ id: '1', a: '1', extra: '2' }])
    expect(() => surfaceText(surface)).not.toThrow()
    expect(surfaceText(surface).split('\n').slice(1)).toEqual(['a', '1'])
  })

  it('renders the surface through the terminal text component without throwing', () => {
    const text = new Text(surfaceText(table(['a'], [{ id: '1', a: '1', extra: '2' }])))
    expect(() => text.render(80)).not.toThrow()
    expect(text.render(80).map((line) => line.trimEnd())).toEqual(['Rows (revision 1)', 'a', '1'])
  })
})
