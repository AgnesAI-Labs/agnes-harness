// @vitest-environment happy-dom

import { fireEvent, getByLabelText, getByRole, queryByLabelText, queryByRole } from '@testing-library/dom'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MhsClient } from '../src/client.js'
import { DeviceDetail } from '../src/detail.js'
import { Drive } from '../src/drive.js'
import { ExamplesPage } from '../src/examples.js'
import { ToolForm } from '../src/forms.js'
import { catalog } from '../src/locales.js'
import { pickValue, WorldMap } from '../src/map.js'
import { devicesFrom } from '../src/model.js'
import { MhsPage } from '../src/page.js'
import { MhsProvider, Stop } from '../src/react.js'
import { MhsStore } from '../src/store.js'
import { Observation } from '../src/widgets.js'
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
              destination: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
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
      fireEvent.change(getByLabelText(host, 'destination *'), { target: { value: '{}' } })
      fireEvent.change(getByLabelText(host, 'mode *'), { target: { value: '2' } })
    })
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
  it('rejects malformed optional JSON before dispatch', async () => {
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
  it('renders writable settings and paused jobs, and confirms source switches through the device receipt', async () => {
    const d = devicesFrom([
      {
        ...device(),
        jobs: [
          { id: 'paused-call', state: 'running', phase: 'paused', startedAt: Date.now(), progress: 0.4 },
        ],
      },
    ])[0]!
    const f = fake()
    f.receipt = {
      state: 'completed',
      operationId: 'configure',
      output: { state: 'terminal', outcome: { status: 'done' } },
    }
    await mount(
      <>
        <DeviceDetail device={d} onBack={() => {}} />
        <Observation
          device={d}
          source={{ id: 'front', kind: 'image', description: 'Camera', switchable: true, default: false }}
        />
      </>,
      f,
    )
    expect(queryByLabelText(host, 'temperature')).toBeNull()
    expect(getByLabelText(host, 'speed')).toBeTruthy()
    await click(getByRole(host, 'button', { name: 'Resume' }))
    expect(f.effects[0]).toMatchObject({
      name: 'mhs.resume',
      input: { device: d.id, params: { call: 'paused-call' } },
    })
    await click(getByRole(host, 'button', { name: 'Turn on' }))
    expect(f.effects.at(-1)).toMatchObject({
      name: 'mhs.configure',
      input: { device: d.id, params: { sources: { front: { on: true } } } },
    })
    expect(queryByRole(host, 'button', { name: 'Turn on' })).toBeNull()
    expect(f.streams.length).toBeGreaterThan(0)
  })
  it('does not repeat an effect after native approval expires', async () => {
    vi.useFakeTimers()
    const f = fake()
    f.receipt = { state: 'approval-required', operationId: 'pending-stop', decisionId: 'decision' }
    await mount(<Stop />, f)
    await click(getByRole(host, 'button', { name: 'Stop all' }))
    expect(host.textContent).toContain('Approval pending')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(751)
    })
    expect(host.textContent).toContain('expired')
    expect(f.effects).toHaveLength(1)
  })
  it.each(['blur', 'space', 'drop', 'disable'])(
    'uses a backend lease and independently stops on %s',
    async (mode) => {
      vi.useFakeTimers()
      const raw = device()
      raw.description = {
        ...raw.description,
        manual: {
          axes: [
            { id: 'vx', min: -1, max: 1, role: 'forward' },
            { id: 'pitch', min: -30, max: 30, role: 'pitch' },
            { id: 'wz', min: -90, max: 90, role: 'turn' },
          ],
          deadman_s: 0.5,
        },
      } as typeof raw.description
      const d = devicesFrom([raw])[0]!,
        f = fake()
      f.receipt = {
        state: 'completed',
        operationId: 'lease',
        output: { operationId: 'lease', expiresAt: Date.now() + 30000 },
      }
      await mount(<Drive device={d} />, f)
      await click(getByRole(host, 'button', { name: 'Request control' }))
      expect(f.opened[0]).toMatchObject({
        name: 'mhs.control',
        input: { device: d.id, leaseId: f.effects[0]?.operationId },
        operationId: f.effects[0]?.operationId,
      })
      expect(getByRole(host, 'button', { name: 'vx / wz' })).toBeTruthy()
      const axis = getByRole(host, 'button', { name: 'vx +' })
      await act(async () => {
        fireEvent.keyDown(axis, {
          key: mode === 'space' ? 'ArrowUp' : 'w',
          code: mode === 'space' ? 'ArrowUp' : 'KeyW',
        })
        await vi.advanceTimersByTimeAsync(40)
      })
      expect(f.stream.sent.at(-1)).toEqual({ type: 'manual', axes: { vx: 1, pitch: 0, wz: 0 } })
      await act(async () => {
        if (mode === 'space') fireEvent.keyDown(axis, { key: ' ', code: 'Space' })
        else if (mode === 'drop') {
          for (const listener of f.stream.drops) listener({ reason: 'backpressure', count: 1 })
        } else if (mode === 'disable') dispose()
        else window.dispatchEvent(new Event('blur'))
        await Promise.resolve()
      })
      expect(f.stream.sent.at(-1)).toEqual({ type: 'manual', axes: { vx: 0, pitch: 0, wz: 0 } })
      expect(f.effects.at(-1)?.name).toBe('mhs.stop')
      expect(f.stream.closed).toBe(true)
    },
  )
  it('keeps global stop available without a session and shows unknown rather than confirmed stopped', async () => {
    const f = fake()
    f.setSession(undefined)
    f.receipt = { state: 'unknown', operationId: 'stop', code: 'dispatch-unconfirmed' }
    await mount(<Stop />, f)
    await click(getByRole(host, 'button', { name: 'Stop all' }))
    expect(f.effects[0]).toMatchObject({ name: 'mhs.stop', input: {} })
    expect(host.textContent).toContain('Outcome unknown')
    await click(getByRole(host, 'button', { name: 'Check status' }))
    expect(host.textContent).toContain('expired')
    expect(f.effects).toHaveLength(1)
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
      launched: string[] = [],
      prepared: string[] = [],
      stopped: string[] = []
    f.ports.examples = {
      list: async () => [{ id: 'mars', name: 'Mars', description: 'Rescue', state: 'disabled' }],
      subscribe: () => () => {},
      inspect: async () => ({ reviewId: 'review', presentation: { devices: 11 } }),
      enable: async (_id, token) => {
        enabled.push(token ?? '')
      },
      stop: async (id) => {
        stopped.push(id)
      },
      prepare: async (_id, launchId) => {
        prepared.push(launchId ?? 'rescue')
        return { launchTicket: 'ticket', presentation: { prompt: 'Rescue' } }
      },
      launch: async (_id, token) => {
        launched.push(token ?? '')
        return undefined
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
        launches: [
          { id: 'rescue', title: 'Rescue Agent' },
          { id: 'sample', title: 'Sample Agent' },
        ],
        Scene: ({ onLaunch }) => (
          <>
            <p>Local Mars scene</p>
            <button type="button" onClick={() => onLaunch?.('sample')}>
              Collect sample
            </button>
          </>
        ),
      },
    ]
    await click(getByRole(host, 'button', { name: 'Retry' }))
    await click(getByRole(host, 'button', { name: 'Rescue Agent' }))
    expect(launched).toEqual([])
    await click(getByRole(host, 'button', { name: 'Run' }))
    expect(launched).toEqual(['ticket'])
    await click(getByRole(host, 'button', { name: 'Open scene' }))
    expect(host.textContent).toContain('Local Mars scene')
    await click(getByRole(host, 'button', { name: 'Collect sample' }))
    expect(prepared).toEqual(['rescue', 'sample'])
    expect(launched).toEqual(['ticket'])
    await click(getByRole(host, 'button', { name: 'Run' }))
    expect(launched).toEqual(['ticket', 'ticket'])
    expect(host.textContent).toContain('Local Mars scene')
    await click(getByRole(host, 'button', { name: 'Examples' }))
    await click(getByRole(host, 'button', { name: 'Stop example' }))
    expect(stopped).toEqual(['mars'])
  })
})
