import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Variable } from '../../src/app/execution-environment.js'
import { Prompts } from '../../src/app/prompts.js'
import { writeTicketInstructions } from '../../src/runtime/instructions.js'
import { sectionText, SkillFiles } from '../../src/runtime/prompt.js'
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
].map(([key, value]) => ({ key: key!, value: value!, description: { en: key!, zh: key! }, owner: 'executor' }))

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
  const h = host()
  const version = h.prompts.current()
  expect(sectionText(h, version, { kind: 'orchestrator' })).toMatchSnapshot('orchestrator section')
  expect(sectionText(h, version, { kind: 'worker', ticketId: 't1' })).toMatchSnapshot('worker section')
  new SkillFiles(h.prompts, join(dir, 'skills')).write(version)
  for (const name of readdirSync(join(dir, 'skills')).sort())
    expect(readFileSync(join(dir, 'skills', name, 'SKILL.md'), 'utf8')).toMatchSnapshot(`skill ${name}`)
  await writeTicketInstructions(dir, { id: 't1', title: 'Fix login' }, { DSH_SUPERAGENT_NAME: 'fix-login-0123abcd' })
  expect(readFileSync(join(dir, 'SUPERAGENT.md'), 'utf8')).toMatchSnapshot('ticket instructions')
})
