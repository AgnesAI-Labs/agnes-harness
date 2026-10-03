// Build the standalone execution reference without coupling installed Host packages to examples.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32') {
  if (process.arch !== 'x64') throw new Error('Reference Windows Job helper requires x64')
  const directory = fileURLToPath(new URL('../dist/native/', import.meta.url))
  mkdirSync(directory, { recursive: true })
  const cleanEnvironment = { ...process.env }
  delete cleanEnvironment.CL
  execFileSync(
    process.env.AGNES_WINDOWS_CL ?? 'cl.exe',
    [
      '/nologo',
      '/EHsc',
      '/W4',
      '/WX',
      '/O2',
      '/std:c++17',
      '/utf-8',
      '/D_WIN32_WINNT=0x0A00',
      '/Fo' + join(directory, 'execution-owner.obj'),
      '/Fe' + join(directory, 'execution-owner.exe'),
      fileURLToPath(new URL('../native/windows-job-owner.cc', import.meta.url)),
      '/link',
      'advapi32.lib',
      'psapi.lib',
    ],
    { env: cleanEnvironment, stdio: 'inherit', windowsHide: true },
  )
} else if (process.platform === 'darwin') {
  const directory = fileURLToPath(new URL('../dist/native/', import.meta.url))
  mkdirSync(directory, { recursive: true })
  execFileSync(
    'cc',
    [
      '-O2',
      '-Wall',
      '-Wextra',
      '-o',
      `${directory}execution-owner`,
      fileURLToPath(new URL('../native/execution-owner.c', import.meta.url)),
    ],
    { stdio: 'inherit' },
  )
}
