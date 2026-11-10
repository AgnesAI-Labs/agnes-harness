import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGH_DIR } from '../../../packages/protocol/src/constants.js'
import {
  createSkillSaveTransport,
  loadSkillSaveModules,
  refreshAfterSave,
  type SkillSaveTransport,
  skillSaveTransport,
} from './skill-save.js'

// These tests run the daemon's own request handler and installers over a resource-control store on
// disk: no model, no host. They show what the embedded eval host gets when it is given the transport.

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const doc = (name: string, body: string) => `---\nname: ${name}\ndescription: Saved skill\n---\n${body}\n`
const install = (name: string, body: string) => ({
  op: 'install',
  draft: { name, class: 'instructions', files: [{ path: 'SKILL.md', content: doc(name, body) }] },
  receiptId: `receipt-${name}`,
  source: {
    sessionKey: 'rsi-eval-run-s1',
    kind: 'skill',
    entryId: 'entry-1',
    contentHash: 'c'.repeat(64),
    initiator: 'auto',
  },
})

const setup = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rsi-eval-skill-save-')))
  roots.push(root)
  const home = join(root, 'home')
  const dataDir = join(home, 'data')
  const workspace = join(root, 'workspace')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(workspace)
  return { home, dataDir, workspace }
}

describe('the skill transport of the eval host', () => {
  it('installs a saved skill into the workspace skill folder of the requesting session', async () => {
    const w = setup()
    const transport = createSkillSaveTransport({
      ...w,
      profile: 'local-dev',
      workspaceOf: (key) => (key === 'rsi-eval-run-s1' ? w.workspace : undefined),
      enabled: () => true,
      modules: await loadSkillSaveModules(),
      pollMs: 5,
    })
    const reply = await transport(
      'rsi-eval-run-s1',
      install('tidy-notes', 'One.'),
      new AbortController().signal,
    )
    expect(reply).toMatchObject({ ok: true, authorizedBy: 'refinement-enabled' })
    expect(readFileSync(join(w.workspace, AGH_DIR, 'skills', 'tidy-notes', 'SKILL.md'), 'utf8')).toBe(
      doc('tidy-notes', 'One.'),
    )
  })

  it('writes nothing for a session that is not open, or while the switch reads off', async () => {
    const w = setup()
    let on = false
    const transport = createSkillSaveTransport({
      ...w,
      profile: 'local-dev',
      workspaceOf: (key) => (key === 'rsi-eval-run-s1' ? w.workspace : undefined),
      enabled: () => on,
      modules: await loadSkillSaveModules(),
      pollMs: 5,
    })
    const signal = new AbortController().signal
    expect(await transport('nobody', install('tidy-notes', 'One.'), signal)).toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
    expect(await transport('rsi-eval-run-s1', install('tidy-notes', 'One.'), signal)).toEqual({
      ok: false,
      reason: 'refinement-off',
    })
    expect(existsSync(join(w.workspace, AGH_DIR))).toBe(false)
    on = true
    expect(await transport('rsi-eval-run-s1', install('tidy-notes', 'One.'), signal)).toMatchObject({
      ok: true,
    })
  })

  it('is not made at all for a run with refinement off', async () => {
    const w = setup()
    const input = {
      ...w,
      profile: 'local-dev',
      workspaceOf: () => w.workspace,
      enabled: () => true,
      modules: await loadSkillSaveModules(),
    }
    expect(skillSaveTransport(undefined, input)).toBeUndefined()
    expect(skillSaveTransport({ enabled: false }, input)).toBeUndefined()
    expect(skillSaveTransport({ enabled: true }, input)).toBeTypeOf('function')
  })
})

// The host side: the CLI's own skill view of an embedded host (`createLocalSkills`, what `bootLocal` gives
// the host, `refreshSkills` being its `refresh`), read the way a turn reads it. No model, no host shell.
type View = {
  input: {
    scopeWorkspace<T>(root: string, sessionKey: string, invoke: () => Promise<T>): Promise<T>
    list(): readonly { name: string; actual: string }[]
  }
  refresh(): void
}
const hostSkills = async (home: string, dataDir: string): Promise<View> => {
  const runtime = (await import('../../../packages/resource-control-runtime/src/index.ts')) as {
    createSkillCandidateRegistry(options: { barrier: object }): unknown
  }
  const cli = (await import('../../../packages/cli/src/boot/local-skills.ts')) as {
    createLocalSkills(options: object): View
  }
  const registry = runtime.createSkillCandidateRegistry({
    barrier: { quiesce: (_id: string, publish: (permit: unknown) => Promise<unknown>) => publish(undefined) },
  })
  return cli.createLocalSkills({
    registry,
    agnesHome: home,
    osHome: home,
    importUserSkills: false,
    decisions: { dataDir, profile: 'local-dev' },
    log: () => {},
  })
}
/** The skills a request of the session offers: what its turn reads inside the session's workspace scope. */
const offered = (view: View, workspace: string, sessionKey: string) =>
  view.input.scopeWorkspace(workspace, sessionKey, async () =>
    view.input
      .list()
      .filter((skill) => skill.actual === 'ready')
      .map((skill) => skill.name),
  )

describe('a skill the eval transport saves is offered to the next request', () => {
  const run = async (wrap: (transport: SkillSaveTransport, refresh: () => void) => SkillSaveTransport) => {
    const w = setup()
    const view = await hostSkills(w.home, w.dataDir)
    let refreshes = 0
    let on = false
    const transport = wrap(
      createSkillSaveTransport({
        ...w,
        profile: 'local-dev',
        workspaceOf: (key) => (key === 'rsi-eval-run-s1' ? w.workspace : undefined),
        enabled: () => on,
        modules: await loadSkillSaveModules(),
        pollMs: 5,
      }),
      () => {
        refreshes++
        view.refresh()
      },
    )
    const signal = new AbortController().signal
    const before = await offered(view, w.workspace, 'rsi-eval-run-s1')
    // A refused save asks for no rescan.
    const refused = await transport('rsi-eval-run-s1', install('tidy-notes', 'One.'), signal)
    const afterRefused = refreshes
    on = true
    const saved = await transport('rsi-eval-run-s1', install('tidy-notes', 'One.'), signal)
    return {
      before,
      refused,
      afterRefused,
      saved,
      refreshes,
      next: await offered(view, w.workspace, 'rsi-eval-run-s1'),
    }
  }

  it('offers it to the same session from its next request, after the refresh the save asks for', async () => {
    const r = await run(refreshAfterSave)
    expect(r.before).toEqual([])
    expect(r.refused).toEqual({ ok: false, reason: 'refinement-off' })
    expect(r.afterRefused).toBe(0)
    expect(r.saved).toMatchObject({ ok: true })
    expect(r.refreshes).toBe(1)
    expect(r.next).toEqual(['tidy-notes'])
  })

  it('without the refresh, the session that saved it is not offered it', async () => {
    const r = await run((transport) => transport)
    expect(r.saved).toMatchObject({ ok: true })
    expect(r.next).toEqual([])
  })
})
