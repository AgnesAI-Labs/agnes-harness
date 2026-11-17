/** The variables a ticket's prepare command and worker session read, and the account-free names they are listed under. */
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  declaredVariables,
  environmentLines,
  environmentOf,
  executionRoot,
  ticketEnvironment,
} from '../src/app/execution-environment.js'
import type { Ticket, Trigger } from '../src/core/index.js'
import { SettingsSchema } from '../src/policy.js'
import { githubKind } from '../src/sources/github.js'
import { SourceRegistry } from '../src/sources/registry.js'
import { testDeployment } from './fixtures/deployment.js'

const settingsOf = (github: { enabled: boolean }) =>
  SettingsSchema.parse({
    executor: { blockedCommands: ['curl', 'ssh'] },
    sources: { github: { enabled: github.enabled, config: {} } },
  })
const registry = (settings: ReturnType<typeof settingsOf>) => {
  const sources = new SourceRegistry(() => settings)
  sources.register(githubKind)
  return sources
}
const pull: Trigger = {
  id: 'g1',
  source: 'github',
  threads: [{ source: 'github', id: '12' }],
  actor: { source: 'github', id: 'alice' },
  human: true,
  at: '',
  text: 'fix',
  meta: { number: 12, isPr: true },
}
const value = (variables: { key: string; value: string }[], key: string) =>
  variables.find((variable) => variable.key === key)?.value

it('lists the executor variables, those of the ticket only once there is one, and the Source variables of the trigger', () => {
  const settings = settingsOf({ enabled: true })
  const input = { deployment: testDeployment(), sources: registry(settings), settings }
  const bare = environmentOf(input)
  expect(bare.map((variable) => variable.key)).not.toContain('DSH_SUPERAGENT_DIR')
  expect(value(bare, 'DSH_SUPERAGENT_BLOCKED_COMMANDS')).toBe('curl ssh')
  expect(value(bare, 'DSH_SUPERAGENT_GITHUB_REPOSITORY')).toBe('acme/widgets')
  expect(value(bare, 'DSH_SUPERAGENT_GITHUB_NUMBER')).toBe('')
  const ticket = { id: 't1', name: 'fix-copy', directory: '/work/fix-copy' }
  const full = environmentOf({ ...input, ticket, trigger: pull })
  expect([
    value(full, 'DSH_SUPERAGENT_DIR'),
    value(full, 'DSH_SUPERAGENT_NAME'),
    value(full, 'DSH_SUPERAGENT_TICKET'),
    value(full, 'DSH_SUPERAGENT_GITHUB_NUMBER'),
    value(full, 'DSH_SUPERAGENT_GITHUB_PR_HEAD'),
    value(full, 'DSH_SUPERAGENT_GITHUB_ACCOUNT'),
  ]).toEqual(['/work/fix-copy', 'fix-copy', 't1', '12', 'refs/pull/12/head', 'agent-bot'])
  expect(full.find((variable) => variable.key === 'DSH_SUPERAGENT_DIR')?.owner).toBe('executor')
  expect(full.find((variable) => variable.key === 'DSH_SUPERAGENT_GITHUB_NUMBER')?.owner).toBe('github')
})

it("takes a ticket's directory and name as the ticket recorded them, and leaves a Source that is off out", () => {
  const settings = settingsOf({ enabled: false })
  const ticket = { id: 't9', execution: { name: 'n', directory: '/d' } } as unknown as Ticket
  const variables = ticketEnvironment({
    deployment: testDeployment(),
    sources: registry(settings),
    settings,
    ticket,
  })
  expect([value(variables, 'DSH_SUPERAGENT_DIR'), value(variables, 'DSH_SUPERAGENT_NAME')]).toEqual([
    '/d',
    'n',
  ])
  expect(variables.map((variable) => variable.owner)).toEqual([
    'executor',
    'executor',
    'executor',
    'executor',
  ])
  expect(
    declaredVariables(registry(settings), settings).map(({ owner, enabled }) => [owner, enabled]),
  ).toEqual([
    ['executor', true],
    ['github', false],
  ])
})

it('roots the ticket directories in the state directory unless the settings name another, and words each variable for the prompt', () => {
  const settings = settingsOf({ enabled: true })
  // A path of the daemon's machine, joined as its paths join.
  expect(executionRoot(settings, '/state')).toBe(join('/state', 'work'))
  expect(
    executionRoot({ ...settings, executor: { ...settings.executor, directory: '/elsewhere' } }, '/state'),
  ).toBe('/elsewhere')
  expect(
    environmentLines([
      { key: 'A', value: 'a "b"', description: { zh: '甲', en: 'The first' }, owner: 'executor' },
    ]),
  ).toBe('- A = "a \\"b\\"": The first.')
})
