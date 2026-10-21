import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import type { ApprovalRequest } from '@agnes/core'
import { createTestHost } from '../../testkit/index.js'

const [file, phase] = process.argv.slice(2)
if (!file || !['hold', 'allow', 'replay'].includes(phase ?? ''))
  throw new Error('Missing crash fixture arguments')
const config = JSON.parse(readFileSync(file, 'utf8'))
const questions: ApprovalRequest[] = []
const host = (
  await createTestHost({
    dataDir: config.dataDir,
    packageDirs: config.packageDirs,
    runtimePluginCatalogue: [config.source],
    extensionLoader: { import: async (file) => await import(pathToFileURL(file).href) },
    treeBudgetCredits: 100,
    disableSessionTitle: true,
    seams: {
      approval: {
        ask: async (request, options) => {
          questions.push(request)
          writeFileSync(join(config.dataDir, `${phase}-question.json`), JSON.stringify(request))
          if (phase === 'hold')
            return new Promise((resolve) =>
              options?.signal.addEventListener(
                'abort',
                () => resolve({ verdict: 'cancelled', reason: 'stopped' }),
                { once: true },
              ),
            )
          return request.delegation
            ? { verdict: 'allowed-once', answeredBy: config.human }
            : { verdict: 'rejected', answeredBy: config.human }
        },
      },
    },
    provider: (profile) =>
      new ScriptedProvider({
        models: profile.provider.routes?.flatMap((r) => r.models ?? []) ?? [],
        scripts: [
          (request) => {
            if (phase !== 'hold' || request.messages.at(-1)?.role !== 'user')
              return [{ type: 'done', reason: 'stop' }]
            return [
              {
                type: 'toolcall_end',
                via: 'native',
                call: {
                  toolUseId: '',
                  ordinal: 0,
                  ...(request.sessionKey === 'parent'
                    ? {
                        name: 'subagent_spawn',
                        args: { role: config.role, task: 'Write cold requirements', wait: true },
                      }
                    : { name: 'write', args: { path: 'cold.md', content: 'Cold child requirements' } }),
                },
              },
              { type: 'done', reason: 'toolUse' },
            ]
          },
        ],
      }),
  })
).host
await host.applyRuntimeTarget(config.target)
const parent = await host.createSession({ key: 'parent', cwd: config.dataDir })
if (phase === 'hold')
  await parent.enqueue('next-turn', {
    actor: parent.d.actor,
    trust: 'untrusted',
    content: [{ type: 'text', text: 'Delegate cold requirements' }],
  })
await parent.run({ until: 'turn-end', signal: AbortSignal.timeout(80000) })
if (phase === 'hold') throw new Error('Pending human gate unexpectedly settled')
if (phase === 'replay') {
  if (questions.length) throw new Error('Consumed decision was offered again')
  const previous = JSON.parse(readFileSync(join(config.dataDir, 'cold-result.json'), 'utf8'))
  const child = await host.createSession({ key: previous.decision.handle.sessionId, cwd: config.dataDir })
  writeFileSync(
    join(config.dataDir, 'replay-result.json'),
    JSON.stringify({
      decision: await child.decisions.get(previous.decision.handle),
      calls: await child.scan({ type: 'tool/call', limit: 100 }),
      role: child.d.roleDelegation,
    }),
  )
  await host.close()
  process.exit(0)
}
const question = questions.find((request) => request.delegation)
if (!question?.decision) throw new Error('Cold child question was not reoffered')
const key = question.decision.handle.sessionId!
for (let attempt = 0; attempt < 200; attempt++) {
  const child = host.kernel.get(key)
  const decision = child ? await child.decisions.get(question.decision.handle) : undefined
  if (decision?.consumption) {
    writeFileSync(
      join(config.dataDir, 'cold-result.json'),
      JSON.stringify({
        question,
        decision,
        role: child?.d.roleDelegation,
        calls: await child?.scan({ type: 'tool/call', limit: 100 }),
      }),
    )
    break
  }
  if (attempt === 199) throw new Error('Cold child effect was not consumed')
  await new Promise((resolve) => setTimeout(resolve, 50))
}
await host.close()
