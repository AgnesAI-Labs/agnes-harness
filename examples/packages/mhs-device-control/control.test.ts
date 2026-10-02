import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  checkManifest,
  checkServiceDef,
  checkToolDef,
  type ServiceDef,
  type ToolContext,
  type ToolDef,
} from '../../../packages/extension-api/src/index.js'
import { resolveClientAssets } from '../../../packages/package-manager/src/client-assets.js'
import { parseAgnesPluginEntries } from '../../../packages/package-manager/src/plugin-manifest.js'
import { validateAgainst } from '../../../packages/protocol/src/validate.js'
import { createMhsRuntime } from './extensions/main/index.mjs'

const packageRoot = dirname(fileURLToPath(import.meta.url))

function captureRuntime() {
  const tools: ToolDef[] = []
  let service: ServiceDef | undefined
  const { runtime } = createMhsRuntime()
  runtime.apply({
    extension: () => ({ registerTool: (tool: ToolDef) => tools.push(tool) }),
    services: { register: (definition: ServiceDef) => (service = definition) },
    effect: (factory: () => () => void) => factory(),
  } as never)
  return { tools, service }
}

function toolContext(progress: string[], toolUseId = 'tool-use-1'): ToolContext {
  const ac = new AbortController()
  return {
    session: {
      key: 'mhs-test-session',
      lane: 'main',
      workspaceRoot: 'C:/workspace',
      toolUseId,
      depth: 0,
      generationDepth: 0,
    },
    signal: ac.signal,
    progress: (line: string) => progress.push(line),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as ToolContext
}

describe('MHS device control example', () => {
  it('declares a matching backend row and valid browser assets', () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    expect(parseAgnesPluginEntries(pkg.name, pkg.agnes.plugins)).toMatchObject([
      {
        export: 'runtime',
        id: 'ext:agnes-examples/mhs-device-control',
        inject: ['extension'],
        runtime: 'in-process',
      },
    ])
    const descriptorDir = join(packageRoot, 'extensions', 'main')
    const descriptor = JSON.parse(readFileSync(join(descriptorDir, 'agnes.client.json'), 'utf8'))
    const checked = checkManifest({
      id: 'client/descriptor',
      version: pkg.version,
      apiRange: '*',
      entry: './index.mjs',
      capabilities: { ui: ['client'] },
      contributes: { client: descriptor.client },
    })
    expect(checked.ok).toBe(true)
    if (!checked.ok) throw new Error('invalid MHS client descriptor')
    expect(resolveClientAssets(descriptorDir, checked.value)).toMatchObject({
      entryPath: expect.stringContaining('client'),
      stylePaths: [expect.stringContaining('index.css')],
    })
  })

  it('registers valid read and control tools plus a valid snapshot service', () => {
    const { tools, service } = captureRuntime()
    expect(tools.map((tool) => tool.name)).toEqual([
      'mhs_list_devices',
      'mhs_get_device_state',
      'mhs_control_device',
    ])
    for (const tool of tools) expect(checkToolDef(tool, { prefix: '' })).toEqual({ ok: true })
    expect(service).toBeDefined()
    expect(checkServiceDef(service)).toEqual({ ok: true })

    const control = tools[2]
    if (!control) throw new Error('MHS control tool was not registered')
    expect(
      validateAgainst(control.parameters, {
        deviceId: 'robot-dog-01',
        action: 'move_forward',
        durationMs: 200,
      }).ok,
    ).toBe(true)
    expect(validateAgainst(control.parameters, { deviceId: 'robot-dog-01' }).ok).toBe(false)
    const list = tools.find((tool) => tool.name === 'mhs_list_devices')
    if (!list) throw new Error('MHS device list tool was not registered')
    return list.execute({}, toolContext([])).then((response) => {
      const devices = (response.structured as { devices: Array<{ capabilities: string[] }> }).devices
      expect(devices[0]?.capabilities).toEqual(
        expect.arrayContaining([
          'stand',
          'lie_down',
          'heart',
          'new_year_greeting',
          'dance',
          'stretch',
          'front_pounce',
          'front_flip',
          'back_flip',
        ]),
      )
    })
  })

  it('streams detailed steps and keeps multiple turns in one session', async () => {
    vi.useFakeTimers()
    try {
      const { tools, service } = captureRuntime()
      const control = tools.find((tool) => tool.name === 'mhs_control_device')
      if (!control || !service) throw new Error('MHS example did not register its contracts')
      const progress: string[] = []
      const first = control.execute(
        { deviceId: 'robot-dog-01', action: 'front_flip', durationMs: 200 },
        toolContext(progress),
      )
      const inFlight = (await service.handler({}, { sessionId: 'mhs-test-session' } as never)) as Record<
        string,
        unknown
      >
      expect(inFlight).toMatchObject({ currentOperation: { action: 'front_flip', status: 'planning' } })
      await vi.runAllTimersAsync()
      const execution = await first
      expect(execution.structured).toMatchObject({
        deviceId: 'robot-dog-01',
        action: 'front_flip',
        status: 'succeeded',
        progress: 100,
        requestedMotionMs: 200,
      })
      const receipt = execution.structured as {
        startedAt: string
        completedAt: string
        elapsedMs: number
        motionElapsedMs: number
      }
      expect(receipt.elapsedMs).toBe(
        new Date(receipt.completedAt).getTime() - new Date(receipt.startedAt).getTime(),
      )
      expect(receipt.motionElapsedMs).toBe(200)
      expect(progress.join('\n')).toContain('[MHS][COMMAND_DISPATCHED]')
      expect(progress.join('\n')).toContain('[MHS][DEVICE_MOTION_PROGRESS]')
      expect(progress.join('\n')).toContain('[MHS][TODO_STARTED]')
      expect(progress.join('\n')).toContain('[MHS][TODO_COMPLETED]')
      expect(progress.join('\n')).toContain('[MHS][EXECUTION_RECEIPT_CREATED]')
      expect(progress.join('\n')).toContain('[MHS][TASK_COMPLETED]')

      const second = control.execute(
        { deviceId: 'robot-dog-01', action: '比心', durationMs: 200 },
        toolContext(progress, 'tool-use-2'),
      )
      await vi.runAllTimersAsync()
      await second
      const snapshot = (await service.handler({}, { sessionId: 'mhs-test-session' } as never)) as Record<
        string,
        unknown
      >
      expect(snapshot).toMatchObject({
        sessionId: 'mhs-test-session',
        connected: true,
        currentOperation: {
          deviceId: 'robot-dog-01',
          action: 'heart',
          status: 'succeeded',
          progress: 100,
        },
      })
      const operations = snapshot.recentOperations as Array<{
        action: string
        todos: Array<{ status: string }>
        toolUseId: string
      }>
      expect(operations.map((operation) => operation.action)).toEqual(['heart', 'front_flip'])
      expect(operations[0]?.toolUseId).toBe('tool-use-2')
      expect(operations[0]?.todos.every((todo) => todo.status === 'completed')).toBe(true)
      const other = (await service.handler({}, { sessionId: 'other-session' } as never)) as Record<
        string,
        unknown
      >
      expect(other).toMatchObject({ recentOperations: [] })
    } finally {
      vi.useRealTimers()
    }
  })
})
