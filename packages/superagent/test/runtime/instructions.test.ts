import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSystemPromptAppend } from '@agnes/protocol'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Ticket } from '../../src/core/index.js'
import {
  TICKET_INSTRUCTIONS_FILE,
  workerSystemPromptAppend,
  writeTicketInstructions,
} from '../../src/runtime/instructions.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sa-instructions-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const ticket = { id: 'tkt-42', title: 'Fix the flaky\nlogin test' } as Ticket
const env = {
  DSH_SUPERAGENT_TICKET: 'tkt-42',
  DSH_SUPERAGENT_NAME: 'fix-flaky-login',
  DSH_SUPERAGENT_DIR: '/work/fix-flaky-login',
  DSH_SUPERAGENT_BLOCKED_COMMANDS: 'curl wget',
  DSH_SUPERAGENT_GITHUB_REPOSITORY: 'acme/widgets',
  DSH_SUPERAGENT_GITHUB_ACCOUNT: 'agent-bot',
  DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL: '1+agent-bot@users.noreply.github.com',
  DSH_SUPERAGENT_GITHUB_NUMBER: '',
}

it('writes SUPERAGENT.md in the ticket directory with the value of every execution variable', async () => {
  await writeTicketInstructions(dir, ticket, env)
  expect(TICKET_INSTRUCTIONS_FILE).toBe('SUPERAGENT.md')
  expect(readdirSync(dir)).toEqual(['SUPERAGENT.md'])
  const text = readFileSync(join(dir, 'SUPERAGENT.md'), 'utf8')
  // The ticket, its repository, its directory and the agent account are all there, by the names DSH used.
  for (const [key, value] of Object.entries(env))
    expect(text).toContain(`- ${key} = ${JSON.stringify(value)}`)
  expect(text).toContain('tkt-42')
  // A title cannot break the file's structure.
  expect(text).toContain('Fix the flaky login test')
  expect(text).not.toContain('flaky\nlogin')
})

it('rewrites the file with the current values on the next launch', async () => {
  await writeTicketInstructions(dir, ticket, env)
  await writeTicketInstructions(dir, ticket, { ...env, DSH_SUPERAGENT_BLOCKED_COMMANDS: 'curl' })
  const text = readFileSync(join(dir, 'SUPERAGENT.md'), 'utf8')
  expect(text).toContain('- DSH_SUPERAGENT_BLOCKED_COMMANDS = "curl"')
  expect(text).not.toContain('curl wget')
  expect(readdirSync(dir)).toEqual(['SUPERAGENT.md'])
})

it("refers the worker session's opening system prompt append to the file", () => {
  const append = workerSystemPromptAppend(dir)
  expect(append).toContain(join(dir, 'SUPERAGENT.md'))
  expect(append).toContain('DSH_SUPERAGENT_')
  // A valid `systemPromptAppend` for session.new.
  expect(parseSystemPromptAppend(append)).toBe(append)
})
