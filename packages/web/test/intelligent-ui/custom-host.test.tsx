/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
import { Context } from '@agnes/cordis'
import type { UiCustomComponent } from '@agnes/protocol/gen/intelligent-ui'
import type { ClientModuleRosterRow } from '@agnes/protocol/gen/package-admin'
import { ThemeService } from '@agnes/web-client'
import { IntelligentCatalog } from '@agnes/web-ui'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { CustomUiHost, selectCustomUiModule } from '../../src/intelligent-ui/custom-host.js'
import { financeRecord } from './fixture.js'

const declaration = {
  kind: 'finance/reconcile/diff@1',
  propsSchema: {
    type: 'object',
    required: ['amount'],
    properties: { amount: { type: 'integer' } },
    additionalProperties: false,
  },
  maxPropsBytes: 256,
  fallback: 'Review the preset differences table.',
  accessibility: { label: 'Differences', keyboard: true as const },
}
const component: UiCustomComponent = {
  id: 'custom',
  kind: declaration.kind,
  dataKey: 'custom',
  fallback: declaration.fallback,
  actionIds: ['confirm'],
}
const surface = {
  ...financeRecord().surface,
  components: [component, ...financeRecord().surface.components],
  data: { ...financeRecord().surface.data, custom: { amount: 12 } },
}
const row: ClientModuleRosterRow = {
  rowId: 'web:finance',
  moduleName: 'finance',
  packageId: 'finance',
  enabled: true,
  phase: 'ready',
  revision: 'sha512-reviewed',
  contentDigest: `sha256-${'a'.repeat(64)}`,
  entryUrl: '/plugins/generations/11111111-1111-1111-1111-111111111111/finance/sha512-reviewed/diff.mjs',
  intelligentComponents: [declaration],
}
const base = { component, surface, disabled: false, onAction: vi.fn() }
const message = (frame: HTMLIFrameElement, data: unknown) =>
  window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow, origin: 'null' }))

describe('reviewed custom host', () => {
  it('refuses blocked, unpinned, ambiguous and schema-invalid module identities', () => {
    expect(selectCustomUiModule([row], base)).toEqual(row)
    for (const rows of [
      [],
      [{ ...row, phase: 'blocked' as const }],
      [{ ...row, enabled: false }],
      [{ ...row, entryUrl: '/plugins/current/diff.mjs' }],
      [row, row],
    ])
      expect(selectCustomUiModule(rows, base)).toBeUndefined()
    expect(
      selectCustomUiModule([row], {
        ...base,
        surface: { ...surface, data: { ...surface.data, custom: { amount: '12' } } },
      }),
    ).toBeUndefined()
  })
  it('uses text for an untrusted module and isolates renderer failure while gating action ids', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const theme = new ThemeService(new Context(), 'light')
    let rows: ClientModuleRosterRow[] = [{ ...row, phase: 'blocked' }]
    const source = { theme, list: async () => rows, subscribe: () => () => {} }
    const onAction = vi.fn()
    const render = async (disabled = false) => {
      await act(async () =>
        root.render(
          <CustomUiHost {...base} source={source} sessionId="s" disabled={disabled} onAction={onAction} />,
        ),
      )
    }
    try {
      await render()
      expect(container.textContent).toContain(declaration.fallback)
      expect(container.querySelector('iframe')).toBeNull()
      rows = [row]
      await act(async () => root.unmount())
      const second = createRoot(container)
      await act(async () =>
        second.render(<CustomUiHost {...base} source={source} sessionId="s" onAction={onAction} />),
      )
      const frame = container.querySelector('iframe')!
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
      await act(async () => message(frame, { type: 'agnes-ui-action', id: 'undeclared' }))
      expect(onAction).not.toHaveBeenCalled()
      await act(async () => message(frame, { type: 'agnes-ui-ready' }))
      await act(async () => message(frame, { type: 'agnes-ui-action', id: 'confirm' }))
      expect(onAction).toHaveBeenCalledWith('confirm')
      onAction.mockClear()
      await act(async () =>
        second.render(<CustomUiHost {...base} source={source} sessionId="s" disabled onAction={onAction} />),
      )
      await act(async () => message(frame, { type: 'agnes-ui-action', id: 'confirm' }))
      expect(onAction).not.toHaveBeenCalled()
      expect(frame.hasAttribute('inert')).toBe(true)
      await act(async () => message(frame, { type: 'agnes-ui-error' }))
      expect(container.textContent).toContain(declaration.fallback)
      expect(container.querySelector('iframe')).toBeNull()
      await act(async () => second.unmount())
    } finally {
      container.remove()
    }
  })
  it('isolates a synchronous renderer error and leaves the preset table working', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await act(async () =>
        root.render(
          <IntelligentCatalog
            surface={surface}
            input={{}}
            selection={{}}
            disabled={false}
            onInput={() => {}}
            onSelection={() => {}}
            onInvalid={() => {}}
            onAction={() => {}}
            renderCustom={() => {
              throw new Error('broken renderer')
            }}
          />,
        ),
      )
      expect(container.textContent).toContain(declaration.fallback)
      expect(container.querySelector('[data-testid="ui-table-differences"]')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
      error.mockRestore()
    }
  })
})
