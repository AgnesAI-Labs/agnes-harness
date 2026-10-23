import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import { applyPlanCommand } from '@agnes/base/plan-mode'
import type { PresetDoc } from '@agnes/host-common/presets/types'
import { AGNES_ERRORS, type ExtensionCallParams } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { parse } from 'yaml'
import { createTestHost } from '../testkit/index.js'

const permissionDir = new URL('../../code/presets/', import.meta.url)
const permissions: Record<string, PresetDoc> = Object.fromEntries(
  readdirSync(permissionDir)
    .filter((name) => name.startsWith('permission-') && name.endsWith('.yaml'))
    .map((name) => {
      const doc = parse(readFileSync(new URL(name, permissionDir), 'utf8')) as PresetDoc
      return [doc.name, doc] as const
    }),
)
const sandbox = { level: 'L0', required: false, on_unavailable: 'allow' } as const
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function open() {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-jobs-run-authz-'))
  roots.push(dataDir)
  const provider = new ScriptedProvider({
    models: [fakeModel({ route: 'gw', id: 'm1' })],
    scripts: [
      [
        { type: 'text_delta', delta: 'hi' },
        { type: 'done', reason: 'stop' },
      ],
    ],
    onExhausted: 'error',
  })
  const { host } = await createTestHost({
    dataDir,
    provider,
    disableSessionTitle: true,
    allowed: ['standard', 'nopty', 'plain'],
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
    presets: {
      ...permissions,
      standard: { name: 'standard', extends: 'base', disclosure: 'standard', sandbox },
      plain: { name: 'plain', extends: 'base', disclosure: 'standard' },
      // `tools.allow` hides every tool that is not listed, `pty_open` included.
      nopty: {
        name: 'nopty',
        extends: 'base',
        disclosure: 'standard',
        tools: { core: ['read'], allow: ['read'] },
        sandbox,
      },
    },
    serviceAuthority: {
      resolve: async () => ({
        source: 'web',
        subjectCredential: 'synthetic',
        grants: ['jobs.read', 'jobs.control'].map((name) => ({
          extension: 'agnes/jobs-web',
          name,
          range: '^0.1.0',
        })),
      }),
    },
  })
  const control = (sessionId: string, input: ExtensionCallParams['input']) =>
    host.callService(
      { sessionId, extension: 'agnes/jobs-web', service: 'jobs.control', commandId: 'c1', input },
      'synthetic',
      undefined,
      { commandId: 'c1' },
    )
  // Services bind when the session first runs a turn.
  const start = async (options: { preset: string; permission?: string }) => {
    const session = await host.createSession({ cwd: dataDir, ...options })
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'hi' }],
      actor: session.d.actor,
      kind: 'prompt',
    })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    return session
  }
  return { host, control, start }
}

// `run` is authorized exactly like `open` (`authorizeServiceProcess`); every case runs both so a gap
// cannot open between them.
const operations = [
  { operation: 'open', shell: 'bash' },
  { operation: 'run', command: 'echo should-not-run' },
] as const
const denied = { code: AGNES_ERRORS.CAPABILITY_DENIED }

it.each(operations)('passes authorization for $operation by default', async (input) => {
  // Control for the refusals below: authorization lets this through and the call then stops at the
  // test host's missing process port, so a refusal cannot come from an unrelated gate.
  const { host, control, start } = await open()
  const session = await start({ preset: 'standard' })
  const failure = await control(session.key, input).then(
    () => undefined,
    (error: unknown) => error as { code?: number },
  )
  expect(failure?.code).not.toBe(denied.code)
  await session.close()
  await host.close()
})

it.each(operations)('refuses $operation under the read-only permission', async (input) => {
  const { host, control, start } = await open()
  const session = await start({ preset: 'plain', permission: 'read-only' })
  await expect(control(session.key, input)).rejects.toMatchObject(denied)
  await session.close()
  await host.close()
})

it.each(operations)('refuses $operation while plan mode is active', async (input) => {
  const { host, control, start } = await open()
  const session = await start({ preset: 'standard' })
  applyPlanCommand(session.workspaceRoot, '/plan on')
  await expect(control(session.key, input)).rejects.toMatchObject(denied)
  await session.close()
  await host.close()
})

it.each(operations)('refuses $operation in a preset without the pty_open tool', async (input) => {
  const { host, control, start } = await open()
  const session = await start({ preset: 'nopty' })
  expect(session.currentTools().snapshot(session.lastSeq).byName.has('pty_open')).toBe(false)
  await expect(control(session.key, input)).rejects.toMatchObject(denied)
  await session.close()
  await host.close()
})
