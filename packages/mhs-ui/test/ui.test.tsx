// @vitest-environment happy-dom

import { encodeMedia } from '@agnes/mhs-hub/media'
import { fireEvent, getByLabelText, getByRole, queryByLabelText, queryByRole } from '@testing-library/dom'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MhsClient } from '../src/client.js'
import { ClipSender, pcmWav } from '../src/clips.js'
import { DeviceDetail } from '../src/detail.js'
import { DeveloperPage } from '../src/developer.js'
import { Drive } from '../src/drive.js'
import { ExamplesPage } from '../src/examples.js'
import { alertLevel, Fields, keyFields, sourceGroup } from '../src/fields.js'
import { ToolForm } from '../src/forms.js'
import { gridBounds, MapGrid } from '../src/grid.js'
import { catalog, translate } from '../src/locales.js'
import { axisKeys } from '../src/manual.js'
import { pickValue, WorldMap } from '../src/map.js'
import { devicesFrom } from '../src/model.js'
import { MhsPage } from '../src/page.js'
import { MhsProvider, Stop } from '../src/react.js'
import { MhsStore } from '../src/store.js'
import { pointCloud } from '../src/telemetry.js'
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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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
          { id: 'running-call', state: 'running', phase: 'running' },
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
    expect(getByRole(host, 'spinbutton', { name: 'speed' })).toBeTruthy()
    await click(getByRole(host, 'button', { name: 'Resume' }))
    expect(f.effects[0]).toMatchObject({
      name: 'mhs.resume',
      input: { device: d.id, params: { call: 'paused-call' } },
    })
    await click(getByRole(host, 'button', { name: 'Pause' }))
    expect(f.effects.at(-1)).toMatchObject({
      name: 'mhs.pause',
      input: { device: d.id, params: { call: 'running-call' } },
    })
    await click(getByRole(host, 'button', { name: 'Turn on' }))
    expect(f.effects.at(-1)).toMatchObject({
      name: 'mhs.configure',
      input: { device: d.id, params: { sources: { front: { on: true } } } },
    })
    expect(queryByRole(host, 'button', { name: 'Turn on' })).toBeNull()
    expect(f.streams.length).toBeGreaterThan(0)
  })
  it('sends a bounded PCM16 WAV only under its approved clip grant and waits for cache acknowledgement', async () => {
    const wav = new Uint8Array(48),
      view = new DataView(wav.buffer)
    const tag = (at: number, value: string) => wav.set(new TextEncoder().encode(value), at)
    tag(0, 'RIFF')
    view.setUint32(4, 40, true)
    tag(8, 'WAVE')
    tag(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, 24000, true)
    view.setUint32(28, 48000, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    tag(36, 'data')
    view.setUint32(40, 4, true)
    wav.set([1, 0, 2, 0], 44)
    expect(pcmWav(wav)).toMatchObject({ rate: 24000, channels: 1, pcm: new Uint8Array([1, 0, 2, 0]) })
    const bad = wav.slice()
    new DataView(bad.buffer).setUint16(34, 8, true)
    expect(() => pcmWav(bad)).toThrow('pcm16-required')
    const f = fake(),
      received = vi.fn()
    f.ports.services.effect = async (name, input, { operationId }) => {
      f.effects.push({ name, input, operationId })
      return { state: 'completed', operationId, output: { operationId, expiresAt: Date.now() + 30000 } }
    }
    await mount(<ClipSender device="rover-01" onSent={received} />, f)
    const file = new File([wav], 'voice.wav', { type: 'audio/wav' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => wav.buffer })
    await act(async () => {
      fireEvent.change(getByLabelText(host, 'PCM16 WAV clip (up to 1 MiB)'), { target: { files: [file] } })
    })
    await vi.waitFor(() =>
      expect(getByRole(host, 'button', { name: 'Approve and send clip' }).hasAttribute('disabled')).toBe(
        false,
      ),
    )
    await click(getByRole(host, 'button', { name: 'Approve and send clip' }))
    expect(f.effects[0]).toMatchObject({
      name: 'mhs.clip',
      input: {
        device: 'rover-01',
        params: { bytes: 4, rate: 24000, channels: 1, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      },
    })
    expect(f.opened.at(-1)).toMatchObject({
      name: 'mhs.clip',
      input: {},
      operationId: f.effects[0]?.operationId,
    })
    expect(f.stream.sent).toEqual([new Uint8Array([1, 0, 2, 0])])
    expect(received).not.toHaveBeenCalled()
    await act(async () => {
      f.stream.emit({ state: 'sent', id: 'voice' })
    })
    expect(received).toHaveBeenCalledOnce()
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
          key: 'w',
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
    const routeDevice = devicesFrom([device()])[0]!
    routeDevice.jobs = [
      {
        id: 'navigation',
        state: 'running',
        navigation: {
          route: [
            [2, 3],
            [5, 6],
          ],
          target: [5, 6],
        },
      },
    ]
    await mount(
      <WorldMap
        maps={[{ id: 'site', bounds: [0, 0, 10, 10] }]}
        devices={[routeDevice]}
        mode="pose"
        onPick={(v) => picked.push(v)}
        onCancel={cancel}
      />,
    )
    expect(host.querySelector('g[aria-label="rover-01 route"] polyline')?.getAttribute('points')).toBe(
      '10,80 20,70 50,40',
    )
    expect(host.querySelector('g[aria-label="rover-01 route"] circle')?.getAttribute('cx')).toBe('50')
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

describe('declaration-driven MHS observation inventory', () => {
  const rows = [
    ['scan', { angle_min: 90, angle_inc: 1, ranges: [1, null, 2] }, 'svg'],
    ['points', { n: 1, fields: ['z', 'x', 'y'] }, 'svg'],
    ['pose', { map: 'site', x: 1, y: 2, yaw: 45, ok: true }, 'svg'],
    ['world', { map: 'site', entities: [{ device: 'other', x: 3, y: 4, yaw: 90, ok: true }] }, 'svg'],
    ['odometry', { x: 1, y: 2, yaw: 3, v: 4, w: 5 }, 'svg'],
    ['imu', { accel: [1, 2, 3], gyro: [0, 0, 1], rpy: [0, 0, 0.4] }, 'svg'],
    ['gnss', { lat: 20, lon: 30, fix: 'rtk', acc_m: 0.2 }, 'dl'],
    ['detections', { w: 640, h: 360, items: [{ label: 'rock', conf: 0.8, box: [1, 2, 20, 30] }] }, 'rect'],
    ['values', { temperature: 20 }, 'dl'],
    ['switch', { temperature: true }, 'dl'],
    ['text', { text: 'hello' }, '[role="log"]'],
    ['transcript', { text: 'hello', final: false, start: 0, end: 1 }, '[role="log"]'],
    ['x_custom', { raw: ['payload'] }, 'pre'],
  ] as const
  it.each(rows)(
    'renders actual binary MOS %s frames and releases the subscription',
    async (kind, data, selector) => {
      const d = devicesFrom([device()])[0]!,
        f = fake()
      await mount(
        <Observation
          device={d}
          source={{
            id: 'source',
            kind,
            description: kind,
            fields: { temperature: { type: 'number', unit: '°C' } },
          }}
        />,
        f,
      )
      const bytes = kind === 'points' ? new Uint8Array(new Float32Array([3, 1, 2]).buffer) : undefined
      const frame = encodeMedia({
        device: d.id,
        source: 'source',
        at: Date.now(),
        data: JSON.parse(JSON.stringify(data)),
        ...(bytes ? { bytes } : {}),
      })
      await act(async () => {
        for (const listener of f.stream.frames) listener(frame)
      })
      expect(host.querySelector(selector)).toBeTruthy()
      if (kind === 'points') expect(host.querySelector('circle')?.getAttribute('cx')).toBe('1')
      if (kind === 'detections') {
        expect(host.textContent).toContain('rock 80%')
        expect(host.querySelector('rect')?.getAttribute('width')).toBe('19')
      }
      if (kind === 'scan') expect(Number(host.querySelector('circle')?.getAttribute('cx'))).toBeCloseTo(0)
      if (kind === 'gnss') expect(host.textContent).toContain('GNSS rtk')
      await act(async () => root.render(null))
      expect(f.stream.closed).toBe(true)
    },
  )
  it.each(['image', 'grid'])('releases %s object URLs on frame replacement and unmount', async (kind) => {
    const create = vi.fn(() => 'blob:sample'),
      revoke = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }))
    const d = devicesFrom([device()])[0]!,
      f = fake()
    await mount(<Observation device={d} source={{ id: 'source', kind, description: kind }} />, f)
    await act(async () => {
      for (const listener of f.stream.frames)
        listener(
          encodeMedia({
            device: d.id,
            source: 'source',
            at: Date.now(),
            mime: 'image/png',
            bytes: new Uint8Array([137, 80, 78, 71]),
            data: kind === 'grid' ? { id: 'site', resolution: 0.5, origin: [1, 2] } : { w: 1, h: 1 },
          }),
        )
    })
    expect(getByRole(host, 'img')).toBeTruthy()
    await click(getByRole(host, 'button', { name: 'Zoom' }))
    expect(host.querySelector('img')?.className).toBe('mhs-picture-zoom')
    await act(async () => root.render(null))
    expect(revoke).toHaveBeenCalledWith('blob:sample')
    vi.unstubAllGlobals()
  })
  it('uses labels, units, hidden fields, bounded gauges and both alert directions', async () => {
    await mount(
      <Fields
        fields={{
          o2: {
            type: 'number',
            min: 0,
            max: 100,
            role: 'consumable',
            of: 'oxygen',
            unit: '%',
            alert: { warn: 25, bad: 10, below: true },
          },
          secret: { ui: { hidden: true } },
        }}
        values={{ o2: 10, secret: 9 }}
      />,
    )
    expect(getByRole(host, 'meter', { name: 'oxygen' })).toBeTruthy()
    expect(host.textContent).toContain('10 %')
    expect(host.textContent).not.toContain('secret')
    expect(host.querySelector('[data-alert="bad"]')).toBeTruthy()
    expect(alertLevel({ alert: { warn: 25, bad: 10, below: true } }, 25)).toBe('attention')
    expect(alertLevel({ alert: { warn: 25, bad: 10, below: true } }, 26)).toBe('ok')
    expect(alertLevel({ alert: { warn: 70, bad: 90 } }, 90)).toBe('bad')
    expect(() =>
      pointCloud({
        device: 'd',
        source: 's',
        at: 1,
        mime: '',
        rawData: {},
        data: { n: 2, fields: ['x', 'y', 'z'] },
        bytes: new Uint8Array(1),
      }),
    ).toThrow('invalid-points')
    expect(Object.keys(catalog.en).sort()).toEqual(Object.keys(catalog['zh-CN']).sort())
    expect(translate('unknown', 'stop')).toBe(catalog.en.stop)
    expect(
      keyFields({
        plain: {},
        battery: { role: 'battery' },
        problem: {},
        hidden: { role: 'cpu', ui: { hidden: true } },
      }).map(([k]) => k),
    ).toEqual(['battery', 'plain'])
    expect(keyFields({ a: {}, b: { ui: { tile: true } } }).map(([k]) => k)).toEqual(['b'])
    expect(sourceGroup({ kind: 'grid' })).toBe('ranging')
    expect(sourceGroup({ kind: 'values', ui: { group: 'power' } })).toBe('power')
    const keys = axisKeys([
      { id: 'move', min: -1, max: 1, role: 'forward', keys: ['U', 'N'] },
      { id: 'pitch', min: -1, max: 1, role: 'pitch' },
    ])
    expect(keys.get('u')).toEqual(['move', 1])
    expect(keys.get('w')).toBeUndefined()
    expect(keys.get('arrowup')).toEqual(['pitch', 1])
    expect(axisKeys([{ id: 'move', min: -1, max: 1, role: 'forward' }]).get('arrowup')).toEqual(['move', 1])
  })
})

it('decodes PCM for explicit listening and closes live audio on unmount', async () => {
  let stopped = false,
    closed = false,
    channels: Float32Array[] = []
  vi.stubGlobal(
    'AudioContext',
    class {
      destination = {}
      async resume() {}
      async close() {
        closed = true
      }
      createBuffer(count: number, length: number) {
        channels = Array.from({ length: count }, () => new Float32Array(length))
        return { getChannelData: (i: number) => channels[i] }
      }
      createBufferSource() {
        return {
          buffer: undefined,
          onended: undefined,
          connect() {},
          start() {},
          stop() {
            stopped = true
          },
        }
      }
    },
  )
  const d = devicesFrom([device()])[0]!,
    f = fake()
  await mount(
    <Observation device={d} source={{ id: 'audio', kind: 'audio', description: 'Microphone' }} />,
    f,
  )
  await click(getByRole(host, 'button', { name: 'Listen' }))
  const bytes = new Uint8Array([0, 64, 0, 192])
  await act(async () => {
    for (const listener of f.stream.frames)
      listener(
        encodeMedia({
          device: d.id,
          source: 'audio',
          at: Date.now(),
          data: { rate: 16000, channels: 1 },
          bytes,
        }),
      )
  })
  expect([...channels[0]!]).toEqual([0.5, -0.5])
  await act(async () => root.render(null))
  expect(stopped).toBe(true)
  expect(closed).toBe(true)
  vi.unstubAllGlobals()
})
it('submits advanced Hub mode through the reviewed developer port and can return to local mode', async () => {
  vi.useFakeTimers()
  const f = fake(),
    configured: unknown[] = []
  let remote = false
  f.ports.developer = {
    status: async () => ({
      state: 'ready',
      mode: remote ? 'external' : 'local',
      devicePort: 'auto',
      ...(remote
        ? { address: 'wss://192.0.2.10/mhs-peer/v1', allowlist: ['wss://192.0.2.10/mhs-peer/v1'] }
        : {}),
    }),
    retry: async () => {},
    check: async () => [],
    configure: async (port, external) => {
      configured.push({ port, external })
      remote = external !== undefined
    },
  }
  await mount(<DeveloperPage />, f)
  host.querySelector('details')!.open = true
  await act(async () => fireEvent.change(getByLabelText(host, 'Hub mode'), { target: { value: 'external' } }))
  await act(async () =>
    fireEvent.change(getByLabelText(host, 'External peer address'), {
      target: { value: 'wss://192.0.2.10/mhs-peer/v1' },
    }),
  )
  expect(getByRole(host, 'button', { name: 'Hub listener settings' }).hasAttribute('disabled')).toBe(true)
  await act(async () =>
    fireEvent.change(getByLabelText(host, 'Reviewed endpoint allowlist (one per line)'), {
      target: { value: 'wss://192.0.2.10/mhs-peer/v1' },
    }),
  )
  await click(getByRole(host, 'button', { name: 'Hub listener settings' }))
  expect(configured[0]).toEqual({
    port: 'auto',
    external: { address: 'wss://192.0.2.10/mhs-peer/v1', allowlist: ['wss://192.0.2.10/mhs-peer/v1'] },
  })
  await act(async () => {
    fireEvent.change(getByLabelText(host, 'External peer address'), {
      target: { value: 'wss://192.0.2.11/mhs-peer/v1' },
    })
    await vi.advanceTimersByTimeAsync(1001)
  })
  expect(host.querySelector('details')?.open).toBe(true)
  expect((getByLabelText(host, 'External peer address') as HTMLInputElement).value).toBe(
    'wss://192.0.2.11/mhs-peer/v1',
  )
  await act(async () => fireEvent.change(getByLabelText(host, 'Hub mode'), { target: { value: 'local' } }))
  await click(getByRole(host, 'button', { name: 'Hub listener settings' }))
  expect(configured[1]).toEqual({ port: 'auto', external: undefined })
})

it('projects binary occupancy into its map frame and revokes the background on detach', async () => {
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:grid'),
    revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const d = devicesFrom([device()])[0]!,
    f = fake(),
    bytes = new Uint8Array(24)
  bytes.set([137, 80, 78, 71])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, 10)
  view.setUint32(20, 20)
  const sample = {
    device: d.id,
    source: 'grid',
    at: Date.now(),
    data: { id: 'site', resolution: 0.5, origin: [1, 2] },
    mime: 'image/png',
    rawData: {},
    bytes,
  }
  expect(gridBounds(sample)).toEqual([1, 2, 6, 12])
  await mount(
    <svg role="img" aria-label="Occupancy map">
      <MapGrid map="site" device={d} source="grid" xy={(x, y) => [x, 100 - y]} />
    </svg>,
    f,
  )
  await act(async () => {
    for (const listener of f.stream.frames) listener(encodeMedia(sample))
  })
  expect(host.querySelector('image')?.getAttribute('x')).toBe('1')
  expect(host.querySelector('image')?.getAttribute('y')).toBe('88')
  expect(host.querySelector('image')?.getAttribute('height')).toBe('10')
  expect(create).toHaveBeenCalled()
  await act(async () => root.render(null))
  expect(revoke).toHaveBeenCalledWith('blob:grid')
  expect(f.stream.closed).toBe(true)
})
