import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyResults } from './result.mjs'
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

function results(docsOnly: boolean): Record<string, { result: string; outputs?: Record<string, string> }> {
  return {
    changes: { result: 'success', outputs: { 'docs-only': String(docsOnly) } },
    static: { result: 'success' },
    check: { result: docsOnly ? 'skipped' : 'success' },
    'windows-check-result': { result: docsOnly ? 'skipped' : 'success' },
    heavy: { result: docsOnly ? 'skipped' : 'success' },
    'runtime-package': { result: docsOnly ? 'skipped' : 'success' },
    sea: { result: docsOnly ? 'skipped' : 'success' },
  }
}

describe('CI result', () => {
  it.each([true, false])('accepts all expected results (docs-only: %s)', (docsOnly) => {
    expect(() => verifyResults(results(docsOnly))).not.toThrow()
  })

  it.each(['changes', 'static', 'check', 'windows-check-result', 'heavy', 'runtime-package', 'sea'])(
    'fails closed for a failed, cancelled, skipped or missing code job: %s',
    (job) => {
      for (const state of ['failure', 'cancelled', 'skipped', undefined]) {
        const needs = results(false)
        if (state) needs[job] = { ...needs[job], result: state }
        else delete needs[job]
        expect(() => verifyResults(needs)).toThrow()
      }
    },
  )

  it('does not hide a documentation check failure behind intentional runtime skips', () => {
    const needs = results(true)
    needs.static.result = 'failure'
    expect(() => verifyResults(needs)).toThrow('static')
    expect(() => verifyResults({ ...needs, changes: { result: 'success' } })).toThrow('classification')
  })

  it('returns a nonzero exit status when a selected job fails', () => {
    const needs = results(false)
    needs.check.result = 'failure'
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./result.mjs', import.meta.url))], {
      env: { ...process.env, CI_NEEDS: JSON.stringify(needs) },
      encoding: 'utf8',
    })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('check: expected success, received failure')
  })
})

// The real-Windows ACL execution files skip off Windows, so only a Windows runner covers them. Pull
// requests run the heavy job on Linux only; the check job's first Windows shard runs these files there
// instead. On every event each file must run exactly once on Windows: never zero times, never twice.
const repository = fileURLToPath(new URL('../../', import.meta.url))
const ciWorkflow = readFileSync(join(repository, '.github/workflows/ci.yml'), 'utf8')
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

/** Job blocks and their step items, read from this workflow's layout: two-space jobs, six-space steps. */
function workflowJobs(text: string): Map<string, Job> {
  const jobs = new Map<string, Job>()
  let job: Job | undefined
  let step: string[] | undefined
  const flush = () => {
    if (job && step) job.steps.push(stepOf(step))
    step = undefined
  }
  for (const line of text.split('\n')) {
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

/** Evaluates the `&&` comparisons a step condition here may use; anything else fails the check. */
function holds(condition: string | undefined, context: Readonly<Record<string, string>>): boolean {
  if (condition === undefined) return true
  const expression = condition.replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '')
  return expression.split('&&').every((part) => {
    const match = /^(runner\.os|matrix\.shard|github\.event_name) (==|!=) (?:'([^']*)'|(\d+))$/.exec(
      part.trim(),
    )
    if (!match?.[1]) throw new Error(`unsupported step condition: ${part.trim()}`)
    const same = context[match[1]] === (match[3] ?? match[4])
    return match[2] === '==' ? same : !same
  })
}

function legs(jobs: ReadonlyMap<string, Job>, job: string, event: string): Leg[] {
  const block = jobs.get(job)?.text ?? ''
  if (job === 'check')
    return [...block.matchAll(/^ +- \{ os: ([\w-]+),.*shard: '([^']*)' \}$/gm)].map((match) => ({
      os: runnerOs(match[1] ?? ''),
      shard: match[2] ?? '',
    }))
  if (job === 'heavy') {
    const os = /fromJSON\(github\.event_name == 'pull_request' && '(\[[^']*\])' \|\| '(\[[^']*\])'\)/.exec(
      block,
    )
    const shards = /^ +shard: \[([\d, ]+)\]$/m.exec(block)?.[1]
    if (!os?.[1] || !os[2] || !shards) throw new Error('unexpected heavy matrix')
    const labels: string[] = JSON.parse(event === 'pull_request' ? os[1] : os[2])
    return labels.flatMap((label) =>
      shards.split(',').map((shard) => ({ os: runnerOs(label), shard: shard.trim() })),
    )
  }
  throw new Error(`unexpected job running an ACL heavy file: ${job}`)
}

/** How many times one heavy file runs on a Windows runner for one event. */
function windowsRuns(jobs: ReadonlyMap<string, Job>, file: string, event: string): number {
  let runs = 0
  // The heavy tier partitions every heavy file over its shards, so a complete set of Windows legs
  // runs a file once, unless the Windows exclusion holds it out.
  const heavy = legs(jobs, 'heavy', event).filter((leg) => leg.os === 'Windows')
  if (heavy.length > 0) {
    const tier = jobs.get('heavy')?.steps.find((step) => step.run.includes('tools/ci/run-heavy-shard.mjs'))
    const held = /runner\.os == 'Windows' && '([^']*)'/.exec(tier?.env ?? '')?.[1]
    if (!tier || tier.condition !== undefined || held === undefined)
      throw new Error('unexpected Windows heavy tier')
    if (heavy.map((leg) => leg.shard).join(',') !== '1,2,3')
      throw new Error('incomplete Windows heavy shards')
    if (!held.split(',').includes(file)) runs += 1
  }
  for (const [job, { steps }] of jobs)
    for (const step of steps) {
      const mentions = step.run.split(/\s+/).filter((token) => token === file).length
      if (mentions === 0) continue
      for (const leg of legs(jobs, job, event))
        if (
          leg.os === 'Windows' &&
          holds(step.condition, {
            'runner.os': leg.os,
            'matrix.shard': leg.shard,
            'github.event_name': event,
          })
        )
          runs += mentions
    }
  return runs
}

/** Every way the Windows ACL heavy files could lose their Windows coverage or run twice. */
function windowsAclCoverage(text: string, files: readonly string[]): string[] {
  const jobs = workflowJobs(text)
  const problems: string[] = []
  for (const file of files)
    for (const event of EVENTS) {
      const runs = windowsRuns(jobs, file, event)
      if (runs !== 1) problems.push(`${file} runs ${runs} times on Windows for ${event}`)
    }
  for (const { steps } of jobs.values())
    for (const step of steps) {
      const tokens = step.run.split(/\s+/)
      if (!files.some((file) => tokens.includes(file))) continue
      for (const token of tokens.filter((token) => token.endsWith('.test.ts')))
        if (!files.includes(token)) problems.push(`${token} is not a Windows ACL heavy file`)
    }
  return problems
}

describe('Windows ACL heavy coverage', () => {
  const files = aclHeavyFiles()
  const host = 'packages/host/test/windows-acl-execution.e2e.test.ts'

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
    expect(windowsAclCoverage(ciWorkflow, files)).toEqual([])
  })

  it('reports a file that pull requests would not run on Windows', () => {
    const dropped = ciWorkflow.replace(`\n          ${host}`, '')
    expect(dropped).not.toBe(ciWorkflow)
    expect(windowsAclCoverage(dropped, files)).toEqual([`${host} runs 0 times on Windows for pull_request`])
    const added = 'packages/system-node/test/windows-acl-added.e2e.test.ts'
    expect(windowsAclCoverage(ciWorkflow, [...files, added])).toEqual([
      `${added} runs 0 times on Windows for pull_request`,
    ])
  })

  it('reports a file the Windows heavy shards hold out on the other events', () => {
    const held = ciWorkflow.replace(
      "runner.os == 'Windows' && 'packages/cli/test/acp-concurrency.e2e.test.ts,",
      `runner.os == 'Windows' && '${host},packages/cli/test/acp-concurrency.e2e.test.ts,`,
    )
    expect(held).not.toBe(ciWorkflow)
    expect(windowsAclCoverage(held, files)).toEqual(
      ['push', 'schedule', 'workflow_dispatch'].map(
        (event) => `${host} runs 0 times on Windows for ${event}`,
      ),
    )
  })

  it('reports a second Windows run when the pull request step also runs on the other events', () => {
    const everyEvent = ciWorkflow.replace(" && github.event_name == 'pull_request'", '')
    expect(everyEvent).not.toBe(ciWorkflow)
    expect(windowsAclCoverage(everyEvent, files)).toEqual(
      files.flatMap((file) =>
        ['push', 'schedule', 'workflow_dispatch'].map(
          (event) => `${file} runs 2 times on Windows for ${event}`,
        ),
      ),
    )
  })

  it('reports a second Windows run when pull requests also run the Windows heavy shards', () => {
    const windowsHeavy = ciWorkflow.replace(
      `'["ubuntu-latest"]' ||`,
      `'["ubuntu-latest", "windows-latest"]' ||`,
    )
    expect(windowsHeavy).not.toBe(ciWorkflow)
    expect(windowsAclCoverage(windowsHeavy, files)).toEqual(
      files.map((file) => `${file} runs 2 times on Windows for pull_request`),
    )
  })

  it('reports a file listed twice and an unrelated file in the pull request step', () => {
    const twice = ciWorkflow.replace(`\n          ${host}`, `\n          ${host}\n          ${host}`)
    expect(twice).not.toBe(ciWorkflow)
    expect(windowsAclCoverage(twice, files)).toEqual([`${host} runs 2 times on Windows for pull_request`])
    const unrelated = ciWorkflow.replace(
      `\n          ${host}`,
      `\n          ${host}\n          packages/daemon/test/supervisor.e2e.test.ts`,
    )
    expect(windowsAclCoverage(unrelated, files)).toEqual([
      'packages/daemon/test/supervisor.e2e.test.ts is not a Windows ACL heavy file',
    ])
  })
})
