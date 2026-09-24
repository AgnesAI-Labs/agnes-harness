import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { parseCaptureResult } from '@agnes/base/computer-use'
import type { JsonValue } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { closeOwnedFakeProcess } from '../../src/computer-use/fake/connection.js'
import type { OwnedFakeProcess } from '../../src/computer-use/fake/owned-process.js'
import {
  PosixDescendantTracker,
  PosixRootGroupOwner,
} from '../../src/computer-use/fake/posix-process-tree.js'
import {
  type ComputerUseResetReason,
  createFakeComputerUseSessionRuntime,
  type DriverCloseEvent,
  type FakeComputerUseDriverConnection,
  normalizeFakeObserveResult,
} from '../../src/computer-use/fake/session-runtime.js'

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-driver-child.mjs')
const tempDirs: string[] = []
const runtimes: Array<{ dispose(): Promise<void> }> = []

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function harness(mode = 'normal', startupTimeoutMs = 2_000) {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-cua-fake-'))
  tempDirs.push(dir)
  const logFile = join(dir, 'child.jsonl')
  const runtime = createFakeComputerUseSessionRuntime({
    command: process.execPath,
    args: [fixture],
    env: { AGNES_CUA_FAKE_MODE: mode, AGNES_CUA_FAKE_LOG: logFile },
    startupTimeoutMs,
    closeGraceMs: 100,
  })
  runtimes.push(runtime)
  return { runtime, logFile }
}

type ChildEvent = {
  pid: number
  sessionToken: string
  event: string
  grandchildPid?: number
  name?: string
  args?: Record<string, unknown>
  captureScope?: string
}

function events(logFile: string): ChildEvent[] {
  try {
    return readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ChildEvent)
  } catch {
    return []
  }
}

async function waitForEvent(logFile: string, event: string): Promise<ChildEvent> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = events(logFile).find((item) => item.event === event)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`fake child never logged ${event}`)
}

async function expectProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0)
      await new Promise((resolve) => setTimeout(resolve, 5))
    } catch {
      return
    }
  }
  throw new Error(`process ${pid} is still alive`)
}

const session = (key: string, lane = 'main') => ({ key, lane })
const call = (connection: FakeComputerUseDriverConnection, signal = new AbortController().signal) =>
  connection.call(
    'capture',
    { target: 'front', generation: connection.generation },
    { timeoutMs: 500, signal },
  )

const validCapture = (overrides: Record<string, JsonValue> = {}) => ({
  mode: 'som',
  width: 1,
  height: 1,
  target: { app: 'Fake Notes', pid: 4101, window_id: 5101, snapshot_id: 'snapshot-1' },
  elements: [
    {
      index: 1,
      role: 'button',
      label: 'Save',
      bounds: [100, 120, 80, 24],
      element_token: 'element-1',
    },
  ],
  ...overrides,
})

describe('typed Computer Use stdio fake runtime', () => {
  it('accepts a valid frame large enough for the configured 4 MiB decoded screenshot cap', async () => {
    const { runtime } = harness('normal-large-frame')
    const connection = await runtime.open(session('large-frame'), new AbortController().signal)
    await expect(call(connection)).resolves.toMatchObject({ isError: false })
  })

  it('accepts the locked 0.28.1 capability version at tools/list instead of inventing per-tool fields', async () => {
    const { runtime } = harness('real-contract')
    const connection = await runtime.open(session('real-contract'), new AbortController().signal)
    expect(connection.capabilityVersion).toBe('1')
    expect(connection.catalog.get('capture')).toMatchObject({
      name: 'capture',
      capabilityVersion: '1',
      capabilities: ['capture', 'structured-content'],
    })
  })

  it('signals a POSIX process group only while the captured root identity still matches', async () => {
    const signals: Array<readonly [number, string]> = []
    const reused = new PosixRootGroupOwner(
      42,
      'root-start',
      { os: 'darwin' },
      {
        identity: async () => ({ state: 'alive', startId: 'reused-start' }),
        kill: (pid, signal) => signals.push([pid, signal]),
      },
    )
    await expect(reused.signal('SIGTERM')).resolves.toBe(false)
    expect(signals).toEqual([])

    const owned = new PosixRootGroupOwner(
      42,
      'root-start',
      { os: 'darwin' },
      {
        identity: async () => ({ state: 'alive', startId: 'root-start' }),
        kill: (pid, signal) => signals.push([pid, signal]),
      },
    )
    await expect(owned.signal('SIGKILL')).resolves.toBe(true)
    expect(signals).toEqual([[-42, 'SIGKILL']])
  })

  it('does not seed descendant capture from a reused root PID', async () => {
    const signals: Array<readonly [number, string]> = []
    const tracker = new PosixDescendantTracker(
      42,
      'owned-root',
      { os: 'darwin' },
      {
        processTable: async () => [{ pid: 99, parentPid: 42 }],
        identity: async (pid) =>
          pid === 42
            ? { state: 'alive', startId: 'reused-root' }
            : { state: 'alive', startId: `child-${pid}` },
        kill: (pid, signal) => signals.push([pid, signal]),
      },
    )
    await tracker.capture()
    await tracker.signal('SIGKILL')
    expect(signals).toEqual([])

    const owned = new PosixDescendantTracker(
      42,
      'owned-root',
      { os: 'darwin' },
      {
        processTable: async () => [{ pid: 99, parentPid: 42 }],
        identity: async (pid) =>
          pid === 42 ? { state: 'alive', startId: 'owned-root' } : { state: 'alive', startId: 'child-99' },
        kill: (pid, signal) => signals.push([pid, signal]),
      },
    )
    await owned.capture()
    await owned.signal('SIGTERM')
    expect(signals).toEqual([[99, 'SIGTERM']])
  })

  it('continues stdin and TERM/KILL cleanup after descendant capture fails', async () => {
    const stdin = new PassThrough()
    const signals: string[] = []
    const child: OwnedFakeProcess = {
      pid: 42,
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      completion: Promise.resolve({}),
      captureDescendants: async () => {
        throw new Error('injected process-table failure')
      },
      terminate: async (signal) => {
        signals.push(signal)
      },
      waitForTreeExit: async () => true,
    }
    await expect(closeOwnedFakeProcess(child, 1)).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [expect.objectContaining({ message: 'injected process-table failure' })],
    })
    expect(stdin.writableEnded).toBe(true)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('does not wait forever for completion after signal and tree-exit failures', async () => {
    const stdin = new PassThrough()
    const signals: string[] = []
    const never = new Promise<Readonly<{ error?: Error }>>(() => undefined)
    const child: OwnedFakeProcess = {
      pid: 42,
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      completion: never,
      captureDescendants: async () => undefined,
      terminate: async (signal) => {
        signals.push(signal)
        throw new Error(`injected ${signal} failure`)
      },
      waitForTreeExit: async () => false,
    }
    await expect(closeOwnedFakeProcess(child, 1)).rejects.toMatchObject({
      name: 'AggregateError',
      errors: expect.arrayContaining([
        expect.objectContaining({ message: 'injected SIGTERM failure' }),
        expect.objectContaining({ message: 'injected SIGKILL failure' }),
        expect.objectContaining({ message: 'fake Computer Use child tree cleanup timed out' }),
      ]),
    })
    expect(stdin.writableEnded).toBe(true)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('performs initialize/list/call/close and preserves structuredContent plus catalog metadata', async () => {
    const { runtime, logFile } = harness()
    const connection = await runtime.open(session('s1'), new AbortController().signal)

    expect(connection.generation).toBe(1)
    expect(connection.capabilityVersion).toBe('1')
    expect([...connection.catalog]).toEqual([
      [
        'capture',
        expect.objectContaining({
          name: 'capture',
          capabilities: ['capture', 'structured-content'],
          capabilityVersion: '1',
          inputSchema: expect.objectContaining({
            type: 'object',
            properties: expect.objectContaining({
              mode: { enum: ['som', 'vision', 'ax'] },
              generation: { type: 'integer', minimum: 1 },
              pid: { type: 'integer', minimum: 1 },
              window_id: { type: 'integer', minimum: 1 },
            }),
            additionalProperties: false,
          }),
        }),
      ],
      [
        'list_apps',
        expect.objectContaining({
          name: 'list_apps',
          capabilities: ['observe', 'structured-content'],
          capabilityVersion: '1',
        }),
      ],
      [
        'list_windows',
        expect.objectContaining({
          name: 'list_windows',
          capabilities: ['observe', 'structured-content'],
          capabilityVersion: '1',
        }),
      ],
      [
        'get_capture_scope',
        expect.objectContaining({
          name: 'get_capture_scope',
          capabilities: ['screen-compound'],
          capabilityVersion: '1',
        }),
      ],
      [
        'set_capture_scope',
        expect.objectContaining({
          name: 'set_capture_scope',
          capabilities: ['screen-compound'],
          capabilityVersion: '1',
          inputSchema: expect.objectContaining({ required: ['scope'], additionalProperties: false }),
        }),
      ],
    ])
    const output = await call(connection)
    const structured = output.structuredContent as Record<string, unknown>
    expect(structured.sessionToken).toEqual(expect.stringMatching(/^[a-f0-9]{48}$/))
    expect(structured.sessionToken).not.toContain('s1')
    expect(output).toMatchObject({
      content: [
        { type: 'text', text: `capture:${structured.sessionToken as string}` },
        { type: 'image', mimeType: 'image/png' },
      ],
      structuredContent: {
        pid: connection.pid,
        mode: 'som',
        width: 1,
        height: 1,
        target: { app: 'Fake Notes', pid: 4101, window_id: 5101, requested: 'front' },
        elements: [{ index: 1, role: 'button', label: 'Save' }],
        generationEcho: 1,
      },
      isError: false,
    })

    await runtime.close(session('s1'), 'session_end')
    expect(events(logFile).map((event) => event.event)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
      'tool',
      'close',
    ])
    expect(() => process.kill(connection.pid, 0)).toThrow()
  })

  it('returns typed app/window inventories and distinct SOM/AX capture shapes', async () => {
    const { runtime } = harness()
    const connection = await runtime.open(session('observe'), new AbortController().signal)
    const signal = new AbortController().signal
    const apps = await connection.call('list_apps', {}, { timeoutMs: 500, signal })
    const windows = await connection.call('list_windows', { pid: 777 }, { timeoutMs: 500, signal })
    const ax = await connection.call('capture', { mode: 'ax' }, { timeoutMs: 500, signal })
    const noArtifacts = {
      put: async () => {
        throw new Error('typed list results cannot persist artifacts')
      },
    }
    const normalizedApps = await normalizeFakeObserveResult('list_apps', apps, noArtifacts)
    const normalizedWindows = await normalizeFakeObserveResult('list_windows', windows, noArtifacts)
    const normalizedAx = await normalizeFakeObserveResult('capture', ax, noArtifacts)

    expect(apps).toMatchObject({
      content: [{ type: 'text', text: '1 application' }],
      structuredContent: { apps: [{ app: 'Fake Notes', pid: 4101, frontmost: true }] },
      isError: false,
    })
    expect(windows).toMatchObject({
      structuredContent: {
        windows: [
          {
            app: 'Fake Notes',
            pid: 777,
            window_id: 5101,
            title: 'Fake document',
            bounds: [20, 30, 640, 480],
          },
        ],
      },
      isError: false,
    })
    expect(ax).toMatchObject({
      content: [{ type: 'text' }],
      structuredContent: {
        mode: 'ax',
        width: 0,
        height: 0,
        target: { app: 'Fake Notes', pid: 4101, window_id: 5101 },
        elements: [{ index: 1, role: 'button', element_token: expect.any(String) }],
      },
      isError: false,
    })
    expect(ax.content).toHaveLength(1)
    expect(normalizedApps.structuredContent).toEqual({
      apps: [{ app: 'Fake Notes', pid: 4101, frontmost: true }],
    })
    expect(normalizedWindows.structuredContent).toEqual({
      windows: [
        {
          app: 'Fake Notes',
          pid: 777,
          window_id: 5101,
          title: 'Fake document',
          bounds: [20, 30, 640, 480],
        },
      ],
    })
    expect(normalizedAx.structuredContent).toMatchObject({ mode: 'ax', width: 0, height: 0 })
  })

  it('maps frontmost/app/pid/window/screen/desktop capture targets without retargeting', async () => {
    const { runtime } = harness()
    const ref = session('targets')
    await runtime.open(ref, new AbortController().signal)
    const options = { timeoutMs: 500, signal: new AbortController().signal }
    const cases = [
      [{ kind: 'frontmost' as const }, { app: 'Fake Notes', pid: 4101, window_id: 5101 }],
      [
        { kind: 'app' as const, app: 'Mail' },
        { app: 'Mail', pid: 4101, window_id: 5101 },
      ],
      [
        { kind: 'pid' as const, pid: 7001 },
        { app: 'Fake Notes', pid: 7001, window_id: 5101 },
      ],
      [
        { kind: 'window' as const, pid: 7001, windowId: 8001 },
        { app: 'Fake Notes', pid: 7001, window_id: 8001 },
      ],
      [{ kind: 'screen' as const }, { app: 'screen' }],
      [{ kind: 'desktop' as const }, { app: 'desktop' }],
    ] as const

    const snapshots = new Set<string>()
    for (const [target, expected] of cases) {
      const result = await runtime.captureObserve(ref, { mode: 'ax', target }, options)
      expect(result.structuredContent).toMatchObject({ target: expected })
      const structured = result.structuredContent as { target: { snapshot_id: string } }
      snapshots.add(structured.target.snapshot_id)
    }
    expect(snapshots.size).toBe(cases.length)
  })

  it('rejects an unbound session before any driver call or lifecycle close', async () => {
    const { runtime, logFile } = harness()
    const bound = session('bound', 'a')
    const connection = await runtime.open(bound, new AbortController().signal)
    const closed: DriverCloseEvent[] = []
    connection.onClose((event) => closed.push(event))
    const before = events(logFile).length
    await expect(
      runtime.captureObserve(
        session('bound', 'b'),
        { mode: 'ax', target: { kind: 'screen' } },
        { timeoutMs: 500, signal: new AbortController().signal },
      ),
    ).rejects.toThrow('no open fake runtime')
    expect(events(logFile)).toHaveLength(before)
    expect(closed).toEqual([])
    await expect(
      runtime.captureObserve(
        bound,
        { mode: 'ax', target: { kind: 'frontmost' } },
        { timeoutMs: 500, signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ isError: false })
  })

  it('does not interleave two observe calls in the same session', async () => {
    const { runtime, logFile } = harness()
    const ref = session('observe-lock')
    await runtime.open(ref, new AbortController().signal)
    const options = { timeoutMs: 500, signal: new AbortController().signal }
    const screen = runtime.captureObserve(ref, { mode: 'ax', target: { kind: 'screen' } }, options)
    await expect(
      runtime.captureObserve(ref, { mode: 'ax', target: { kind: 'frontmost' } }, options),
    ).rejects.toThrow('already has a fake observe call in progress')
    await expect(screen).resolves.toMatchObject({ isError: false })
    expect(
      events(logFile)
        .filter((event) => event.event === 'tool')
        .map((event) => event.name),
    ).toEqual(['get_capture_scope', 'set_capture_scope', 'capture', 'set_capture_scope'])
  })

  it('runs screen capture as baseline/set/capture/restore exactly once', async () => {
    const { runtime, logFile } = harness()
    const ref = session('screen-compound')
    await runtime.open(ref, new AbortController().signal)
    await expect(
      runtime.captureObserve(
        ref,
        { mode: 'ax', target: { kind: 'screen' } },
        { timeoutMs: 500, signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ isError: false })
    expect(
      events(logFile)
        .filter((event) => event.event === 'tool')
        .map((event) => event.name),
    ).toEqual(['get_capture_scope', 'set_capture_scope', 'capture', 'set_capture_scope'])
    expect(
      events(logFile)
        .filter((event) => event.name === 'set_capture_scope')
        .map((event) => event.args),
    ).toEqual([{ scope: 'screen' }, { scope: 'window' }])
  })

  it('tears down screen generation on get/set/capture/restore failure without replay', async () => {
    for (const mode of ['screen-get-fail', 'screen-set-fail', 'screen-capture-fail', 'screen-restore-fail']) {
      const { runtime, logFile } = harness(mode)
      const ref = session(mode)
      const connection = await runtime.open(ref, new AbortController().signal)
      const closed = new Promise<DriverCloseEvent>((resolve) => connection.onClose(resolve))
      await expect(
        runtime.captureObserve(
          ref,
          { mode: 'ax', target: { kind: 'screen' } },
          { timeoutMs: 500, signal: new AbortController().signal },
        ),
      ).rejects.toThrow()
      await expect(closed).resolves.toEqual({
        generation: 1,
        reason: 'closed',
        resetReason: 'transport_suspect',
      })
      const names = events(logFile)
        .filter((event) => event.event === 'tool')
        .map((event) => event.name)
      expect(names.filter((name) => name === 'capture')).toHaveLength(
        mode === 'screen-capture-fail' || mode === 'screen-restore-fail' ? 1 : 0,
      )
      expect(names.filter((name) => name === 'set_capture_scope' && name)).toHaveLength(
        mode === 'screen-get-fail' ? 0 : mode === 'screen-set-fail' ? 2 : 2,
      )
      const reopened = await runtime.open(ref, new AbortController().signal)
      expect(reopened.generation).toBe(2)
    }
  })

  it('isolates a failed screen compound call from another lane', async () => {
    const { runtime } = harness('screen-capture-fail')
    const failingRef = session('screen-isolation', 'a')
    const healthyRef = session('screen-isolation', 'b')
    await runtime.open(failingRef, new AbortController().signal)
    await runtime.open(healthyRef, new AbortController().signal)
    await expect(
      runtime.captureObserve(
        failingRef,
        { mode: 'ax', target: { kind: 'screen' } },
        { timeoutMs: 500, signal: new AbortController().signal },
      ),
    ).rejects.toThrow()
    await expect(
      runtime.captureObserve(
        healthyRef,
        { mode: 'ax', target: { kind: 'frontmost' } },
        { timeoutMs: 500, signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ isError: false })
  })

  it('replaces raw screenshot bytes with a Host-authored content-addressed resource link', async () => {
    const { runtime } = harness()
    const connection = await runtime.open(session('artifact'), new AbortController().signal)
    const raw = await connection.call(
      'capture',
      { mode: 'som' },
      { timeoutMs: 500, signal: new AbortController().signal },
    )
    const writes: Uint8Array[] = []
    const normalized = await normalizeFakeObserveResult('capture', raw, {
      put: async (bytes, meta) => {
        expect(meta).toEqual({ mime: 'image/png', name: 'computer-use-screenshot.png' })
        writes.push(bytes)
        return {
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.byteLength,
          mime: meta.mime,
        }
      },
    })
    const digest = createHash('sha256')
      .update(writes[0] as Uint8Array)
      .digest('hex')

    expect(writes).toHaveLength(1)
    expect(normalized.content).toEqual([
      expect.objectContaining({ type: 'text' }),
      {
        type: 'resource_link',
        uri: `artifact://${digest}`,
        name: 'computer-use-screenshot.png',
        mimeType: 'image/png',
      },
    ])
    expect(normalized.structuredContent).toMatchObject({
      mode: 'som',
      image: {
        ref: { sha256: digest, size: writes[0]?.byteLength, mime: 'image/png' },
        mime: 'image/png',
        width: 1,
        height: 1,
        digest,
      },
    })
    expect(raw.content.some((block) => block.type === 'image')).toBe(true)
    expect(normalized.content.some((block) => block.type === 'image')).toBe(false)
    expect(parseCaptureResult(normalized).image).toMatchObject({
      ref: { sha256: digest, mime: 'image/png' },
      digest,
      width: 1,
      height: 1,
    })
  })

  it('rejects driver-authored or sink-mismatched artifact identity', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    let forgedWrites = 0
    await expect(
      normalizeFakeObserveResult(
        'capture',
        {
          content: [{ type: 'image', data: png, mimeType: 'image/png' }],
          structuredContent: validCapture({ image: { forged: true } }),
          isError: false,
        },
        {
          put: async () => {
            forgedWrites += 1
            return { sha256: '0'.repeat(64), size: 1, mime: 'image/png' }
          },
        },
      ),
    ).rejects.toThrow('cannot author artifact identity')
    expect(forgedWrites).toBe(0)

    await expect(
      normalizeFakeObserveResult(
        'capture',
        {
          content: [{ type: 'image', data: png, mimeType: 'image/png' }],
          structuredContent: validCapture(),
          isError: false,
        },
        {
          put: async () => ({
            sha256: '0'.repeat(64),
            size: 1,
            mime: 'image/png',
          }),
        },
      ),
    ).rejects.toThrow('mismatched identity')
  })

  it('snapshots the raw envelope before artifact persistence awaits', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const mutable = {
      content: [
        { type: 'text' as const, text: 'before' },
        { type: 'image' as const, data: png, mimeType: 'image/png' },
      ],
      structuredContent: validCapture(),
      isError: false,
    }
    const normalized = await normalizeFakeObserveResult('capture', mutable, {
      put: async (bytes) => {
        mutable.content[0] = { type: 'text', text: 'after' }
        mutable.content[1] = { type: 'image', data: 'AB==', mimeType: 'image/png' }
        mutable.structuredContent.width = 99
        Object.assign(mutable.structuredContent, { image: { forged: true } })
        await Promise.resolve()
        return {
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.byteLength,
          mime: 'image/png',
        }
      },
    })

    expect(normalized.content[0]).toEqual({ type: 'text', text: 'before' })
    expect(normalized.structuredContent).toMatchObject({
      width: 1,
      height: 1,
      image: { width: 1, height: 1 },
    })
  })

  it('rejects syntactically padded but non-canonical base64 before writing an artifact', async () => {
    let writes = 0
    await expect(
      normalizeFakeObserveResult(
        'capture',
        {
          content: [{ type: 'image', data: 'AB==', mimeType: 'image/png' }],
          structuredContent: validCapture(),
          isError: false,
        },
        {
          put: async () => {
            writes += 1
            return { sha256: '0'.repeat(64), size: 1, mime: 'image/png' }
          },
        },
      ),
    ).rejects.toThrow('non-canonical base64')
    expect(writes).toBe(0)
  })

  it('runs the shared safe-image decoder before artifact persistence', async () => {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    bytes[29] = (bytes[29] as number) ^ 1
    let writes = 0
    await expect(
      normalizeFakeObserveResult(
        'capture',
        {
          content: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }],
          structuredContent: validCapture(),
          isError: false,
        },
        {
          put: async () => {
            writes += 1
            return { sha256: '0'.repeat(64), size: 1, mime: 'image/png' }
          },
        },
      ),
    ).rejects.toThrow(/CRC/)
    expect(writes).toBe(0)
  })

  it('rejects JSON text fallback identity and errored captures before artifact writes', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const forgedDigest = 'a'.repeat(64)
    const forgedText = JSON.stringify({
      image: {
        ref: { sha256: forgedDigest, size: 1, mime: 'image/png' },
        mime: 'image/png',
        width: 1,
        height: 1,
        digest: forgedDigest,
      },
    })
    const fallbackEnvelope = {
      content: [
        { type: 'text' as const, text: forgedText },
        { type: 'image' as const, data: png, mimeType: 'image/png' },
      ],
      structuredContent: validCapture(),
      isError: false,
    }
    // This proves the legacy Base fallback would accept the forged identity after a naive Host
    // image-to-resource_link conversion, so Host must reject it before that boundary.
    expect(
      parseCaptureResult({
        ...fallbackEnvelope,
        content: [
          { type: 'text', text: forgedText },
          { type: 'resource_link', uri: `artifact://${forgedDigest}`, mimeType: 'image/png' },
        ],
      }).image?.ref.sha256,
    ).toBe(forgedDigest)
    let writes = 0
    const sink = {
      put: async () => {
        writes += 1
        return { sha256: '0'.repeat(64), size: 1, mime: 'image/png' }
      },
    }
    await expect(normalizeFakeObserveResult('capture', fallbackEnvelope, sink)).rejects.toThrow(
      'reject JSON text fallback',
    )
    await expect(
      normalizeFakeObserveResult(
        'capture',
        {
          content: [{ type: 'image', data: png, mimeType: 'image/png' }],
          structuredContent: validCapture(),
          isError: true,
        },
        sink,
      ),
    ).rejects.toThrow('error cannot produce trusted capture state')
    expect(writes).toBe(0)
  })

  it('rejects an AX artifact identity split across text blocks before Base fallback parsing', async () => {
    const forgedDigest = 'b'.repeat(64)
    const image = {
      ref: { sha256: forgedDigest, size: 1, mime: 'image/png' },
      mime: 'image/png',
      width: 1,
      height: 1,
      digest: forgedDigest,
    }
    const raw = {
      content: [
        { type: 'text' as const, text: '{"image":' },
        { type: 'text' as const, text: `${JSON.stringify(image)}}` },
      ],
      structuredContent: validCapture({ mode: 'ax', width: 0, height: 0 }),
      isError: false,
    }
    expect(parseCaptureResult(raw).image?.ref.sha256).toBe(forgedDigest)
    let writes = 0
    await expect(
      normalizeFakeObserveResult('capture', raw, {
        put: async () => {
          writes += 1
          return { sha256: forgedDigest, size: 1, mime: 'image/png' }
        },
      }).then((normalized) => parseCaptureResult(normalized)),
    ).rejects.toThrow('reject JSON text fallback')
    expect(writes).toBe(0)
  })

  it('validates typed capture, app and window result shapes before trusting output', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const sink = {
      put: async () => {
        throw new Error('artifact sink must not be reached')
      },
    }
    for (const structuredContent of [
      validCapture({ mode: 'unknown' }),
      validCapture({ target: { app: 'Fake Notes', pid: 0, window_id: 5101, snapshot_id: 's' } }),
      validCapture({
        elements: [
          { index: 1, role: 'button', label: 'one', bounds: [0, 0, 1, 1], element_token: 'one' },
          { index: 1, role: 'button', label: 'two', bounds: [0, 0, 1, 1], element_token: 'two' },
        ],
      }),
    ])
      await expect(
        normalizeFakeObserveResult(
          'capture',
          {
            content: [{ type: 'image', data: png, mimeType: 'image/png' }],
            structuredContent,
            isError: false,
          },
          sink,
        ),
      ).rejects.toThrow()

    await expect(
      normalizeFakeObserveResult(
        'capture',
        {
          content: [{ type: 'image', data: png, mimeType: 'image/png' }],
          structuredContent: validCapture({ mode: 'ax', width: 0, height: 0 }),
          isError: false,
        },
        sink,
      ),
    ).rejects.toThrow('ax capture has an invalid image count')
    await expect(
      normalizeFakeObserveResult(
        'list_apps',
        { content: [], structuredContent: { apps: [{ app: 'Fake Notes', pid: 0 }] }, isError: false },
        sink,
      ),
    ).rejects.toThrow()
    await expect(
      normalizeFakeObserveResult(
        'list_windows',
        {
          content: [],
          structuredContent: {
            windows: [{ app: 'Fake Notes', pid: 1, window_id: 2, title: 'x', bounds: [0, 0, 1] }],
          },
          isError: false,
        },
        sink,
      ),
    ).rejects.toThrow()
  })

  it('rejects spawn failure without an unhandled child error', async () => {
    const runtime = createFakeComputerUseSessionRuntime({
      command: join(tmpdir(), `agnes-no-such-cua-driver-${process.pid}`),
      startupTimeoutMs: 100,
    })
    runtimes.push(runtime)
    await expect(runtime.open(session('spawn-failure'), new AbortController().signal)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(runtime.dispose()).resolves.toBeUndefined()
  })

  it('passes only the Host minimum environment and explicit fake-driver variables', async () => {
    const oldAgnesSecret = process.env.AGNES_SECRET_FAKE_DRIVER_TEST
    const oldProviderKey = process.env.DEEPSEEK_API_KEY
    process.env.AGNES_SECRET_FAKE_DRIVER_TEST = 'must-not-reach-child'
    process.env.DEEPSEEK_API_KEY = 'must-not-reach-child'
    try {
      const { runtime } = harness()
      const connection = await runtime.open(session('clean-env'), new AbortController().signal)
      const output = await call(connection)
      expect(output.structuredContent).toMatchObject({
        inheritedAgnesSecret: false,
        inheritedProviderKey: false,
      })
    } finally {
      if (oldAgnesSecret === undefined) delete process.env.AGNES_SECRET_FAKE_DRIVER_TEST
      else process.env.AGNES_SECRET_FAKE_DRIVER_TEST = oldAgnesSecret
      if (oldProviderKey === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = oldProviderKey
    }
  })

  it('reserves a (session.key,lane) during open and releases the reservation after failure', async () => {
    const { runtime, logFile } = harness('slow-init')
    const ref = session('concurrent-open')
    const attempts = await Promise.allSettled([
      runtime.open(ref, new AbortController().signal),
      runtime.open(ref, new AbortController().signal),
    ])
    const opened = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<FakeComputerUseDriverConnection> =>
        attempt.status === 'fulfilled',
    )
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected')
    expect(opened).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toEqual(
      expect.objectContaining({ message: 'session already has an open fake runtime' }),
    )
    expect(events(logFile).filter((event) => event.event === 'initialize')).toHaveLength(1)
    const winner = opened[0]
    if (!winner) throw new Error('expected one successful concurrent open')
    await runtime.close(ref, 'session_end')
    expect(() => process.kill(winner.value.pid, 0)).toThrow()

    const controller = new AbortController()
    const failed = runtime.open(ref, controller.signal)
    controller.abort()
    await expect(failed).rejects.toThrow()
    const retried = await runtime.open(ref, new AbortController().signal)
    expect(retried.generation).toBe(3)
    await runtime.close(ref, 'session_end')
    expect(() => process.kill(retried.pid, 0)).toThrow()
  })

  it('lets close win against an in-flight open instead of returning a dead connection', async () => {
    const { runtime, logFile } = harness('slow-init')
    const ref = session('close-during-open')
    const outcomes = await Promise.allSettled([
      runtime.open(ref, new AbortController().signal),
      runtime.close(ref, 'session_end'),
    ])
    expect(outcomes[0]).toEqual(
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ name: 'AbortError' }),
      }),
    )
    expect(outcomes[1]).toEqual({ status: 'fulfilled', value: undefined })
    const child = events(logFile).find((event) => event.event === 'initialize')
    // The opening cancellation may win before the child publishes initialize. If it did publish,
    // close still owns its complete cleanup before returning.
    if (child) await expectProcessGone(child.pid)
    const reopened = await runtime.open(ref, new AbortController().signal)
    expect(reopened.generation).toBe(2)
  })

  it('close aborts a connect that can only finish by observing cancellation', async () => {
    let connectStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      connectStarted = resolve
    })
    const runtime = createFakeComputerUseSessionRuntime(
      { command: process.execPath },
      {
        connect: async (_command, _generation, _token, signal) => {
          connectStarted?.()
          return await new Promise<never>((_resolve, reject) => {
            const abort = () => reject(signal.reason)
            signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) abort()
          })
        },
      },
    )
    runtimes.push(runtime)
    const ref = session('close-aborts-connect')
    const opening = runtime.open(ref, new AbortController().signal)
    await started

    await expect(runtime.close(ref, 'session_end')).resolves.toBeUndefined()
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('dispose aborts a connect that can only finish by observing cancellation', async () => {
    let connectStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      connectStarted = resolve
    })
    const runtime = createFakeComputerUseSessionRuntime(
      { command: process.execPath },
      {
        connect: async (_command, _generation, _token, signal) => {
          connectStarted?.()
          return await new Promise<never>((_resolve, reject) => {
            const abort = () => reject(signal.reason)
            signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) abort()
          })
        },
      },
    )
    runtimes.push(runtime)
    const opening = runtime.open(session('dispose-aborts-connect'), new AbortController().signal)
    await started

    await expect(runtime.dispose()).resolves.toBeUndefined()
    await expect(opening).rejects.toThrow('fake Computer Use session runtime is disposed')
  })

  it('shares the first close intent across concurrent close and dispose waiters', async () => {
    let release: (() => void) | undefined
    const connected = new Promise<void>((resolve) => {
      release = resolve
    })
    const resetReasons: Array<ComputerUseResetReason | undefined> = []
    const runtime = createFakeComputerUseSessionRuntime(
      { command: process.execPath },
      {
        connect: async (_command, generation) => {
          await connected
          return {
            generation,
            pid: 1,
            transportId: 'first-wins',
            capabilityVersion: '1',
            catalog: new Map(),
            call: async () => {
              throw new Error('not called')
            },
            onClose: () => () => undefined,
            close: async () => undefined,
            closeForReset: async (reason) => {
              resetReasons.push(reason)
            },
            cancelFromSession: async () => undefined,
          }
        },
      },
    )
    runtimes.push(runtime)
    const ref = session('shared-close-intent')
    const opening = runtime.open(ref, new AbortController().signal)
    const firstClose = runtime.close(ref, 'session_end')
    const secondClose = runtime.close(ref, 'reload')
    const disposing = runtime.dispose()
    release?.()

    await expect(opening).rejects.toMatchObject({ name: 'AbortError' })
    await expect(Promise.all([firstClose, secondClose, disposing])).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ])
    expect(resetReasons).toEqual(['session_end'])
  })

  it('rotates the opaque session token for every lane and generation', async () => {
    const { runtime } = harness()
    const a = await runtime.open(session('token', 'a'), new AbortController().signal)
    const b = await runtime.open(session('token', 'b'), new AbortController().signal)
    type Identity = {
      sessionToken: string
      target: { snapshot_id: string }
      elements: Array<{ element_token: string }>
    }
    const aToken = (await call(a)).structuredContent as Identity
    const bToken = (await call(b)).structuredContent as Identity
    await runtime.close(session('token', 'a'), 'reload')
    const reopened = await runtime.open(session('token', 'a'), new AbortController().signal)
    const reopenedToken = (await call(reopened)).structuredContent as Identity
    expect(new Set([aToken.sessionToken, bToken.sessionToken, reopenedToken.sessionToken]).size).toBe(3)
    expect(
      new Set([aToken.target.snapshot_id, bToken.target.snapshot_id, reopenedToken.target.snapshot_id]).size,
    ).toBe(3)
    expect(
      new Set([
        aToken.elements[0]?.element_token,
        bToken.elements[0]?.element_token,
        reopenedToken.elements[0]?.element_token,
      ]).size,
    ).toBe(3)
    for (const token of [aToken.sessionToken, bToken.sessionToken, reopenedToken.sessionToken])
      expect(token).toMatch(/^[a-f0-9]{48}$/)
  })

  it('rejects a late-aborted open instead of returning a closed handle', async () => {
    const { runtime } = harness()
    const controller = new AbortController()
    let reads = 0
    const signal = new Proxy(controller.signal, {
      get(target, property) {
        if (property === 'aborted') {
          reads += 1
          return reads >= 3
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    await expect(runtime.open(session('late-abort'), signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('waits for an in-flight open during Host disposal and reaps the child before returning', async () => {
    const { runtime, logFile } = harness('slow-init')
    const outcomes = await Promise.allSettled([
      runtime.open(session('dispose-during-open'), new AbortController().signal),
      runtime.dispose(),
    ])
    expect(outcomes[0]).toEqual(
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ message: 'fake Computer Use session runtime is disposed' }),
      }),
    )
    expect(outcomes[1]).toEqual({ status: 'fulfilled', value: undefined })
    const childPids = new Set(events(logFile).map((event) => event.pid))
    // Cancellation may win before the trusted broker starts the target. If a target became
    // observable, dispose still owns its complete cleanup before returning.
    expect(childPids.size).toBeLessThanOrEqual(1)
    for (const pid of childPids) expect(() => process.kill(pid, 0)).toThrow()
  })

  it('isolates process, transport, generation and close state per (session.key,lane)', async () => {
    const { runtime } = harness()
    const a = await runtime.open(session('shared', 'a'), new AbortController().signal)
    const b = await runtime.open(session('shared', 'b'), new AbortController().signal)
    expect(a.pid).not.toBe(b.pid)
    expect(a.transportId).not.toBe(b.transportId)
    expect(a.generation).toBe(1)
    expect(b.generation).toBe(1)
    await expect(runtime.open(session('shared', 'a'), new AbortController().signal)).rejects.toThrow(
      'already has an open fake runtime',
    )

    const closed: DriverCloseEvent[] = []
    a.onClose((event) => closed.push(event))
    await runtime.close(session('shared', 'a'), 'idle')
    expect(closed).toEqual([{ generation: 1, reason: 'closed', resetReason: 'idle' }])
    await expect(call(b)).resolves.toMatchObject({ isError: false })

    const reopened = await runtime.open(session('shared', 'a'), new AbortController().signal)
    expect(reopened.generation).toBe(2)
    expect(reopened.pid).not.toBe(a.pid)
  })

  it('tears down the old process and invalidates its generation when permission mode changes', async () => {
    const { runtime } = harness()
    const ref = session('mode-switch')
    expect(runtime.permissionMode(ref)).toBe('standard')
    const first = await runtime.open(ref, new AbortController().signal)
    const closed = new Promise<DriverCloseEvent>((resolve) => first.onClose(resolve))

    await runtime.setPermissionMode(ref, 'bounded')

    expect(runtime.permissionMode(ref)).toBe('bounded')
    await expect(closed).resolves.toEqual({
      generation: 1,
      reason: 'closed',
      resetReason: 'mode_change',
    })
    expect(() => process.kill(first.pid, 0)).toThrow()
    const reopened = await runtime.open(ref, new AbortController().signal)
    expect(reopened.generation).toBeGreaterThan(first.generation)
    expect(reopened.pid).not.toBe(first.pid)

    // Re-selecting the current mode is idempotent and does not destroy a healthy process.
    await runtime.setPermissionMode(ref, 'bounded')
    await expect(call(reopened)).resolves.toMatchObject({ isError: false })
  })

  it('records every Host lifecycle reset reason without accepting driver-authored context', async () => {
    const reasons: ComputerUseResetReason[] = [
      'session_end',
      'cancel',
      'idle',
      'reload',
      'mode_change',
      'transport_suspect',
    ]
    const { runtime } = harness()
    for (const reason of reasons) {
      const ref = session(`close-${reason}`)
      const connection = await runtime.open(ref, new AbortController().signal)
      const closed = new Promise<DriverCloseEvent>((resolve) => connection.onClose(resolve))
      await runtime.close(ref, reason)
      await expect(closed).resolves.toEqual({ generation: 1, reason: 'closed', resetReason: reason })
      expect(() => process.kill(connection.pid, 0)).toThrow()
    }
  })

  it('fails closed on catalog drift and never accepts a driver-authored reset reason', async () => {
    const { runtime } = harness('catalog-drift')
    const connection = await runtime.open(session('drift'), new AbortController().signal)
    const event = await new Promise<DriverCloseEvent>((resolve) => connection.onClose(resolve))
    expect(event).toEqual({ generation: 1, reason: 'protocol_error', resetReason: 'transport_suspect' })
    await expect(call(connection)).rejects.toThrow(/closed|catalog drift/)
    expect(() => process.kill(connection.pid, 0)).toThrow()
  })

  it('turns broken frames and response envelopes into protocol_error + transport_suspect', async () => {
    for (const [mode, message] of [
      ['broken-frame', /invalid JSON/],
      ['broken-envelope', /response lacks result/],
      ['broken-utf8', /invalid UTF-8/],
      ['empty-frame', /invalid JSON/],
      ['oversized-frame', /frame exceeds/],
      ['oversized-buffer', /buffer exceeds/],
    ] as const) {
      const { runtime } = harness(mode)
      const connection = await runtime.open(session(mode), new AbortController().signal)
      const closeEvent = new Promise<DriverCloseEvent>((resolve) => connection.onClose(resolve))
      await expect(call(connection)).rejects.toThrow(message)
      await expect(closeEvent).resolves.toEqual({
        generation: 1,
        reason: 'protocol_error',
        resetReason: 'transport_suspect',
      })
      expect(() => process.kill(connection.pid, 0)).toThrow()
    }
  })

  it('keeps the transport open after a valid JSON-RPC tool error', async () => {
    const { runtime } = harness('rpc-error')
    const connection = await runtime.open(session('rpc-error'), new AbortController().signal)
    const closed: DriverCloseEvent[] = []
    connection.onClose((event) => closed.push(event))
    await expect(call(connection)).rejects.toThrow('JSON-RPC error')
    await expect(call(connection)).resolves.toMatchObject({ isError: false })
    expect(closed).toEqual([])
  })

  it('reaps the child after startup timeout', async () => {
    const { runtime, logFile } = harness('slow-init', 10)
    await expect(runtime.open(session('startup-timeout'), new AbortController().signal)).rejects.toThrow(
      'timed out',
    )
    const child = await waitForEvent(logFile, 'initialize')
    await expectProcessGone(child.pid)
  })

  it('turns broken stdin into one conservative close without crashing the Host', async () => {
    const { runtime, logFile } = harness('broken-pipe')
    const connection = await runtime.open(session('broken-pipe'), new AbortController().signal)
    await waitForEvent(logFile, 'stdin_closed')
    const closed = new Promise<DriverCloseEvent>((resolve) => connection.onClose(resolve))
    await expect(
      connection.call(
        'capture',
        { payload: 'x'.repeat(512 * 1024) },
        { timeoutMs: 500, signal: new AbortController().signal },
      ),
    ).rejects.toThrow()
    const closeEvent = await closed
    expect(closeEvent).toMatchObject({ generation: 1, resetReason: 'transport_suspect' })
    // The Windows launch broker also owns the inherited pipe. It can mask the target-side close
    // until this bounded request times out; either path must produce the same conservative reset.
    expect(['driver_exit', 'timeout']).toContain(closeEvent.reason)
    await expectProcessGone(connection.pid)
  })

  it('terminates descendants in the owned process tree', async () => {
    const { runtime, logFile } = harness('grandchild')
    const connection = await runtime.open(session('grandchild'), new AbortController().signal)
    const child = await waitForEvent(logFile, 'grandchild')
    if (!child.grandchildPid) throw new Error('fake child did not report its grandchild')
    process.kill(child.grandchildPid, 0)
    await runtime.close(session('grandchild'), 'session_end')
    await expectProcessGone(connection.pid)
    await expectProcessGone(child.grandchildPid)
  })

  it('reports an opening cleanup failure through both open and concurrent dispose', async () => {
    let release: (() => void) | undefined
    const connected = new Promise<void>((resolve) => {
      release = resolve
    })
    const closeFailure = new Error('injected opening cleanup failure')
    const runtime = createFakeComputerUseSessionRuntime(
      { command: process.execPath },
      {
        connect: async (_command, generation) => {
          await connected
          return {
            generation,
            pid: 1,
            transportId: 'injected',
            capabilityVersion: '1',
            catalog: new Map(),
            call: async () => {
              throw new Error('not called')
            },
            onClose: () => () => undefined,
            close: async () => {
              throw closeFailure
            },
            closeForReset: async () => {
              throw closeFailure
            },
            cancelFromSession: async () => {
              throw closeFailure
            },
          }
        },
      },
    )
    runtimes.push(runtime)
    const opening = runtime.open(session('dispose-cleanup-failure'), new AbortController().signal)
    const disposing = runtime.dispose()
    release?.()
    await expect(opening).rejects.toBe(closeFailure)
    await expect(disposing).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [closeFailure],
    })
  })

  it('treats timeout, cancellation and EOF as conservative generation resets', async () => {
    const cases = [
      { mode: 'hang-call', expected: { reason: 'timeout', resetReason: 'transport_suspect' }, cancel: false },
      { mode: 'hang-call', expected: { reason: 'cancel', resetReason: 'cancel' }, cancel: true },
      {
        mode: 'eof-call',
        expected: { reason: ['eof', 'timeout'], resetReason: 'transport_suspect' },
        cancel: false,
      },
    ] as const
    for (const item of cases) {
      const { runtime } = harness(item.mode)
      const connection = await runtime.open(session(item.mode), new AbortController().signal)
      const closed = new Promise<DriverCloseEvent>((resolve) => connection.onClose(resolve))
      const controller = new AbortController()
      const pending = connection.call(
        'capture',
        {},
        { timeoutMs: item.cancel ? 500 : item.mode === 'hang-call' ? 10 : 500, signal: controller.signal },
      )
      if (item.cancel) controller.abort()
      await expect(pending).rejects.toThrow()
      const closeEvent = await closed
      expect(closeEvent).toMatchObject({
        generation: 1,
        resetReason: item.expected.resetReason,
      })
      const reasons = Array.isArray(item.expected.reason) ? item.expected.reason : [item.expected.reason]
      expect(reasons).toContain(closeEvent.reason)
      expect(() => process.kill(connection.pid, 0)).toThrow()
    }
  })

  it('binds the open signal to only its own session and dispose reaps every remaining child', async () => {
    const { runtime } = harness()
    const controller = new AbortController()
    const a = await runtime.open(session('a'), controller.signal)
    const b = await runtime.open(session('b'), new AbortController().signal)
    const closed = new Promise<DriverCloseEvent>((resolve) => a.onClose(resolve))
    const hostClosed = new Promise<DriverCloseEvent>((resolve) => b.onClose(resolve))
    controller.abort()
    await expect(closed).resolves.toEqual({ generation: 1, reason: 'cancel', resetReason: 'cancel' })
    await expect(call(b)).resolves.toMatchObject({ isError: false })

    await runtime.dispose()
    await expect(hostClosed).resolves.toEqual({ generation: 1, reason: 'closed' })
    expect(() => process.kill(a.pid, 0)).toThrow()
    expect(() => process.kill(b.pid, 0)).toThrow()
  })
})
