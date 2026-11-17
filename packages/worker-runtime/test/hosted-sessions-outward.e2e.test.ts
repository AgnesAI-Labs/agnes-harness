import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ecosystem as baseEcosystem } from '@agnes/base'
import type { ToolDef } from '@agnes/extension-api'
import type { ExtensionAPI, ExtensionFactory } from '@agnes/extension-api/host'
import type { ApprovalRequest } from '@agnes/extension-api/seams'
import type { InferenceEvent } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { realHosted } from './real-hosted.js'

const call = (name: string, args: Record<string, unknown>): InferenceEvent[] => [
  { type: 'toolcall_end', via: 'native', call: { toolUseId: '', name, args, ordinal: 0 } } as InferenceEvent,
  { type: 'done', reason: 'toolUse' },
]
const done: InferenceEvent[] = [
  { type: 'text_delta', delta: 'done' } as InferenceEvent,
  { type: 'done', reason: 'stop' },
]
const REFUSED = 'Refused: this session holds outward commands for a person'
const PUSH = 'git push origin main'
const PLAN = { items: [{ content: 'ship', status: 'in_progress' }] }

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

// The bundled tools, with `todo` declaring itself outward: no shipped tool does, and the floor reads
// the declaration from the registered definition, so the case needs one registered for real.
const declaringTodoOutward: (typeof baseEcosystem)['agnes/tools-core'] = (init) => {
  const inner = baseEcosystem['agnes/tools-core'](init) as unknown as ExtensionFactory
  return ((api: ExtensionAPI) =>
    inner(
      // The backend API is frozen, so the override sits on an object that inherits the rest.
      Object.create(api, {
        registerTool: {
          value: (tool: ToolDef) =>
            api.registerTool(
              tool.name === 'todo'
                ? {
                    ...tool,
                    meta: { ...tool.meta, outward: true, isOpenWorld: true, requiresApproval: 'always' },
                  }
                : tool,
            ),
        },
      }),
    )) as unknown as ReturnType<(typeof baseEcosystem)['agnes/tools-core']>
}

it('a managed full-access session asks a person for git push and a declared outward tool, and refuses terminals; an ordinary one runs the push', async () => {
  const asked: ApprovalRequest[] = []
  const t = await realHosted({
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
    packages: {
      '@agnes/base': { ecosystem: { ...baseEcosystem, 'agnes/tools-core': declaringTodoOutward } },
    },
    // Nobody answers, so a question parks the turn instead of being answered by the test double.
    seams: {
      approval: {
        ask: async (request: ApprovalRequest) => {
          asked.push(request)
          return { verdict: 'unavailable' as const, reason: 'no-handler' as const }
        },
      },
    },
    script: [
      // managed-push
      call('shell', { command: PUSH }),
      // managed-terminal: the first pty_open only discloses the deferred tool
      call('pty_open', { cwd: '.' }),
      call('pty_open', { cwd: '.' }),
      call('shell', { command: 'ls', persistent: true }),
      done,
      // managed-tool
      call('todo', PLAN),
      // ordinary-push
      call('shell', { command: PUSH }),
      done,
    ],
  })
  cleanups.push(t.close)
  // The ordinary push really runs. A repository with no remote of its own keeps it local whatever
  // directory the workspace sits under.
  execFileSync('git', ['init', '-q', t.root])
  const live = (key: string) => {
    const session = t.host.kernel.get(key)
    if (!session) throw new Error(`${key} is not open`)
    return session
  }
  const fullAccess = async (key: string, params: Record<string, unknown>) => {
    await t.hosted.open(t.openFrame(key, params))
    const session = live(key)
    await t.hosted.dispatch(t.command(key, 'setYolo', { enabled: true, actor: session.d.actor }))
    return session
  }
  const turn = async (key: string) => {
    await t.prompt(key, 'go')
    return t.run(key)
  }
  const results = async (key: string) =>
    (await live(key).scan({ type: 'tool/result', order: 'asc', limit: 50 })).map((event) => {
      const data = event.data as { isError?: boolean; content: Array<{ text?: string }> }
      return { isError: data.isError === true, text: data.content.map((part) => part.text ?? '').join('') }
    })
  const questions = () =>
    asked.map((request) => ({
      tool: request.tool?.name,
      args: request.tool?.args,
      checkpoint: request.approval?.checkpoint,
      reviewer: request.approval?.reviewerRequirement,
    }))

  const managedPush = await fullAccess('managed-push', { outwardCommandRules: true })
  await expect(turn('managed-push')).resolves.toMatchObject({ reason: 'parked' })
  expect(questions()).toEqual([
    { tool: 'shell', args: { command: PUSH }, checkpoint: 'outward', reviewer: 'human' },
  ])
  expect(await managedPush.decisions.list()).toHaveLength(1)
  expect(await results('managed-push')).toEqual([])

  await fullAccess('managed-terminal', { outwardCommandRules: true })
  await expect(turn('managed-terminal')).resolves.toMatchObject({ reason: 'completed' })
  const terminal = await results('managed-terminal')
  expect(terminal.slice(1)).toEqual([
    { isError: true, text: expect.stringContaining(REFUSED) },
    { isError: true, text: expect.stringContaining(REFUSED) },
  ])
  expect(asked).toHaveLength(1)

  const managedTool = await fullAccess('managed-tool', { outwardCommandRules: true })
  await expect(turn('managed-tool')).resolves.toMatchObject({ reason: 'parked' })
  expect(questions().slice(1)).toEqual([
    { tool: 'todo', args: PLAN, checkpoint: 'outward', reviewer: 'human' },
  ])
  expect(await managedTool.decisions.list()).toHaveLength(1)

  // As on develop: full access answers the same push without a person, and the command runs.
  const ordinary = await fullAccess('ordinary-push', {})
  await expect(turn('ordinary-push')).resolves.toMatchObject({ reason: 'completed' })
  expect(asked).toHaveLength(2)
  expect((await ordinary.decisions.list()).map((decision) => decision.result)).toEqual([
    expect.objectContaining({ reason: 'answered', code: 'full-access' }),
  ])
  expect(await results('ordinary-push')).toEqual([
    { isError: true, text: expect.stringContaining("failed to push some refs to 'origin'") },
  ])
})
