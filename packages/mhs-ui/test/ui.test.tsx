// @vitest-environment happy-dom

import { fireEvent, getByLabelText, getByRole, queryByRole } from '@testing-library/dom'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityPage } from '../src/activity.js'
import { MhsClient } from '../src/client.js'
import { ExamplesPage } from '../src/examples.js'
import { StateField, ToolForm } from '../src/forms.js'
import { catalog } from '../src/locales.js'
import { pickValue, WorldMap } from '../src/map.js'
import { devicesFrom } from '../src/model.js'
import { MhsPage } from '../src/page.js'
import { MhsProvider, ReceiptView, Stop } from '../src/react.js'
import { MhsStore } from '../src/store.js'
import { device, fake } from './fixtures.js'

let root: Root, host: HTMLElement, dispose: () => void
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})
afterEach(async () => {
  await act(async () => {
    root.unmount()
    dispose?.()
  })
  host.remove()
  vi.useRealTimers()
})
async function mount(node: ReactNode, f = fake()) {
  const client = new MhsClient(f.ports),
    store = new MhsStore(client)
  dispose = () => client.dispose()
  await act(async () => {
    await store.refresh()
    root.render(
      <MhsProvider value={{ client, store, t: (key) => catalog.en[key], openDevice: () => {} }}>
        {node}
      </MhsProvider>,
    )
  })
  return f
}
async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}
describe('MHS approved device interactions', () => {
  it('validates required JSON/typed enum forms and confirms motion without granting approval', async () => {
    const d = devicesFrom([device()])[0]!
    const f = await mount(
      <ToolForm
        device={d}
        tool={{
          name: 'drive',
          motion: true,
          inputSchema: {
            type: 'object',
            required: ['destination', 'mode'],
            properties: {
              destination: { type: 'object' },
              mode: { type: 'integer', enum: [1, 2] },
              enabled: { type: 'boolean' },
            },
          },
        }}
      />,
    )
    const details = host.querySelector('details')!
    details.open = true
    expect(getByRole(host, 'button', { name: 'Run' }).hasAttribute('disabled')).toBe(true)
    await act(async () => {
      fireEvent.change(getByLabelText(host, 'destination *'), { target: { value: '{"x":4}' } })
      fireEvent.change(getByLabelText(host, 'mode *'), { target: { value: '2' } })
    })
    await click(getByRole(host, 'button', { name: 'Run' }))
    expect(f.effects).toHaveLength(0)
    expect(getByRole(host, 'group', { name: 'Confirm device action' })).toBeTruthy()
    f.receipt = { state: 'approval-required', operationId: 'op', decisionId: 'native' }
    await click(
      getByRole(getByRole(host, 'group', { name: 'Confirm device action' }), 'button', { name: 'Run' }),
    )
    expect(f.effects[0]?.input).toEqual({
      device: d.id,
      tool: 'drive',
      args: { destination: { x: 4 }, mode: 2 },
    })
    expect(host.textContent).toContain('Approval pending')
    expect(queryByRole(host, 'button', { name: 'Approve' })).toBeNull()
  })
  it('rejects malformed optional JSON and does not save a readonly field from a device declaration', async () => {
    const d = devicesFrom([device()])[0]!
    await mount(
      <ToolForm
        device={d}
        tool={{ name: 'sample', inputSchema: { properties: { data: { type: 'object' } } } }}
      />,
    )
    host.querySelector('details')!.open = true
    await act(async () => {
      fireEvent.change(getByLabelText(host, 'data'), { target: { value: '{bad' } })
    })
    expect(getByLabelText(host, 'data').getAttribute('aria-invalid')).toBe('true')
    expect(getByRole(host, 'button', { name: 'Run' }).hasAttribute('disabled')).toBe(true)
  })
  it('keeps global stop available without a session and shows unknown rather than confirmed stopped', async () => {
    const f = fake()
    f.setSession(undefined)
    f.receipt = { state: 'unknown', operationId: 'stop', code: 'dispatch-unconfirmed' }
    await mount(<Stop />, f)
    await click(getByRole(host, 'button', { name: 'Stop all' }))
    expect(f.effects[0]).toMatchObject({ name: 'mhs.stop', input: {} })
    expect(host.textContent).toContain('Outcome unknown')
  })
  it('renders all five tabs from the current projection and keeps the no-session activity filter disabled', async () => {
    const f = fake()
    f.setSession(undefined)
    await mount(<MhsPage />, f)
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(5)
    await click(getByRole(host, 'tab', { name: 'Activity' }))
    expect(getByLabelText(host, 'Current session').hasAttribute('disabled')).toBe(true)
    expect(host.textContent).toContain('Last 7 days')
  })
  it('picks point, two-point pose and polygon with keyboard coordinates and supports cancellation', async () => {
    const picked: unknown[] = [],
      cancel = vi.fn()
    await mount(
      <WorldMap
        maps={[{ id: 'site', bounds: [0, 0, 10, 10] }]}
        devices={[]}
        mode="pose"
        onPick={(v) => picked.push(v)}
        onCancel={cancel}
      />,
    )
    await act(async () => {
      fireEvent.change(getByLabelText(host, 'Map X'), { target: { value: '2' } })
      fireEvent.change(getByLabelText(host, 'Map Y'), { target: { value: '3' } })
    })
    await click(getByRole(host, 'button', { name: 'Add point' }))
    await act(async () => {
      fireEvent.change(getByLabelText(host, 'Map X'), { target: { value: '3' } })
    })
    await click(getByRole(host, 'button', { name: 'Add point' }))
    expect(picked).toEqual([{ map: 'site', x: 2, y: 3, yaw: 0 }])
    await click(getByRole(host, 'button', { name: 'Cancel picking' }))
    expect(cancel).toHaveBeenCalled()
    expect(pickValue('point', 'site', [[1, 2]])).toEqual({ map: 'site', x: 1, y: 2 })
    expect(
      pickValue('polygon', 'site', [
        [0, 0],
        [1, 0],
      ]),
    ).toBeUndefined()
    expect(
      pickValue('polygon', 'site', [
        [0, 0],
        [1, 0],
        [1, 1],
      ]),
    ).toEqual({
      map: 'site',
      points: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    })
  })
  it('uses reviewed example enable/launch tokens and embeds the registered local scene', async () => {
    const f = fake(),
      enabled: string[] = [],
      launched: string[] = []
    f.ports.examples = {
      list: async () => [{ id: 'mars', name: 'Mars', description: 'Rescue', state: 'disabled' }],
      subscribe: () => () => {},
      inspect: async () => ({ reviewId: 'review', presentation: { devices: 11 } }),
      enable: async (_id, token) => {
        enabled.push(token ?? '')
      },
      stop: async () => {},
      prepare: async () => ({ launchTicket: 'ticket', presentation: { prompt: 'Rescue' } }),
      launch: async (_id, token) => {
        launched.push(token ?? '')
      },
    }
    await mount(<ExamplesPage />, f)
    await click(getByRole(host, 'button', { name: 'Enable example' }))
    expect(enabled).toEqual([])
    await click(getByRole(host, 'button', { name: 'Run' }))
    expect(enabled).toEqual(['review'])
    f.ports.examples.list = async () => [
      {
        id: 'mars',
        name: 'Mars',
        description: 'Rescue',
        state: 'running',
        Scene: () => <p>Local Mars scene</p>,
      },
    ]
    await click(getByRole(host, 'button', { name: 'Retry' }))
    await click(getByRole(host, 'button', { name: 'Start a session' }))
    expect(launched).toEqual([])
    await click(getByRole(host, 'button', { name: 'Run' }))
    expect(launched).toEqual(['ticket'])
    await click(getByRole(host, 'button', { name: 'Open scene' }))
    expect(host.textContent).toContain('Local Mars scene')
  })
})
