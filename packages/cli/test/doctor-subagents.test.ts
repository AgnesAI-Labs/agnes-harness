import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSqliteStorage } from '@agnes/host'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { doctorCommand } from '../src/commands/doctor.js'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

function runCli(home: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', bin, ...args], {
      windowsHide: true,
      env: { ...process.env, AGH_HOME: home },
      cwd: fileURLToPath(new URL('../../..', import.meta.url)),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

describe('doctor subagents', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('parses --repair and lists an empty candidate set without deleting', async () => {
    expect(parseArgs(['doctor', 'subagents', '--json', '--repair'])).toMatchObject({
      command: 'doctor',
      positional: ['subagents'],
      json: true,
      repair: true,
    })
    const home = mkdtempSync(join(tmpdir(), 'agnes-doctor-sa-'))
    dirs.push(home)
    mkdirSync(join(home, 'data'), { recursive: true })
    const deps = { home, cwd: home, env: {}, agnesVersion: '0.0.0', log: () => undefined }
    const result = await doctorCommand(parseArgs(['doctor', 'subagents', '--json']), deps)
    expect(result.exitCode).toBe(0)
    expect(result.text).toContain('candidates')
    const again = await doctorCommand(parseArgs(['doctor', 'subagents', '--repair', '--json']), deps)
    expect(again.exitCode).toBe(2)
    expect(again.text).toMatch(/disabled|refused/)
  })

  it('runs the CLI twice against a temp git repo and skips dirty repair', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-doctor-git-')))
    dirs.push(home)
    mkdirSync(join(home, 'data'), { recursive: true })
    const workspace = join(home, 'workspace')
    mkdirSync(workspace)
    execFileSync('git', ['init', '-b', 'main'], { cwd: workspace })
    execFileSync('git', ['config', 'user.email', 'doc@example.test'], { cwd: workspace })
    execFileSync('git', ['config', 'user.name', 'doc'], { cwd: workspace })
    writeFileSync(join(workspace, 'README.md'), 'root\n')
    writeFileSync(join(workspace, '.gitignore'), '.worktrees\n')
    execFileSync('git', ['add', '.'], { cwd: workspace })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: workspace })
    const dirtyPath = join(workspace, '.worktrees', 'agnes-abcd1234')
    execFileSync('git', ['worktree', 'add', '-b', 'agnes/subagent-abcd1234', dirtyPath], { cwd: workspace })
    writeFileSync(join(dirtyPath, 'dirty.txt'), 'keep\n')

    const storage = createSqliteStorage({
      file: join(home, 'data', 'sessions.db'),
      tablesDir: join(home, 'data', 'tables'),
    })
    await storage.open('parent', { writerRunId: 'r1', ttlMs: 1000 })
    await storage.ensureRootScope('root', 10_000_000n)
    await storage.createDelegatedChild({
      childKey: 'parent/safe',
      parentKey: 'parent',
      boundarySeq: 1,
      creationId: 'c-safe',
      kind: 'spawn',
      rootTaskId: 'root',
      runtimeOwnerSessionKey: 'parent',
      generationDepth: 1,
      generationLimit: 2,
      maxFanOut: 4,
      inputHash: 'h1',
      inputText: 'safe',
      cwd: workspace,
      actorId: 'u',
      isolation: 'shared',
      workspaceId: 'ws-safe',
      treeCapMicro: 10_000_000n,
      childCapMicro: null,
      writerRunId: 'w',
    })
    await storage.createDelegatedChild({
      childKey: 'parent/dirty',
      parentKey: 'parent',
      boundarySeq: 1,
      creationId: 'c-dirty',
      kind: 'spawn',
      rootTaskId: 'root',
      runtimeOwnerSessionKey: 'parent',
      generationDepth: 1,
      generationLimit: 2,
      maxFanOut: 4,
      inputHash: 'h2',
      inputText: 'dirty',
      cwd: dirtyPath,
      actorId: 'u',
      isolation: 'worktree',
      workspaceId: 'ws-dirty',
      treeCapMicro: 10_000_000n,
      childCapMicro: null,
      writerRunId: 'w',
    })
    await storage.casState('parent/safe', 1, 'completed')
    await storage.casState('parent/dirty', 1, 'completed')
    await storage.updateWorkspace?.('ws-dirty', { phase: 'kept_dirty' })
    await storage.close()

    const first = await runCli(home, ['doctor', 'subagents', '--json'])
    expect(first.code).toBe(0)
    const listed = JSON.parse(first.stdout) as {
      candidates: Array<{ childKey: string; keepReason?: string; path?: string | null }>
    }
    expect(listed.candidates.map((c) => c.childKey).sort()).toEqual(['parent/dirty', 'parent/safe'])
    expect(listed.candidates.find((c) => c.childKey === 'parent/dirty')?.keepReason).toBe('kept_dirty')

    const second = await runCli(home, ['doctor', 'subagents', '--json'])
    expect(second.code).toBe(0)
    expect(JSON.parse(second.stdout)).toEqual(listed)

    const repaired = await runCli(home, ['doctor', 'subagents', '--repair', '--json'])
    expect(repaired.code).toBe(2)
    expect(`${repaired.stdout}\n${repaired.stderr}`).toMatch(/disabled|refused/)
    expect(readFileSync(join(dirtyPath, 'dirty.txt'), 'utf8')).toBe('keep\n')
  }, 20_000)
})
