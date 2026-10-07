import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import type { InferenceEvent, ToolCall } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { createTestHost } from '../../testkit/index.js'

const call = (name: string, args: ToolCall['args']): InferenceEvent[] => [
  { type: 'toolcall_end', call: { toolUseId: '', name, args, ordinal: 0 }, via: 'native' },
  { type: 'done', reason: 'toolUse' },
]
const say = (delta: string): InferenceEvent[] => [
  { type: 'text_delta', delta },
  { type: 'done', reason: 'stop' },
]

it.skipIf(process.platform === 'win32')(
  'shares official shell jobs across turns and kills them on session close',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-default-jobs-'))
    await mkdir(join(root, 'jobwork'))
    const provider = new ScriptedProvider({
      models: [fakeModel({ route: 'gw', id: 'm1' })],
      scripts: [
        call('shell', { command: 'echo $$ > job.pid; sleep 30', background: true, cwd: 'jobwork' }),
        say('Started.'),
        call('job_list', {}),
        say('Listed.'),
      ],
      onExhausted: 'error',
    })
    const { host } = await createTestHost({
      dataDir: root,
      packageDirs: { '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)) },
      provider,
      disableSessionTitle: true,
      presets: {
        standard: {
          name: 'standard',
          extends: 'base',
          disclosure: 'standard',
          sandbox: { level: 'L0', required: false, on_unavailable: 'allow' },
        },
      },
    })
    try {
      const session = await host.createSession({ cwd: root })
      const run = async (text: string) => {
        await session.enqueue('next-turn', {
          content: [{ type: 'text', text }],
          actor: session.d.actor,
          kind: 'prompt',
        })
        return session.run({ until: 'turn-end', signal: new AbortController().signal })
      }
      expect(await run('Start job')).toMatchObject({ reason: 'completed' })
      await expect.poll(() => readFileSync(join(root, 'jobwork', 'job.pid'), 'utf8')).toMatch(/^\d+\n$/)
      const pid = Number(readFileSync(join(root, 'jobwork', 'job.pid'), 'utf8'))
      expect(await run('List jobs')).toMatchObject({ reason: 'completed' })
      const results = await session.scan({ type: 'tool/result', toSeq: session.lastSeq })
      expect(JSON.stringify(results.at(-1)?.data)).toContain('running')
      expect(JSON.stringify(results.at(-1)?.data)).toContain('echo $$')
      await session.close()
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)
