import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyResults } from './result.mjs'
import { changedPaths, detectDocsOnly, isDocsOnly } from './scope.mjs'

const directories: string[] = []
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
  it('allows only root documentation and Markdown under docs', () => {
    expect(isDocsOnly(['README.zh-CN.md', 'docs/guide/使用 说明.md', 'SECURITY.md'])).toBe(true)
  })

  it.each([
    'packages/core/src/index.ts',
    'packages/protocol/docs/api.md',
    'examples/demo/README.md',
    'pnpm-lock.yaml',
    '.github/workflows/ci.yml',
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
    heavy: { result: docsOnly ? 'skipped' : 'success' },
    'runtime-package': { result: docsOnly ? 'skipped' : 'success' },
    sea: { result: docsOnly ? 'skipped' : 'success' },
  }
}

describe('CI result', () => {
  it.each([true, false])('accepts all expected results (docs-only: %s)', (docsOnly) => {
    expect(() => verifyResults(results(docsOnly))).not.toThrow()
  })

  it.each(['changes', 'static', 'check', 'heavy', 'runtime-package', 'sea'])(
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
