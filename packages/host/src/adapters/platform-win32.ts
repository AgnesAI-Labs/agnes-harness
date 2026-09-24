import { execFileSync } from 'node:child_process'
import { assertCapabilityId, CAPABILITY_IDS, type PlatformBackend, unprobed } from './platform-posix.js'

export function createWin32Platform(): PlatformBackend {
  const caps = unprobed()
  return {
    os: 'win32',
    // guards-allow-platform: this file is the win32 half of the one place a platform check belongs
    matches: () => process.platform === 'win32',
    shell: () => 'powershell',
    fs: () => ({ caseSensitive: false, pathSep: '\\' }),
    terminal: () => ({
      color: process.env.NO_COLOR === undefined && Boolean(process.stdout.isTTY),
      ...(process.stdout.columns ? { width: process.stdout.columns } : {}),
    }),
    capability(id) {
      assertCapabilityId(id)
      return caps[id]
    },
    // guards-allow-platform: process.arch is the architecture half of the same snapshot
    snapshot: () => ({
      os: 'win32',
      arch: process.arch,
      capabilities: Object.fromEntries(CAPABILITY_IDS.map((id) => [id, caps[id].level])),
    }),
    recordSandboxBackend() {
      // Task 15 has no Windows process-creation primitive. Never let a report turn argv identity
      // into a restricted-token claim; HostExec must implement and prove that boundary first.
      caps['sandbox.l1'] = {
        level: 'unavailable',
        scope: [],
        reason: 'restricted token backend not implemented (v0.x)',
      }
      caps['sandbox.network'] = { level: 'unavailable', scope: [], reason: 'not implemented' }
    },
    killTree(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) return
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } catch {
        /* gone */
      }
    },
    async probe() {
      caps['fs.symlink'] = {
        level: 'partial',
        scope: ['file'],
        reason: 'needs developer mode or admin',
      }
      caps['exec.kill-tree'] = { level: 'full', scope: ['process'] }
      caps['sandbox.l1'] = {
        level: 'unavailable',
        scope: [],
        reason: 'restricted token backend not implemented (v0.x)',
      }
      caps['sandbox.network'] = { level: 'unavailable', scope: [], reason: 'not implemented' }
      caps['terminal.truecolor'] = { level: 'full', scope: [], reason: 'ConPTY renders 24-bit colour' }
      caps['terminal.kitty-keys'] = { level: 'unavailable', scope: [], reason: 'ConPTY' }
      caps.ipc = { level: 'full', scope: ['socket'], value: 'pipe' }
    },
  }
}
