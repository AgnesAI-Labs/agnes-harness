import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyResults } from './result.mjs'
import { heavyShard } from './run-heavy-shard.mjs'
import { changedPaths, detectDocsOnly, isDocsOnly } from './scope.mjs'
import { verifyStoryResult } from './story-results.mjs'

const directories: string[] = []

describe('story regression results', () => {
  it('requires the named fixture to execute, so a renamed, skipped or todo case cannot turn the gate green', () => {
    const report = (fullName: string, status: string, success = true) => ({
      success,
      testResults: [{ assertionResults: [{ fullName, status }] }],
    })
    expect(verifyStoryResult(report('story exact fixture', 'passed'), ['exact fixture'])).toBe(1)
    for (const status of ['failed', 'pending', 'skipped', 'todo'])
      expect(() => verifyStoryResult(report('story exact fixture', status), ['exact fixture'])).toThrow()
    expect(() => verifyStoryResult(report('renamed fixture', 'passed'), ['exact fixture'])).toThrow()
    expect(() =>
      verifyStoryResult(report('story exact fixture', 'passed', false), ['exact fixture']),
    ).toThrow()
    expect(() =>
      verifyStoryResult(report('story exact fixture', 'passed'), ['exact fixture', 'missing table row']),
    ).toThrow()
    expect(() => verifyStoryResult(report('story exact fixture', 'passed'), [])).toThrow()
  })
})
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), 'agh-ci-'))
  directories.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const cwd = temporary()
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git('-c', 'init.templateDir=', 'init', '--initial-branch=main')
  git('config', 'user.name', 'CI fixture')
  git('config', 'user.email', 'ci@example.invalid')
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), text)
  }
  const commit = () => {
    git('add', '.')
    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture')
    return git('rev-parse', 'HEAD')
  }
  write('README.md', 'Documentation\n')
  write('packages/example/index.ts', 'export const value = 1\n')
  return { cwd, git, write, commit, base: commit() }
}

function workflowJob(source: string, name: string) {
  return source.split(`\n  ${name}:\n`)[1]?.split(/\n {2}[a-z][a-z0-9-]*:\n/)[0] ?? ''
}
function platformCheckRows(workflow: string) {
  return ['linux', 'macos', 'windows'].flatMap((platform) => {
    const body = workflowJob(workflow, `check-${platform}`)
    const runner = /^ {6}runner: (.+)$/m.exec(body)?.[1]
    const shards = /^ {6}shards: '([^']+)'$/m.exec(body)?.[1]
    if (!runner || !shards) throw new Error('Missing platform check runner or shards')
    return (JSON.parse(shards) as string[]).map((shard) => ['', runner, shard])
  })
}
function platformHeavyOs(workflow: string, event: string): string[] {
  return ['linux', 'macos', 'windows'].flatMap((platform) => {
    const body = workflowJob(workflow, `heavy-${platform}`)
    const runner = /^ {6}runner: (.+)$/m.exec(body)?.[1]
    const condition = /^ {4}if: (.+)$/m.exec(body)?.[1]
    const expected =
      "needs.changes.outputs.docs-only != 'true'" +
      (platform === 'linux' ? '' : " && github.event_name != 'pull_request'")
    expect(condition).toBe(expected)
    if (!runner) throw new Error('Missing heavy runner')
    return platform === 'linux' || event !== 'pull_request' ? [runner] : []
  })
}

describe('CI scope', () => {
  it('uses the repository Node pin in every setup-node step', () => {
    const workflows = fileURLToPath(new URL('../../.github/workflows/', import.meta.url))
    for (const name of readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name))) {
      const workflow = readFileSync(join(workflows, name), 'utf8')
      const setups = workflow.match(/uses: actions\/setup-node@/g) ?? []
      expect(workflow, name).not.toMatch(/\bnode-version:/)
      expect(workflow.match(/node-version-file: \.node-version\b/g) ?? [], name).toHaveLength(setups.length)
    }
  })

  it('runs the native PowerShell file once on Windows for PRs and every full-platform event', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
    const file = 'packages/host-infrastructure/test/adapters/powershell-file.e2e.test.ts'
    const check = workflowJob(
      readFileSync(new URL('../../.github/workflows/ci-platform-check.yml', import.meta.url), 'utf8'),
      'check',
    )
    const steps = check.split(/\n {6}- /)
    const isolated = steps.filter((step) => step.includes(`run: pnpm exec vitest run ${file}`))
    expect(isolated).toHaveLength(1)
    const step = isolated[0] as string
    const command = /^ {8}run: (.+)$/m.exec(step)?.[1]?.trim().split(/\s+/)
    expect(command).toEqual(['pnpm', 'exec', 'vitest', 'run', file, '--maxWorkers=1'])
    expect(steps.indexOf(step)).toBeGreaterThan(steps.findIndex((s) => s.includes('id: suite')))
    const condition = /^ {8}if: (.+)$/m.exec(step)?.[1] ?? ''
    const checkRows = platformCheckRows(workflow)
    expect(checkRows.length).toBeGreaterThan(0)
    const osNames: Record<string, string> = {
      'ubuntu-latest': 'Linux',
      'macos-latest': 'macOS',
      'windows-latest': 'Windows',
    }
    const matches = (os: string, shard: string, event: string) => {
      const context: Record<string, string> = {
        'runner.os': os,
        'matrix.shard': shard,
        'github.event_name': event,
      }
      return condition.split(/\s*&&\s*/).every((clause) => {
        const equality = /^(runner\.os|matrix\.shard|github\.event_name) == '([^']+)'$/.exec(clause)
        if (!equality) throw new Error('unsupported isolated-step condition')
        return context[equality[1] as string] === equality[2]
      })
    }
    const heavy = workflowJob(
      readFileSync(new URL('../../.github/workflows/ci-platform-heavy.yml', import.meta.url), 'utf8'),
      'heavy',
    )
    const { lists } = JSON.parse(readFileSync(new URL('./heavy-shards.json', import.meta.url), 'utf8'))
    const excluded = /AGNES_TEST_EXCLUDE: \$\{\{ runner.os == 'Windows' && '([^']*)' \|\| '' \}\}/.exec(heavy)
    expect(excluded === null).toBe(false)
    const held = new Set(excluded?.[1]?.split(',') ?? [])
    const shardOwners = [1, 2, 3, 4, 5, 6].filter((index) => {
      const shard = heavyShard(`${index}/6`, lists)
      return !held.has(file) && (shard.files ? shard.files.includes(file) : !shard.exclude?.includes(file))
    })
    expect(shardOwners).toEqual([6])
    for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch']) {
      const extra = checkRows.filter((row) => matches(osNames[row[1] as string] ?? '', row[2] ?? '', event))
      expect(
        extra.map((row) => [row[1], row[2]]),
        event,
      ).toEqual(event === 'pull_request' ? [['windows-latest', '1/6']] : [])
      const heavyOs = platformHeavyOs(workflow, event)
      const nativeHeavy = heavyOs.includes('windows-latest') ? shardOwners.length : 0
      expect(extra.length + nativeHeavy, event).toBe(1)
    }
  })

  it('keeps the registry process file in one native lane per OS for PRs and full-platform events', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
    const file = 'packages/host-infrastructure/test/refinement-registry-processes.e2e.test.ts'
    const check = workflowJob(
      readFileSync(new URL('../../.github/workflows/ci-platform-check.yml', import.meta.url), 'utf8'),
      'check',
    )
    const steps = check.split(/\n {6}- /)
    const isolated = steps.filter((step) =>
      step.includes(`run: pnpm exec vitest run --project heavy ${file}`),
    )
    expect(isolated).toHaveLength(2)
    const commands = check
      .split('\n')
      .filter((line) => line.trimStart().startsWith('run:') && line.includes(file))
    expect(commands).toHaveLength(isolated.length)
    for (const step of isolated) {
      expect(/^ {8}run: (.+)$/m.exec(step)?.[1]?.trim().split(/\s+/)).toEqual([
        'pnpm',
        'exec',
        'vitest',
        'run',
        '--project',
        'heavy',
        file,
        '--maxWorkers=1',
      ])
      expect(steps.indexOf(step)).toBeGreaterThan(steps.findIndex((s) => s.includes('id: suite')))
    }
    const rows = platformCheckRows(workflow)
    expect(rows).toHaveLength(13)
    const osNames: Record<string, string> = {
      'ubuntu-latest': 'Linux',
      'macos-latest': 'macOS',
      'windows-latest': 'Windows',
    }
    const matches = (step: string, os: string, shard: string, event: string) => {
      const context: Record<string, string> = {
        'runner.os': os,
        'matrix.shard': shard,
        'github.event_name': event,
      }
      const condition = /^ {8}if: (.+)$/m.exec(step)?.[1] ?? ''
      return condition.split(/\s*&&\s*/).every((clause) => {
        const equality = /^(runner\.os|matrix\.shard|github\.event_name) == '([^']+)'$/.exec(clause)
        if (!equality) throw new Error('unsupported isolated-step condition')
        return context[equality[1] as string] === equality[2]
      })
    }
    const heavy = workflowJob(
      readFileSync(new URL('../../.github/workflows/ci-platform-heavy.yml', import.meta.url), 'utf8'),
      'heavy',
    )
    const { lists } = JSON.parse(readFileSync(new URL('./heavy-shards.json', import.meta.url), 'utf8'))
    const excluded = /AGNES_TEST_EXCLUDE: \$\{\{ runner.os == 'Windows' && '([^']*)' \|\| '' \}\}/.exec(heavy)
    expect(excluded === null).toBe(false)
    expect(new Set(excluded?.[1]?.split(',') ?? []).has(file)).toBe(false)
    const owners = [1, 2, 3, 4, 5, 6].filter((index) => {
      const shard = heavyShard(`${index}/6`, lists)
      return shard.files ? shard.files.includes(file) : !shard.exclude?.includes(file)
    })
    expect(owners).toEqual([6])
    for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch']) {
      const extra = rows.flatMap((row) =>
        isolated
          .filter((step) => matches(step, osNames[row[1] as string] ?? '', row[2] ?? '', event))
          .map(() => [row[1], row[2]]),
      )
      expect(extra, event).toEqual(
        event === 'pull_request'
          ? [
              ['macos-latest', '1/6'],
              ['windows-latest', '1/6'],
            ]
          : [],
      )
      const heavyOs = platformHeavyOs(workflow, event)
      for (const os of Object.keys(osNames)) {
        const nativeExtra = extra.filter((row) => row[0] === os).length
        expect(nativeExtra + (heavyOs.includes(os) ? owners.length : 0), `${event}/${os}`).toBe(1)
      }
    }
  })

  it('allows only root documentation and Markdown under docs', () => {
    expect(isDocsOnly(['README.zh-CN.md', 'docs/guide/使用 说明.md', 'SECURITY.md'])).toBe(true)
  })

  it.each([
    'packages/core/src/index.ts',
    'packages/protocol/docs/api.md',
    'examples/demo/README.md',
    'pnpm-lock.yaml',
    '.node-version',
    'mise.toml',
    '.github/workflows/ci.yml',
    'tools/toolchain/check.mjs',
    'tools/ci/scope.mjs',
    'tools/public-docs/verify.mjs',
    'docs/example.mjs',
    'docs/unknown.png',
    'new-file.txt',
  ])('runs full checks when documentation is mixed with %s', (path) => {
    expect(isDocsOnly(['README.md', path])).toBe(false)
  })

  it('does not treat empty changes or non-PR events as docs-only', () => {
    expect(isDocsOnly([])).toBe(false)
    for (const event of ['push', 'workflow_dispatch', 'schedule'])
      expect(detectDocsOnly(event, {})).toBe(false)
  })

  it('uses the PR merge base so unrelated target-branch changes do not change its scope', () => {
    const f = fixture()
    f.git('checkout', '-b', 'topic')
    f.write('docs/使用 说明.md', 'Updated guide\n')
    const head = f.commit()
    f.git('checkout', 'main')
    f.write('packages/example/index.ts', 'export const value = 2\n')
    const base = f.commit()
    expect(changedPaths(base, head, f.cwd)).toEqual(['docs/使用 说明.md'])
    expect(
      detectDocsOnly('pull_request', { pull_request: { base: { sha: base }, head: { sha: head } } }, f.cwd),
    ).toBe(true)
  })

  it('keeps removed source paths when a file is renamed into documentation', () => {
    const f = fixture()
    mkdirSync(join(f.cwd, 'docs'))
    renameSync(join(f.cwd, 'packages/example/index.ts'), join(f.cwd, 'docs/example.md'))
    const paths = changedPaths(f.base, f.commit(), f.cwd)
    expect(paths).toContain('packages/example/index.ts')
    expect(isDocsOnly(paths)).toBe(false)
  })

  it('allows documentation deletions but never source deletions', () => {
    const f = fixture()
    rmSync(join(f.cwd, 'README.md'))
    const docsDeleted = f.commit()
    expect(isDocsOnly(changedPaths(f.base, docsDeleted, f.cwd))).toBe(true)
    rmSync(join(f.cwd, 'packages/example/index.ts'))
    expect(isDocsOnly(changedPaths(docsDeleted, f.commit(), f.cwd))).toBe(false)
  })

  it('fails classification instead of skipping tests when metadata or commits are unavailable', () => {
    expect(() => detectDocsOnly('pull_request', {})).toThrow('commit SHAs')
    expect(() => changedPaths('--output=unexpected', 'a'.repeat(40))).toThrow('commit SHAs')
    const f = fixture()
    expect(() => changedPaths(f.base, 'a'.repeat(40), f.cwd)).toThrow()
  })

  it('writes the workflow output through the real CLI entry point', () => {
    const f = fixture()
    f.write('README.md', 'Updated documentation\n')
    const head = f.commit()
    const eventPath = join(temporary(), 'event.json')
    const outputPath = join(temporary(), 'output')
    writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: f.base }, head: { sha: head } } }))
    execFileSync(process.execPath, [fileURLToPath(new URL('./scope.mjs', import.meta.url))], {
      cwd: f.cwd,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
      },
    })
    expect(readFileSync(outputPath, 'utf8')).toBe('docs-only=true\n')
  })
})

function results(
  docsOnly: boolean,
  event = 'pull_request',
): Record<string, { result: string; outputs?: Record<string, string> }> {
  return {
    changes: { result: 'success', outputs: { 'docs-only': String(docsOnly), web: 'true' } },
    static: { result: 'success' },
    check: { result: docsOnly ? 'skipped' : 'success' },
    'windows-check-result': { result: docsOnly ? 'skipped' : 'success' },
    heavy: { result: docsOnly ? 'skipped' : 'success' },
    'windows-acl': { result: !docsOnly && event === 'pull_request' ? 'success' : 'skipped' },
    'runtime-package': { result: docsOnly ? 'skipped' : 'success' },
    sea: { result: docsOnly ? 'skipped' : 'success' },
    'native-linux': { result: 'success' },
    'local-linux': { result: 'success' },
    'local-macos': { result: docsOnly ? 'skipped' : 'success' },
    'local-windows': { result: docsOnly ? 'skipped' : 'success' },
    'native-macos': { result: docsOnly ? 'skipped' : 'success' },
    'native-windows': { result: docsOnly ? 'skipped' : 'success' },
    'linux-fast': { result: docsOnly ? 'skipped' : 'success' },
    web: { result: 'success' },
    'web-result': { result: 'success' },
    'browser-acceptance': { result: 'success' },
  }
}

describe('CI result', () => {
  it.each([true, false])('accepts all expected results (docs-only: %s)', (docsOnly) => {
    for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch'])
      expect(() => verifyResults(results(docsOnly, event), event), event).not.toThrow()
  })

  it('requires the Windows ACL job on code pull requests only', () => {
    for (const event of ['push', 'schedule', 'workflow_dispatch']) {
      const needs = results(false, event)
      needs['windows-acl'] = { result: 'success' }
      expect(() => verifyResults(needs, event), event).toThrow('windows-acl: expected skipped')
    }
    const docs = results(true)
    docs['windows-acl'] = { result: 'success' }
    expect(() => verifyResults(docs, 'pull_request')).toThrow('windows-acl: expected skipped')
    expect(() => verifyResults(results(false), undefined)).toThrow('event name')
    expect(() => verifyResults(results(false), 'merge_group')).toThrow('event name')
  })

  it.each([
    'changes',
    'static',
    'check',
    'windows-check-result',
    'heavy',
    'windows-acl',
    'runtime-package',
    'sea',
    'native-linux',
    'native-macos',
    'native-windows',
    'local-linux',
    'local-macos',
    'local-windows',
    'linux-fast',
    'web',
    'web-result',
    'browser-acceptance',
  ])('fails closed for a failed, cancelled, skipped or missing code job: %s', (job) => {
    for (const state of ['failure', 'cancelled', 'skipped', undefined]) {
      const needs = results(false)
      if (state) needs[job] = { ...needs[job], result: state }
      else delete needs[job]
      expect(() => verifyResults(needs, 'pull_request')).toThrow()
    }
  })

  it('accepts intentional browser exclusion while still requiring code validation', () => {
    const needs = results(false)
    needs.changes.outputs = { 'docs-only': 'false', web: 'false' }
    needs.web.result = 'skipped'
    needs['web-result'].result = 'skipped'
    needs['browser-acceptance'].result = 'skipped'
    expect(() => verifyResults(needs, 'pull_request')).not.toThrow()
    needs['linux-fast'].result = 'skipped'
    expect(() => verifyResults(needs, 'pull_request')).toThrow('linux-fast')
  })

  it('does not hide a documentation check failure behind intentional runtime skips', () => {
    const needs = results(true)
    needs.static.result = 'failure'
    expect(() => verifyResults(needs, 'pull_request')).toThrow('static')
    expect(() => verifyResults({ ...needs, changes: { result: 'success' } }, 'pull_request')).toThrow(
      'classification',
    )
  })

  it('returns a nonzero exit status when a selected job fails', () => {
    const needs = results(false)
    needs.check.result = 'failure'
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./result.mjs', import.meta.url))], {
      env: { ...process.env, CI_NEEDS: JSON.stringify(needs), GITHUB_EVENT_NAME: 'pull_request' },
      encoding: 'utf8',
    })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('check: expected success, received failure')
  })
})

// The real-Windows ACL execution files skip off Windows, so only a Windows runner covers them. Pull
// requests skip the Windows heavy shards; a pull-request-only Windows job runs these files there
// instead. On every event each file must run exactly once on Windows: never zero times, never twice.
const repository = fileURLToPath(new URL('../../', import.meta.url))
const workflowDirectory = join(repository, '.github/workflows')
const actualWorkflows: Readonly<Record<string, string>> = Object.fromEntries(
  readdirSync(workflowDirectory)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => [name, readFileSync(join(workflowDirectory, name), 'utf8')]),
)
const heavyLists: string[][] = JSON.parse(
  readFileSync(new URL('./heavy-shards.json', import.meta.url), 'utf8'),
).lists
const EVENTS = ['pull_request', 'push', 'schedule', 'workflow_dispatch'] as const
const ACL_HEAVY = /(?:^|\/)(?:windows-acl[\w-]*|process-restricted)\.e2e\.test\.ts$/

/** Committed and new heavy files whose real-Windows coverage is the Windows ACL execution path. */
function aclHeavyFiles(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.e2e.test.ts'],
    { cwd: repository, encoding: 'utf8' },
  )
    .split('\n')
    .filter((file) => ACL_HEAVY.test(file))
    .sort()
}

type Leg = Readonly<{ os: string; shard: string }>
type Step = Readonly<{ condition?: string; run: string; env: string }>
type Job = { text: string; steps: Step[] }

const runnerOs = (label: string) =>
  /^windows/.test(label)
    ? 'Windows'
    : /^macos/.test(label)
      ? 'macOS'
      : /^ubuntu/.test(label)
        ? 'Linux'
        : label

/** Job blocks and their step items, read from these workflows' layout: two-space jobs, six-space steps. */
function workflowJobs(text: string): Map<string, Job> {
  const jobs = new Map<string, Job>()
  let job: Job | undefined
  let step: string[] | undefined
  const flush = () => {
    if (job && step) job.steps.push(stepOf(step))
    step = undefined
  }
  const lines = text.split('\n')
  for (const line of lines.slice(lines.indexOf('jobs:') + 1)) {
    const key = /^ {2}([\w-]+):\s*$/.exec(line)
    if (key?.[1]) {
      flush()
      job = { text: '', steps: [] }
      jobs.set(key[1], job)
      continue
    }
    if (job) job.text += `${line}\n`
    if (/^ {6}- /.test(line)) {
      flush()
      step = [line.slice(8)]
    } else if (step && (/^ {8}/.test(line) || line.trim() === '')) step.push(line.slice(8))
    else flush()
  }
  flush()
  return jobs
}

function stepOf(lines: readonly string[]): Step {
  const fields = new Map<string, string>()
  let open: string | undefined
  for (const line of lines) {
    const field = /^([\w-]+):\s?(.*)$/.exec(line)
    if (field?.[1]) {
      const value = field[2] ?? ''
      open = value === '' || value === '|' || value === '>-' ? field[1] : undefined
      fields.set(field[1], open ? '' : value)
    } else if (open) fields.set(open, `${fields.get(open)}\n${line.trim()}`)
  }
  const condition = fields.get('if')
  return {
    ...(condition === undefined ? {} : { condition }),
    run: fields.get('run') ?? '',
    env: fields.get('env') ?? '',
  }
}

/** One `key: value` line of a job block at the given indentation. */
const jobField = (job: Job, key: string, indent: number) =>
  new RegExp(`^ {${indent}}${key}: (.+)$`, 'm').exec(job.text)?.[1]?.trim()

/** Evaluates the `&&` comparisons a job or step condition here may use; anything else fails the check. */
function holds(condition: string | undefined, context: Readonly<Record<string, string>>): boolean {
  if (condition === undefined) return true
  const expression = condition.replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '')
  return expression.split('&&').every((part) => {
    const match =
      /^(runner\.os|matrix\.shard|github\.event_name|needs\.changes\.outputs\.docs-only) (==|!=) (?:'([^']*)'|(\d+))$/.exec(
        part.trim(),
      )
    if (!match?.[1]) throw new Error(`unsupported condition: ${part.trim()}`)
    const same = context[match[1]] === (match[3] ?? match[4])
    return match[2] === '==' ? same : !same
  })
}

/** The runner and matrix shard of every leg a ci.yml job starts, directly or through a reusable workflow. */
function legs(caller: Job, called: Job | undefined): Leg[] {
  const job = called ?? caller
  const runsOn = jobField(job, 'runs-on', 4)
  const label =
    called && /^\$\{\{ inputs\.runner \}\}$/.test(runsOn ?? '') ? jobField(caller, 'runner', 6) : runsOn
  if (!label || label.includes('${{')) throw new Error(`unsupported runner: ${runsOn}`)
  const matrix = /^ {8}shard: (.+)$/m.exec(job.text)?.[1]?.trim()
  let shards = ['']
  if (called && /^\$\{\{ fromJSON\(inputs\.shards\) \}\}$/.test(matrix ?? '')) {
    const configured = /^ {6}shards: '([^']+)'$/m.exec(caller.text)?.[1]
    shards = configured ? JSON.parse(configured) : ['']
  } else if (matrix) {
    const list = /^\[([\d, ]+)\]$/.exec(matrix)?.[1]
    if (!list) throw new Error(`unsupported shard matrix: ${matrix}`)
    shards = list.split(',').map((shard) => shard.trim())
  }
  return shards.map((shard) => ({ os: runnerOs(label), shard }))
}

/** Whether one leg of the shared heavy tier step runs the file, given its shard and Windows exclusion. */
function heavyTierRuns(step: Step, leg: Leg, file: string): number {
  const count = /--shard=\$\{\{ matrix\.shard \}\}\/(\d+)/.exec(step.run)?.[1]
  const exclusion = /AGNES_TEST_EXCLUDE: \$\{\{ runner\.os == 'Windows' && '([^']*)' \|\| '' \}\}/.exec(
    step.env,
  )
  if (!count || !exclusion) throw new Error('unexpected heavy tier step')
  if (leg.os === 'Windows' && exclusion[1]?.split(',').includes(file)) return 0
  const shard = heavyShard(`${leg.shard}/${count}`, heavyLists)
  return (shard.files ? shard.files.includes(file) : !shard.exclude?.includes(file)) ? 1 : 0
}

/** Every Windows run of a file for one event: explicit file lists plus the heavy tier's shards. */
function windowsRuns(workflows: Readonly<Record<string, string>>, file: string, event: string): number {
  let runs = 0
  for (const caller of workflowJobs(workflows['ci.yml'] ?? '').values()) {
    const uses = jobField(caller, 'uses', 4)
    const reusable = uses && /^\.\/\.github\/workflows\/(.+)$/.exec(uses)?.[1]
    if (uses && (!reusable || workflows[reusable] === undefined))
      throw new Error(`unknown reusable workflow: ${uses}`)
    const called = reusable ? [...workflowJobs(workflows[reusable] ?? '').values()] : [undefined]
    for (const job of called) {
      const nested = job && jobField(job, 'uses', 4)
      if (nested) {
        const text = workflows[nested.replace('./.github/workflows/', '')] ?? ''
        if (text.includes('run-heavy-shard.mjs') || text.split(/\s+/).includes(file))
          throw new Error(`unsupported nested heavy workflow: ${nested}`)
      }
      const steps = (job ?? caller).steps.filter(
        (step) => step.run.includes('tools/ci/run-heavy-shard.mjs') || step.run.split(/\s+/).includes(file),
      )
      if (steps.length === 0) continue
      if (job && jobField(job, 'if', 4) !== undefined) throw new Error('unsupported reusable job condition')
      const windows = legs(caller, job).filter((leg) => leg.os === 'Windows')
      const scope = { 'github.event_name': event, 'needs.changes.outputs.docs-only': 'false' }
      if (windows.length === 0 || !holds(jobField(caller, 'if', 4), scope)) continue
      for (const leg of windows)
        for (const step of steps) {
          if (!holds(step.condition, { ...scope, 'runner.os': leg.os, 'matrix.shard': leg.shard })) continue
          runs += step.run.split(/\s+/).filter((token) => token === file).length
          if (step.run.includes('tools/ci/run-heavy-shard.mjs')) runs += heavyTierRuns(step, leg, file)
        }
    }
  }
  return runs
}

/** Every way the Windows ACL heavy files could lose their Windows coverage or run twice. */
function windowsAclCoverage(workflows: Readonly<Record<string, string>>, files: readonly string[]): string[] {
  const problems: string[] = []
  for (const file of files)
    for (const event of EVENTS) {
      const runs = windowsRuns(workflows, file, event)
      if (runs !== 1) problems.push(`${file} runs ${runs} times on Windows for ${event}`)
    }
  for (const text of Object.values(workflows))
    for (const { steps } of workflowJobs(text).values())
      for (const step of steps) {
        const tokens = step.run.split(/\s+/)
        if (!files.some((file) => tokens.includes(file))) continue
        for (const token of tokens.filter((token) => token.endsWith('.test.ts')))
          if (!files.includes(token)) problems.push(`${token} is not a Windows ACL heavy file`)
      }
  return problems
}

/** The workflows with one text replacement in one file; the replacement must apply. */
function edited(file: string, from: string, to: string): Record<string, string> {
  const text = actualWorkflows[file] ?? ''
  const changed = text.replace(from, to)
  expect(changed, `${file} does not contain ${from}`).not.toBe(text)
  return { ...actualWorkflows, [file]: changed }
}

/** The workflows with one ci.yml job's text replaced. */
function editedJob(job: string, from: string, to: string): Record<string, string> {
  const text = actualWorkflows['ci.yml'] ?? ''
  const body = text.split(`\n  ${job}:\n`)[1]?.split(/\n {2}[a-z][a-z0-9-]*:\n/)[0] ?? ''
  expect(body, `ci.yml job ${job} does not contain ${from}`).toContain(from)
  return edited('ci.yml', body, body.replace(from, to))
}

describe('Windows ACL heavy coverage', () => {
  const files = aclHeavyFiles()
  const host = 'packages/host/test/windows-acl-execution.e2e.test.ts'
  const others = ['push', 'schedule', 'workflow_dispatch']

  it('finds every real-Windows ACL execution file', () => {
    expect(files).toEqual([
      'packages/daemon/test/windows-acl-detached.e2e.test.ts',
      'packages/host-infrastructure/test/windows-acl-recovery.e2e.test.ts',
      host,
      'packages/system-node/test/process-restricted.e2e.test.ts',
      'packages/system-node/test/windows-acl.e2e.test.ts',
    ])
  })

  it('runs each one exactly once on Windows for every event', () => {
    expect(windowsAclCoverage(actualWorkflows, files)).toEqual([])
  })

  it('reports a file that pull requests would not run on Windows', () => {
    const dropped = edited('ci-windows-acl.yml', `\n          ${host}`, '')
    expect(windowsAclCoverage(dropped, files)).toEqual([`${host} runs 0 times on Windows for pull_request`])
    const added = 'packages/system-node/test/windows-acl-added.e2e.test.ts'
    expect(windowsAclCoverage(actualWorkflows, [...files, added])).toEqual([
      `${added} runs 0 times on Windows for pull_request`,
    ])
    const unused = editedJob(
      'windows-acl',
      'uses: ./.github/workflows/ci-windows-acl.yml',
      'runs-on: windows-latest',
    )
    expect(windowsAclCoverage(unused, files)).toEqual(
      files.map((file) => `${file} runs 0 times on Windows for pull_request`),
    )
  })

  it('reports a file the Windows heavy shards hold out on the other events', () => {
    const held = edited(
      'ci-platform-heavy.yml',
      "runner.os == 'Windows' && 'packages/daemon/test/skill-install-requests.slow.test.ts,",
      `runner.os == 'Windows' && '${host},packages/daemon/test/skill-install-requests.slow.test.ts,`,
    )
    expect(windowsAclCoverage(held, files)).toEqual(
      others.map((event) => `${host} runs 0 times on Windows for ${event}`),
    )
  })

  it('reports a second Windows run when the pull request job also runs on the other events', () => {
    const everyEvent = editedJob('windows-acl', " && github.event_name == 'pull_request'", '')
    expect(windowsAclCoverage(everyEvent, files)).toEqual(
      files.flatMap((file) => others.map((event) => `${file} runs 2 times on Windows for ${event}`)),
    )
  })

  it('reports a second Windows run when pull requests also run the Windows heavy shards', () => {
    const windowsHeavy = editedJob('heavy-windows', " && github.event_name != 'pull_request'", '')
    expect(windowsAclCoverage(windowsHeavy, files)).toEqual(
      files.map((file) => `${file} runs 2 times on Windows for pull_request`),
    )
  })

  it('reports a file listed twice and an unrelated file in the pull request job', () => {
    const twice = edited(
      'ci-windows-acl.yml',
      `\n          ${host}`,
      `\n          ${host}\n          ${host}`,
    )
    expect(windowsAclCoverage(twice, files)).toEqual([`${host} runs 2 times on Windows for pull_request`])
    const unrelated = edited(
      'ci-windows-acl.yml',
      `\n          ${host}`,
      `\n          ${host}\n          packages/daemon/test/supervisor.e2e.test.ts`,
    )
    expect(windowsAclCoverage(unrelated, files)).toEqual([
      'packages/daemon/test/supervisor.e2e.test.ts is not a Windows ACL heavy file',
    ])
  })
})
