/**
 * GitHub as the agent's `gh` sees it, for the real-daemon flow: repository `acme/app`, Issue #12 by Alice asking the
 * agent to fix the login page, its comments, and PR #7 once the worker opened it. The world is the scripted fake `gh`
 * (`fake-gh.mjs`) as a real executable; each change of the world rewrites its script, which every call reads anew, and
 * every call is logged with its arguments. Calls nothing here scripts fail, as `gh` would on an unknown route.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FAKE_GH = fileURLToPath(new URL('../fixtures/fake-gh.mjs', import.meta.url))
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
export const LOGIN = 'agent-bot'
export const REPOSITORY = 'acme/app'
export const ISSUE = 12
export const PR = 7
const API = `^api repos/${REPOSITORY}`

type Comment = {
  id: number
  body: string
  created_at: string
  updated_at: string
  html_url: string
  user: object
}
export interface GhCall {
  argv: string[]
  matched: boolean
  exit: number
}

export function githubWorld(dir: string, opened: string) {
  mkdirSync(dir, { recursive: true })
  const script = join(dir, 'script.json')
  const log = join(dir, 'gh.log')
  const cli = join(dir, 'gh')
  writeFileSync(
    cli,
    `#!/bin/sh\nFAKE_GH_SCRIPT=${quote(script)} FAKE_GH_LOG=${quote(log)} exec ${quote(process.execPath)} ${quote(FAKE_GH)} "$@"\n`,
  )
  chmodSync(cli, 0o755)
  const issue = {
    id: 1012,
    number: ISSUE,
    title: 'Login fails',
    body: `@${LOGIN} please fix the login page`,
    state: 'open',
    created_at: opened,
    updated_at: opened,
    html_url: `https://github.com/${REPOSITORY}/issues/${ISSUE}`,
    user: { login: 'alice', type: 'User' },
  }
  const state: { comments: Comment[]; pull?: Record<string, unknown> } = { comments: [] }
  const write = () => {
    const notification = {
      id: 'n12',
      updated_at: [opened, ...state.comments.map((comment) => comment.updated_at)].sort().at(-1),
      reason: 'mention',
      repository: { full_name: REPOSITORY },
      subject: {
        url: `https://api.github.com/repos/${REPOSITORY}/issues/${ISSUE}`,
        type: 'Issue',
        title: issue.title,
      },
    }
    const rules = [
      { pattern: '^api user$', stdout: JSON.stringify({ login: LOGIN, id: 42 }) },
      {
        // The setup check reads the repository through `--jq {name: .full_name, push: .permissions.push}`.
        pattern: `${API} --jq`,
        stdout: JSON.stringify({ name: REPOSITORY, push: true }),
      },
      {
        pattern: `${API}/notifications\\?`,
        stdout: `HTTP/2.0 200 OK\r\nX-Poll-Interval: 60\r\n\r\n${JSON.stringify([notification])}`,
      },
      // A comment Superagent posts: an acknowledgement or a reply.
      {
        pattern: `${API}/issues/${ISSUE}/comments --method POST`,
        stdout: JSON.stringify({ id: 9001, html_url: `${issue.html_url}#issuecomment-9001` }),
      },
      // The Issue's comments: polled since a time, and read whole before a post, to find an earlier copy of it.
      {
        pattern: `${API}/issues/${ISSUE}/comments( |\\?).*--slurp`,
        stdout: JSON.stringify([state.comments]),
      },
      { pattern: `${API}/issues/${ISSUE}$`, stdout: JSON.stringify(issue) },
      { pattern: '^pr create', stdout: `https://github.com/${REPOSITORY}/pull/${PR}\n` },
      ...(state.pull
        ? [
            { pattern: `${API}/pulls/${PR}$`, stdout: JSON.stringify(state.pull) },
            {
              pattern: `${API}/issues/${PR}$`,
              stdout: JSON.stringify({
                ...issue,
                id: 1007,
                number: PR,
                title: state.pull.title,
                pull_request: { url: 'x' },
                user: { login: LOGIN, type: 'User' },
              }),
            },
            { pattern: `${API}/(issues|pulls)/${PR}/(comments|reviews)\\?.*--slurp`, stdout: '[[]]' },
            {
              pattern: `${API}/commits/[0-9a-f]+/check-runs\\?.*--slurp`,
              stdout: '[{"total_count":0,"check_runs":[]}]',
            },
            { pattern: `${API}/commits/[0-9a-f]+/statuses\\?.*--slurp`, stdout: '[[]]' },
          ]
        : []),
    ]
    writeFileSync(script, JSON.stringify({ login: LOGIN, rules }))
  }
  write()
  const calls = (): GhCall[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as GhCall)
      : []
  return {
    cli,
    calls,
    /** Alice comments on the Issue now. */
    comment(id: number, body: string) {
      const at = new Date().toISOString()
      state.comments.push({
        id,
        body,
        created_at: at,
        updated_at: at,
        html_url: `${issue.html_url}#issuecomment-${id}`,
        user: { login: 'alice', type: 'User' },
      })
      write()
    },
    /** PR #7, which the agent opened from `branch`, as GitHub reads it: open, or merged. */
    pull(branch: string, merged = false) {
      const at = new Date().toISOString()
      state.pull = {
        number: PR,
        title: 'Fix the login page',
        state: merged ? 'closed' : 'open',
        merged,
        ...(merged ? { merged_at: at, closed_at: at } : {}),
        html_url: `https://github.com/${REPOSITORY}/pull/${PR}`,
        user: { login: LOGIN, type: 'User' },
        body: `Fixes #${ISSUE}`,
        created_at: at,
        head: {
          sha: '1111111111111111111111111111111111111111',
          ref: branch,
          repo: { full_name: REPOSITORY },
        },
      }
      write()
    },
    /** The comments Superagent posted on the Issue, by their body. */
    posted: () =>
      calls()
        .filter(
          (call) =>
            call.argv.includes('POST') && call.argv[1] === `repos/${REPOSITORY}/issues/${ISSUE}/comments`,
        )
        .map((call) => call.argv.find((arg) => arg.startsWith('body=')) ?? ''),
    unmatched: () => calls().filter((call) => !call.matched),
  }
}
