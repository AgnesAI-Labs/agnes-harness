import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { probeShell, runProbe } from '../bench/probes.mjs'

const root = mkdtempSync(join(tmpdir(), 'jev-probes-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

it('finds Git for Windows Bash beside the git on PATH, instead of WSL bash.exe', () => {
  const system = join(root, 'system')
  const git = join(root, 'Git with spaces')
  for (const directory of [system, join(git, 'cmd'), join(git, 'bin')])
    mkdirSync(directory, { recursive: true })
  for (const file of [join(system, 'bash.exe'), join(git, 'cmd', 'git.exe'), join(git, 'bin', 'bash.exe')])
    writeFileSync(file, 'fixture')
  expect(probeShell({ platform: 'win32', env: { PATH: `${system};${join(git, 'cmd')}` } })).toBe(
    join(git, 'bin', 'bash.exe'),
  )
  expect(probeShell({ platform: 'win32', env: {} })).toBeUndefined()
})

it('runs Bash probes in the requested workspace and preserves failing probe exits', async () => {
  writeFileSync(join(root, 'fixture value'), 'fixture')
  await expect(runProbe('test -f "fixture value" && printf PROBE_OK', root, process.env)).resolves.toEqual({
    exit: 0,
    output: 'PROBE_OK',
  })
  await expect(runProbe('printf PROBE_FAILED; exit 7', root, process.env)).resolves.toEqual({
    exit: 7,
    output: 'PROBE_FAILED',
  })
})

it('runs the selected Python script through a shim when its Windows path contains spaces', async () => {
  const { writePythonShim } = await import(new URL('../bench/setup.mjs', import.meta.url).href)
  const interpreter = join(root, 'stub python')
  writeFileSync(interpreter, '#!/bin/sh\nprintf "STUB_PY_OK %s" "$*"\n')
  chmodSync(interpreter, 0o755)
  const shim = writePythonShim(join(root, 'shim'), interpreter.replaceAll('/', '\\'), 'win32')
  const result = await runProbe('python -B -c pass', root, {
    ...process.env,
    PATH: `${shim}${delimiter}${process.env.PATH ?? ''}`,
  })
  expect(result).toEqual({ exit: 0, output: 'STUB_PY_OK -B -c pass' })
})
