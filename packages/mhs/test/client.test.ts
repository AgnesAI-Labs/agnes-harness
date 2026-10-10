import { describe, expect, it } from 'vitest'
import {
  alertOf,
  argsText,
  brainCalls,
  keyFields,
  keysOf,
  previewImage,
  sectionOf,
  targetsOf,
  tone,
  untilText,
  worldExtent,
  worldMaps,
} from '../plugin/client/src/core/describe.js'
import type { Device, Field, Manual, Source, Tool } from '../plugin/client/src/core/types.js'
import { en } from '../plugin/client/src/i18n/en.js'
import { setLocale, t, valueText, word } from '../plugin/client/src/i18n/i18n.js'
import { zhCN } from '../plugin/client/src/i18n/zh-CN.js'

function device(fields: Record<string, Field>, extra: Partial<Device> = {}): Device {
  return {
    id: 'thing-01',
    kind: 'thing',
    online: true,
    available: true,
    since: 0,
    state: { fields, values: {}, updated: null, alerts: {} },
    health: { level: 'ok', reasons: [] },
    sources: [],
    ...extra,
  }
}

describe('what a page shows, from declarations only', () => {
  it("lists the brain's device calls of a conversation, newest first", () => {
    const nodes = [
      { kind: 'user' },
      { kind: 'tool', name: 'read_device', toolUseId: 'a' },
      { kind: 'tool', name: 'bash', toolUseId: 'b' },
      { kind: 'tool', name: 'call_device', toolUseId: 'c' },
    ]
    expect(brainCalls(nodes).map((n) => n.toolUseId)).toEqual(['c', 'a'])
  })

  it('shows a live picture on the card only for a device that moves', () => {
    const camera = { id: 'cam', kind: 'video', description: 'camera' } as Source
    const fixed = device(
      {},
      { sources: [camera], position: { trust: 'trusted', map: 'site', x: 1, y: 2, fixed: true } },
    )
    const moving = device({}, { sources: [camera], mobile: true })
    expect(previewImage(fixed)).toBeUndefined()
    expect(previewImage(moving)?.id).toBe('cam')
  })

  it('draws every known map, and maps that positions name without a declaration', () => {
    const site = { map: 'site', name: 'Site', entities: [] }
    const rover = device({}, { id: 'rover-01', position: { trust: 'trusted', map: 'slam-3', x: 1, y: 2 } })
    expect(worldMaps([site], [rover]).map((w) => w.map)).toEqual(['site', 'slam-3'])
  })

  it('shows a map by its bounds, or around everything on it', () => {
    expect(worldExtent({ map: 'a', bounds: [0, 0, 20, 10], entities: [] }, [])).toEqual([0, 0, 20, 10])
    const places = [
      { id: 'gate', name: 'Gate', at: [10, 0] as [number, number] },
      {
        id: 'yard',
        name: 'Yard',
        points: [
          [0, 0],
          [4, 0],
          [4, 4],
        ] as [number, number][],
      },
    ]
    const [x0, y0, x1, y1] = worldExtent({ map: 'b', entities: [], places }, [])
    expect(x0).toBeLessThan(0)
    expect(x1).toBeGreaterThan(10)
    expect(y0).toBeLessThan(0)
    expect(y1).toBeGreaterThan(4)
    expect(worldExtent({ map: 'c', entities: [] }, [])).toEqual([-5, -5, 5, 5])
  })

  it('picks key numbers: tiles first, then fields with a role or an alert, never protocol fields', () => {
    const plain = device({
      problem: { type: 'string' },
      mode: { type: 'string' },
      battery: { type: 'integer', role: 'battery' },
      co2: { type: 'integer', alert: { warn: 1000 } },
      hidden: { type: 'number', role: 'cpu', ui: { hidden: true } },
    })
    expect(keyFields(plain).map(([n]) => n)).toEqual(['battery', 'co2', 'mode'])
    const tiled = device({ a: { type: 'number' }, b: { type: 'number', ui: { tile: true } } })
    expect(keyFields(tiled).map(([n]) => n)).toEqual(['b'])
  })

  it('judges alert levels in both directions', () => {
    const low: Field = { type: 'integer', alert: { warn: 20, bad: 10, below: true } }
    const high: Field = { type: 'number', alert: { warn: 70, bad: 85 } }
    expect([alertOf(low, 50), alertOf(low, 15), alertOf(low, 5)]).toEqual([undefined, 'warn', 'bad'])
    expect([alertOf(high, 60), alertOf(high, 72), alertOf(high, 90)]).toEqual([undefined, 'warn', 'bad'])
    expect(alertOf(undefined, 99)).toBeUndefined()
  })

  it('colours the status bar by availability, health, pause and work', () => {
    expect(tone(device({}))).toBe('ok')
    expect(tone(device({}, { available: false }))).toBe('off')
    expect(tone(device({}, { health: { level: 'bad', reasons: [] } }))).toBe('bad')
    const job = { job: 'j1', tool: 'x', caller: 'brain', started: 0 }
    expect(tone(device({}, { jobs: [{ ...job, state: 'running' }] }))).toBe('busy')
    expect(tone(device({}, { jobs: [{ ...job, state: 'paused' }] }))).toBe('warn')
  })

  it('writes arguments with the labels a tool declares', () => {
    const tool: Tool = {
      name: 'go',
      description: '',
      timeout: 5,
      inputSchema: { type: 'object', properties: { alt: { type: 'number', ui: { label: 'altitude' } } } },
    }
    expect(argsText(tool, { alt: 5.123, where: [1, 2], mode: 'fast' })).toBe(
      'altitude 5.12 · where (1, 2) · mode fast',
    )
    expect(argsText(undefined, {})).toBe('')
    expect(
      argsText(undefined, {
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      }),
    ).toBe('points 2 items')
  })

  it('puts sources in sections by kind unless the device groups them', () => {
    const s = (kind: string, group?: string): Source => ({
      id: kind,
      kind,
      description: '',
      ...(group ? { ui: { group } } : {}),
    })
    expect(
      ['video', 'scan', 'pose', 'values', 'audio', 'transcript', 'x_custom'].map((k) => sectionOf(s(k))),
    ).toEqual(['picture', 'ranging', 'place', 'telemetry', 'sound', 'text', 'other'])
    expect(sectionOf(s('values', 'power'))).toBe('power')
  })

  it('finds map targets and routes in job arguments', () => {
    expect(targetsOf({ x: 1, y: 2 })).toEqual({ point: [1, 2] })
    expect(targetsOf({ target: { x: 3, y: 4 } })).toEqual({ point: [3, 4] })
    expect(targetsOf({ route: [[0, 0], { x: 1, y: 1 }, [2, 0]] })).toEqual({
      route: [
        [0, 0],
        [1, 1],
        [2, 0],
      ],
    })
    expect(targetsOf({ text: 'hello' })).toEqual({})
  })

  it('writes watch conditions in words', () => {
    expect(untilText({ state: 'battery', lt: 20 })).toBe('battery < 20')
    expect(untilText({ source: 'air', field: 'co2', gt: 1000 })).toBe('air.co2 > 1000')
    expect(untilText({ health: 'bad' })).toBe('health bad')
  })

  it('binds keys by role, declared keys first, arrows like WASD without pitch and yaw', () => {
    const manual: Manual = {
      rate_hz: 10,
      deadman_s: 0.5,
      axes: [
        { id: 'vx', role: 'forward', unit: 'm/s', min: -1, max: 1 },
        { id: 'wz', role: 'turn', unit: 'deg/s', min: -90, max: 90 },
        { id: 'z', role: 'up', unit: 'm/s', min: -1, max: 1, keys: ['i', 'k'] },
        { id: 'j1', role: 'joint', joint: 1, unit: 'deg/s', min: -1, max: 1 },
      ],
    }
    const keys = keysOf(manual)
    expect(keys.get('w')).toEqual(['vx', 1])
    expect(keys.get('d')).toEqual(['wz', -1])
    expect(keys.get('i')).toEqual(['z', 1])
    expect(keys.get('arrowup')).toEqual(['vx', 1])
    expect([...keys.values()].some(([id]) => id === 'j1')).toBe(false)
  })
})

describe('language', () => {
  it('has every Chinese key in English, and falls back to English', () => {
    for (const key of Object.keys(zhCN)) expect(en).toHaveProperty(key)
    setLocale('zh-CN')
    expect(t('device.stop')).toBe('停止')
    expect(t('app.expand')).toBe('展开')
    expect(word('reason', 'x_custom_reason')).toBe('x_custom_reason')
    setLocale('en')
    expect(t('overview.online', { n: 2, total: 3 })).toBe('2/3 online')
    expect(valueText(64, '%')).toBe('64 %')
    expect(valueText(12.345, '°C')).toBe('12.3 °C')
    // A time in seconds reads as a clock time with how far away it is.
    expect(valueText(Date.now() / 1000 + 125, 's')).toMatch(/^\d\d:\d\d:\d\d · in 2 min\.?$/)
  })
})
