import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Variable } from '../../src/app/execution-environment.js'
import { Prompts } from '../../src/app/prompts.js'
import { writeTicketInstructions } from '../../src/runtime/instructions.js'
import { SkillFiles, sectionText } from '../../src/runtime/prompt.js'
import { tempStore, ticket } from './helpers.js'

// What the sessions read: the prompt section of each role, the skills and the ticket instruction file. The POSIX texts
// are pinned by snapshot, as the original writes them, so that Windows support leaves them and the prompt cache as they
// were.
let temp: ReturnType<typeof tempStore>
let dir: string
beforeEach(() => {
  temp = tempStore()
  dir = mkdtempSync(join(tmpdir(), 'sa-prompt-platform-'))
})
afterEach(() => {
  temp.close()
  rmSync(dir, { recursive: true, force: true })
})

const VARIABLES: Variable[] = [
  ['DSH_SUPERAGENT_NAME', 'fix-login-0123abcd'],
  ['DSH_SUPERAGENT_GITHUB_REPOSITORY', 'acme/widgets'],
  ['DSH_SUPERAGENT_GITHUB_ACCOUNT', 'agent-bot'],
  ['DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL', '1+agent-bot@users.noreply.github.com'],
].map(([key, value]) => ({
  key: key!,
  value: value!,
  description: { en: key!, zh: key! },
  owner: 'executor',
}))

function host() {
  const prompts = new Prompts(
    temp.store,
    () => 100_000,
    () => undefined,
    () => false,
  )
  temp.store.tickets.save(ticket('t1'))
  return { prompts, store: temp.store, environment: () => VARIABLES }
}

it('keeps the POSIX prompt sections, skills and ticket instructions as they were', async () => {
  const h = { ...host(), platform: 'linux' }
  const version = h.prompts.current()
  expect(sectionText(h, version, { kind: 'orchestrator' })).toMatchSnapshot('orchestrator section')
  expect(sectionText(h, version, { kind: 'worker', ticketId: 't1' })).toMatchSnapshot('worker section')
  new SkillFiles(h.prompts, join(dir, 'skills'), { platform: 'linux' }).write(version)
  for (const name of readdirSync(join(dir, 'skills')).sort())
    expect(readFileSync(join(dir, 'skills', name, 'SKILL.md'), 'utf8')).toMatchSnapshot(`skill ${name}`)
  await writeTicketInstructions(
    dir,
    { id: 't1', title: 'Fix login' },
    { DSH_SUPERAGENT_NAME: 'fix-login-0123abcd' },
    'linux',
  )
  expect(readFileSync(join(dir, 'SUPERAGENT.md'), 'utf8')).toMatchSnapshot('ticket instructions')
})

it('writes the texts for PowerShell on Windows: no POSIX variable or assignment is left', async () => {
  const h = { ...host(), platform: 'win32' }
  const version = h.prompts.current()
  const posix = /(?<!env:)\$DSH_|`\w+=\$\(|`[A-Z_]+=\S+ /
  const worker = sectionText(h, version, { kind: 'worker', ticketId: 't1' })
  const orchestrator = sectionText(h, version, { kind: 'orchestrator' })
  for (const text of [worker, orchestrator]) expect(text).not.toMatch(posix)
  expect(worker).toContain(
    'otherwise as $env:DSH_SUPERAGENT_GITHUB_ACCOUNT with $env:DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL',
  )
  expect(worker).toContain('set `$base = git merge-base HEAD origin/<base branch>`')
  expect(worker).toContain(
    '`$env:FILTER_BRANCH_SQUELCH_WARNING = \'1\'; git filter-branch -f --msg-filter "git interpret-trailers --if-exists addIfDifferent --trailer \'<trailer>\'" "$base..HEAD"`',
  )
  expect(worker).toContain('`git push "--force-with-lease=<head branch>:$old"`')
  expect(worker, 'a Windows worker learns its gh cannot take a line break').toContain('--body-file <file>')
  expect(orchestrator).not.toContain('--body-file <file>')
  new SkillFiles(h.prompts, join(dir, 'skills'), { platform: 'win32' }).write(version)
  const skill = readFileSync(join(dir, 'skills', 'dsh-superagent-github', 'SKILL.md'), 'utf8')
  expect(skill).toContain('is `$env:DSH_SUPERAGENT_GITHUB_REPOSITORY` from the execution environment section')
  expect(skill).not.toMatch(posix)
  await writeTicketInstructions(dir, { id: 't1', title: 'Fix login' }, { DSH_SUPERAGENT_NAME: 'x' }, 'win32')
  expect(readFileSync(join(dir, 'SUPERAGENT.md'), 'utf8')).toContain(
    "in a PowerShell command, set it first, for example `$env:DSH_SUPERAGENT_NAME = '<value>'; ...`.",
  )
})

it('reports skill files it cannot write to the panel and goes on, then reports them written', () => {
  const h = host()
  const reports: { state: string; detail: string }[] = []
  const root = join(dir, 'skills')
  // A file where the skills directory belongs: every write fails, as a held file does once its retries are spent.
  writeFileSync(root, '')
  const skills = new SkillFiles(h.prompts, root, { health: { set: (health) => reports.push(health) } })
  const version = h.prompts.current()
  expect(() => skills.write(version)).not.toThrow()
  expect(reports).toMatchObject([{ state: 'error', detail: expect.stringContaining(root) }])
  rmSync(root)
  skills.write(version)
  expect(reports.at(-1)).toMatchObject({ state: 'ready' })
  expect(readdirSync(root)).toEqual(['dsh-superagent-github'])
})
