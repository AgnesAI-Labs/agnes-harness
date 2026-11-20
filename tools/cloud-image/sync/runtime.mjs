import { constants } from 'node:fs'
import { copyFile, lstat, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { publicEnvironment } from './config.mjs'
import { fault, readPrivate } from './private-files.mjs'
import { command, start, terminate } from './process.mjs'
export async function cloudKey(config, env = process.env) {
  let key
  try {
    key = await readPrivate(join(config.home, 'cloud-key'), 8192)
  } catch (error) {
    if (error.code !== 'ENOENT') throw fault('SYNC_CLOUD_KEY_INVALID')
    if (env.AGH_API_KEY && env.AGH_CLOUD_KEY && env.AGH_API_KEY !== env.AGH_CLOUD_KEY)
      throw fault('SYNC_CLOUD_KEY_INVALID')
    key = env.AGH_API_KEY ?? env.AGH_CLOUD_KEY
  }
  if (typeof key !== 'string' || !key.trim() || key.trim().length > 4096 || /[^\x21-\x7e]/u.test(key.trim()))
    throw fault('SYNC_CLOUD_KEY_INVALID')
  return key.trim()
}
async function returnStagedKey(config, staged) {
  try {
    // Preserve any newer Key atomically published by the provider during installation.
    await copyFile(staged, join(config.home, 'cloud-key'), constants.COPYFILE_EXCL)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  } finally {
    await rm(staged, { force: true })
  }
}
export function harnessRuntime(config) {
  let running,
    touched = false
  const entry = join(config.runtime, 'agnes.mjs')
  const env = () => ({
    ...publicEnvironment(),
    AGH_HOME: config.home,
    AGNES_PROFILE: config.profile,
    AGH_SYNC_DIR: config.run,
    AGH_ASSETS_DIR: config.assets,
  })
  return {
    async boot(signal) {
      const key = await cloudKey(config),
        childEnv = env()
      touched = true
      childEnv.AGH_CLOUD_KEY = key
      // A current file Key may supersede the startup alias. The child receives the current one.
      if (childEnv.AGH_API_KEY !== undefined) childEnv.AGH_API_KEY = key
      const files = await readdir(config.home)
      const keyOnly = files.length === 1 && files[0] === 'cloud-key'
      const staged = join(config.run, 'cloud-key.initializing')
      if (keyOnly) {
        // /run can be tmpfs: rename across these mounts would fail with EXDEV.
        await writeFile(staged, key, { mode: 0o600, flag: 'wx' })
        await rm(join(config.home, 'cloud-key'))
      }
      try {
        await command(process.execPath, [entry, 'plugins', 'add', '/opt/agh/plugins/cloud.tgz', '--yes'], {
          env: childEnv,
          cwd: config.workspace,
          signal,
          timeout: 120000,
        })
      } finally {
        if (keyOnly) await returnStagedKey(config, staged)
      }
      if (!keyOnly) {
        // Initialize after a successful install, including restored homes that omit the old Key.
        // A Key atomically published by the provider always wins over the startup value.
        try {
          await writeFile(join(config.home, 'cloud-key'), key, { mode: 0o600, flag: 'wx' })
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
        }
      }
      childEnv.AGH_CLOUD_KEY = await cloudKey(config)
      if (childEnv.AGH_API_KEY !== undefined) childEnv.AGH_API_KEY = childEnv.AGH_CLOUD_KEY
      running = start(
        process.execPath,
        [entry, 'serve', '--home', config.home, '--profile', config.profile, '--cwd', config.workspace],
        { env: childEnv, cwd: config.workspace, detached: true },
      )
    },
    async stop(signal) {
      if (running?.child.pid && running.child.exitCode === null) {
        try {
          process.kill(-running.child.pid, 'SIGTERM')
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
        await terminate(running, { timeout: 2000 })
      }
      if (running?.child.pid) {
        // No surviving writer from the owned frontend group may remain at a successful boundary.
        try {
          process.kill(-running.child.pid, 0)
          throw fault('SYNC_HARNESS_NOT_STOPPED')
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
      await command(
        process.execPath,
        [entry, 'daemon', 'stop', '--home', config.home, '--profile', config.profile],
        { env: env(), cwd: config.workspace, signal, timeout: 14000 },
      )
    },
    async ready() {
      if (!running?.child.pid || running.child.exitCode !== null || running.child.signalCode !== null)
        return false
      const key = await cloudKey(config),
        signal = AbortSignal.timeout(2000)
      const origin = 'http://127.0.0.1:8443'
      try {
        const response = await fetch(`${origin}/_agnes/remote-frontend/auth`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key }),
          redirect: 'error',
          signal,
        })
        if (!response.ok) return false
        const result = await response.json()
        return (
          typeof result.token === 'string' &&
          typeof result.expiresAt === 'number' &&
          result.expiresAt > Date.now()
        )
      } catch {
        return false
      }
    },
    async cleanup() {
      if (running?.child.pid) {
        try {
          process.kill(-running.child.pid, 'SIGTERM')
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
        await terminate(running, { timeout: 1000 })
      }
      if (touched)
        try {
          await command(process.execPath, [entry, 'daemon', 'stop'], { env: env(), timeout: 5000 })
        } catch {}
      await terminate(running, { timeout: 1000 })
    },
  }
}
export async function localFilesystem(path) {
  const { statfs } = await import('node:fs/promises')
  const type = (await statfs(path)).type
  // Linux network filesystems are inappropriate for the SQLite home, but allowed for assets.
  if ([0x6969, 0xff534d42, 0x517b, 0x01021997, 0x65735546].includes(type))
    throw fault('SYNC_HOME_FILESYSTEM_UNSUPPORTED')
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault('SYNC_HOME_UNSAFE')
}
