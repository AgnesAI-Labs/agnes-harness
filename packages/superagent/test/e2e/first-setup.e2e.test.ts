// The first setup on a real daemon: a fresh home installs the shipped payload from its official bundled source, as the
// marketplace does, so the bundled-app grant applies. With no repository set, Superagent waits for setup and still lists
// the GitHub Source; saving the repository there clears the setup problem and starts the GitHub Source, which polls the
// agent's `gh`, without a restart.
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { type DaemonHandle, startDaemon, stopAllDaemons } from '../fixtures/daemon-harness.js'
import { defaultStateDir, EXTENSION, ownerCalls, sleep, until } from '../runtime/integration-fixtures.js'
import { githubWorld, REPOSITORY } from './github-world.js'

afterAll(stopAllDaemons)

/** The official bundled source of the payload: the reference the marketplace installs it from. */
const BUNDLED = './bundled-plugins/superagent'

interface SetupView {
  problem?: { code: string }
}
interface SourceRow {
  id: string
  value?: { enabled: boolean; config: Record<string, unknown> }
  revision?: number
}

it('lists the GitHub Source before setup, and saving its repository completes setup and starts it', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agh-superagent-first-')))
  const world = githubWorld(join(root, 'github'), new Date(Date.now() - 1800_000).toISOString())
  const aghHome = join(root, 'agh')
  // The daemon starts as usual, with the operator's HOME and PATH.
  const home = join(root, 'operator-home')
  mkdirSync(home)
  let handle: DaemonHandle | undefined
  try {
    const daemon = await startDaemon({
      aghHome,
      home,
      path: process.env.PATH ?? '',
      plugins: [BUNDLED],
      onHandle: (started) => {
        handle = started
      },
    })
    const calls = ownerCalls(() => daemon.client)
    /** The GitHub Source's notification polls, apart from the setup check's single read. */
    const polls = () =>
      world.calls().filter((call) => call.argv[1]?.startsWith(`repos/${REPOSITORY}/notifications?all=true`))
        .length
    const listed = await daemon.client.packages.list({ profile: 'local-dev' })
    expect(
      listed.packages.find((entry: { id: string }) => entry.id === '@agnes/superagent')?.source,
      'installed from the official bundled source',
    ).toMatchObject({ type: 'file', ref: `file:${BUNDLED}` })

    // Fresh state: nothing set, so Superagent waits for the repository.
    const waiting = await until('the setup problem', async () => {
      const state = await calls.service('superagent.state').catch(() => undefined)
      const setup = state?.setup as SetupView | undefined
      return setup?.problem ? setup : undefined
    })
    expect(waiting.problem?.code).toBe('repositoryUnset')
    const sources = (await calls.service('superagent.sources.list')) as unknown as SourceRow[]
    expect(sources.map((source) => source.id)).toContain('github')
    const settings = (await calls.service('superagent.settings.get')) as { sources: SourceRow[] }
    const github = settings.sources.find((source) => source.id === 'github')
    expect(github, 'the settings carry the GitHub Source').toBeDefined()
    // A window while waiting for setup: the GitHub Source is listed, yet it never reads notifications.
    await sleep(3000)
    expect(polls(), 'no notifications poll before setup').toBe(0)
    expect(world.calls(), 'no gh call at all before setup').toEqual([])

    // The save the panel's GitHub card sends, as an effect of the owner's own panel.
    const saved = await daemon.client.extensions.callScoped({
      extension: EXTENSION,
      service: 'superagent.settings.save',
      input: {
        block: 'source:github',
        value: { enabled: true, config: { repository: REPOSITORY, cli: world.cli } },
        revision: github?.revision ?? 0,
      },
      operationId: `first-setup-${randomUUID()}`,
    })
    expect(saved).toMatchObject({ state: 'completed', output: { saved: true, restarting: true } })

    // Setup goes on to start the GitHub Source without a restart: the problem clears and it polls the agent's `gh`.
    await until('setup to complete', async () => {
      const state = await calls.service('superagent.state').catch(() => undefined)
      return state && !(state.setup as SetupView).problem
    })
    await until('the GitHub Source to poll', () => polls() > 0)
    // The setup check read the notifications once, as a token that cannot read them would fail there.
    expect(
      world
        .calls()
        .filter((call) => call.argv[1] === `repos/${REPOSITORY}/notifications?per_page=1`)
        .map((call) => call.exit),
    ).toContain(0)
    const after = (await calls.service('superagent.sources.list')) as unknown as (SourceRow & {
      state: string
    })[]
    expect(after.find((source) => source.id === 'github')?.state).not.toBe('setup')
  } finally {
    await handle?.stop()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 600_000)
