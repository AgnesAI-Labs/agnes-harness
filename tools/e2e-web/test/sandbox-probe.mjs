import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { detectBackend } from '@agnes/base/sandbox'
import { compileWorkspacePolicy, dataDir } from '@agnes/host'

const exec = promisify(execFile)
const [homeRoot, workspace, preset] = process.argv.slice(2)
if (!homeRoot || !workspace || !['read-only', 'workspace-write'].includes(preset))
  throw new Error('sandbox probe requires its isolated fixture paths and preset')
const home = await realpath(dirname(homeRoot))
const plan = await compileWorkspacePolicy({
  canonicalRoot: await realpath(workspace),
  dataDir: dataDir(homeRoot),
  homeDir: home,
  semantics: { flavor: 'posix', caseSensitive: true },
  staticConfig: {
    level: 'L1',
    access: preset,
    required: false,
    onUnavailable: 'deny',
    extraPaths: [],
    denyPaths: [],
    networkAllow: [],
  },
  canonicalize: async (path, options) => {
    const target = resolve(options?.base ?? '/', path)
    try {
      return await realpath(target)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      // Host may migrate the old data/secrets leaf; its real parent still fixes the identity.
      return join(await realpath(dirname(target)), basename(target))
    }
  },
})
const backend = await detectBackend({
  level: 'L1',
  shell: 'posix',
  options: plan.backendOptions,
  log: { debug() {}, info() {}, warn() {}, error() {} },
  probeExec: async (argv, options) => {
    const [command, ...args] = argv
    if (!command) throw new Error('sandbox probe requires an executable')
    const result = await exec(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: '/tmp', AGH_HOME: homeRoot },
    })
    return { ...result, code: 0, truncated: false, timedOut: false }
  },
})
process.stdout.write(JSON.stringify({ backend: backend.name, enforcement: backend.enforcement }))
