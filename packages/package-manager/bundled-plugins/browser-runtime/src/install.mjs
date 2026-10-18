import { randomUUID } from 'node:crypto'
import { access, chmod, lstat, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

// Reviewed Chrome for Testing Stable, shared by every supported platform.
// Update together with real-browser acceptance; never select an arbitrary browser from the user's cache.
export const browserVersion = '155.0.8059.84'

export function browserPlatform(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && ['x64', 'arm64'].includes(arch)) return 'win64'
  if (platform === 'darwin' && ['x64', 'arm64'].includes(arch)) return `mac-${arch}`
  if (platform === 'linux' && ['x64', 'arm64'].includes(arch))
    return arch === 'x64' ? 'linux64' : 'linux-arm64'
  throw new Error(`Unsupported browser platform: ${platform}/${arch}`)
}

export function browserPayload(cache, platform = browserPlatform()) {
  const folder = `chrome-headless-shell-${platform}`
  const root = join(cache, '.agent-browser', 'agh-headless', `${browserVersion}-${platform}`)
  return {
    root,
    folder,
    executable: join(root, folder, `chrome-headless-shell${platform === 'win64' ? '.exe' : ''}`),
    url: `https://storage.googleapis.com/chrome-for-testing-public/${browserVersion}/${platform}/${folder}.zip`,
  }
}

export async function installedBrowser(payload) {
  try {
    if ((await lstat(payload.root)).isSymbolicLink() || !(await lstat(payload.executable)).isFile())
      return false
    const receipt = JSON.parse(await readFile(join(payload.root, 'agh-install.json'), 'utf8'))
    return receipt.version === browserVersion && receipt.url === payload.url
  } catch {
    return false
  }
}

/** Fixed vendor payload only. Both external commands run through the existing session policy. */
export async function installBrowser(ctx, cache) {
  ctx.signal.throwIfAborted()
  if (!ctx.fs?.create) throw new Error('Browser installation requires the Host-owned file creation service')
  const payload = browserPayload(cache)
  const stage = `${payload.root}-install-${randomUUID()}`
  const archive = join(stage, 'browser.zip')
  const executable = join(
    stage,
    payload.folder,
    process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell',
  )
  const systemBin =
    process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32') : '/usr/bin'
  const utility = (name) => join(systemBin, `${name}${process.platform === 'win32' ? '.exe' : ''}`)
  let created = false
  const run = async (argv) => {
    ctx.signal.throwIfAborted()
    let child, off
    let tail = ''
    const abort = () => {
      void child?.close().catch(() => {})
    }
    try {
      child = await ctx.sandbox.openProcess({ argv, cwd: ctx.cwd, signal: ctx.signal })
      off = child.onOutput(({ text }) => {
        tail = (tail + text).slice(-2000)
      })
      ctx.signal.addEventListener('abort', abort, { once: true })
      if (ctx.signal.aborted) abort()
      const result = await child.exited
      ctx.signal.throwIfAborted()
      if (result.code !== 0 || result.error)
        throw new Error(`Headless browser installation failed (${result.code ?? 'unknown'}): ${tail}`)
    } finally {
      off?.()
      ctx.signal.removeEventListener('abort', abort)
      await child?.close()
    }
  }
  try {
    // Exclusive, Host-authorized creation also makes the private staging directory.
    // A denied cache write must fail before downloading or starting any process.
    await ctx.fs.create(
      join(stage, 'agh-install.json'),
      Buffer.from(JSON.stringify({ version: browserVersion, url: payload.url })),
    )
    created = true
    await chmod(stage, 0o700)
    await run([
      utility('curl'),
      '--fail',
      '--location',
      '--proto',
      '=https',
      '--proto-redir',
      '=https',
      '--silent',
      '--show-error',
      '--connect-timeout',
      '15',
      '--max-time',
      '180',
      '--max-filesize',
      '536870912',
      '--output',
      archive,
      payload.url,
    ])
    await run([utility('tar'), '-xf', archive, '-C', stage])
    if (!(await lstat(executable)).isFile())
      throw new Error('Downloaded headless browser executable is missing')
    if (process.platform !== 'win32') await chmod(executable, 0o755)
    await access(executable)
    await rm(archive)
    ctx.signal.throwIfAborted()
    try {
      await rename(stage, payload.root)
      created = false
    } catch (error) {
      // Another profile/process may finish the same pinned installation first.
      if (!(await installedBrowser(payload))) throw error
    }
    return payload.executable
  } finally {
    if (created) await rm(stage, { recursive: true, force: true })
  }
}
