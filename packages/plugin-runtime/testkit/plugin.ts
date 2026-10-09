import type { Plugin } from '@agnes/cordis'
import type { ToolContext, ToolResult } from '@agnes/extension-api'
import { Value } from '@sinclair/typebox/value'
import { createPluginRow, normalizePluginExport } from '../src/host/index.js'
import { createVerifiedTestRoot } from './index.js'
import type { PluginTestRegistration } from './registration.js'

export interface PluginTestOptions {
  config?: unknown
  /** Supply explicit ports for tools that need I/O; omitted ports refuse access. */
  context?: Partial<ToolContext>
  /** Supply a registration bridge, such as createPluginTestRegistration from @agnes/host/testkit. */
  registration: PluginTestRegistration
}

/** Mount through a verified third-party row and the production Host registration API. */
export async function createPluginTestHost(plugin: Plugin, options: PluginTestOptions) {
  const registration = options?.registration
  if (!registration) throw new TypeError('Plugin test registration required')
  const world = createVerifiedTestRoot()
  const entry = normalizePluginExport(plugin)
  const snapshot = world.fixtures.snapshot({
    packageId: '@test/plugin',
    snapshotId: 'author',
    digest: 'sha256-author',
    exports: ['main'],
  })
  const key = '@test/plugin@author/main'
  world.fixtures.claim(key, {
    trust: 'third-party',
    snapshot,
    entry,
    entryRevision: 'author',
    extrasRevision: 'none',
  })
  const row = createPluginRow({
    id: 'ext:test/plugin/main',
    plugin: key,
    snapshotDigest: snapshot.digest,
    exportName: 'main',
    entryRevision: 'author',
    extrasRevision: 'none',
    mountRevision: 'author',
    inject: Object.keys(entry.inject),
    provides: entry.provides,
    ...(options.config === undefined ? {} : { config: options.config }),
  })
  const controller = new AbortController()
  let disposed = false
  try {
    registration.install(world.root, world.origins)
    await world.apply([row])
    registration.assertLoaded()
  } catch (error) {
    try {
      await world.apply([])
    } finally {
      await world.root.fiber.dispose()
    }
    throw error
  }
  const unavailable = () => {
    throw new Error('Test port not configured; supply options.context')
  }
  const blocked = new Proxy({}, { get: () => unavailable })
  const context: ToolContext = {
    cwd: '/test',
    session: {
      key: 'author-test',
      lane: 'main',
      workspaceRoot: '/test',
      toolUseId: 'test-call',
      depth: 0,
      generationDepth: 0,
    },
    actor: { id: 'author', org: 'test', role: 'tester', deptPath: [], attrs: {} },
    signal: controller.signal,
    timeoutMs: 1000,
    outputMaxBytes: 32768,
    exec: unavailable,
    authorize: unavailable,
    requestCompaction: unavailable,
    progress() {},
    fs: blocked as ToolContext['fs'],
    net: blocked as ToolContext['net'],
    artifacts: blocked as ToolContext['artifacts'],
    subagent: blocked as ToolContext['subagent'],
    plan: blocked as ToolContext['plan'],
    projections: blocked as ToolContext['projections'],
    sandbox: { confine: unavailable, enforcement: () => ({ level: 'none', scope: [] }) },
    platform: {
      shell: 'posix',
      fs: { caseSensitive: true, pathSep: '/' },
      terminal: { color: false },
      capability: () => ({ level: 'unavailable', scope: [], reason: 'test' }),
    },
    lease: { expiresAt: '9999-01-01T00:00:00.000Z', scope: {}, budget: { remaining: 1000 } },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    tools: { list: () => [...registration.tools.values()], invoke: unavailable },
    ...options.context,
  }
  return {
    tools: registration.tools,
    async invoke(name: string, args: unknown, signal: AbortSignal = controller.signal): Promise<ToolResult> {
      if (disposed) throw new Error('Plugin test host disposed')
      signal.throwIfAborted()
      const def = registration.tools.get(name)
      if (!def) throw new Error(`Tool not registered: ${name}`)
      if (!Value.Check(def.parameters, args)) throw new TypeError(`Invalid arguments for tool ${name}`)
      return def.execute(args, {
        ...context,
        signal: AbortSignal.any([controller.signal, context.signal, signal]),
      })
    },
    async dispose() {
      if (disposed) return
      disposed = true
      controller.abort()
      try {
        await world.apply([])
      } finally {
        await world.root.fiber.dispose()
      }
    },
  }
}
