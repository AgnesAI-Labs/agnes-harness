import type { HostFs } from '../../../src/seam-init.js'

const bytes = (value: Uint8Array | string): Uint8Array =>
  typeof value === 'string' ? new TextEncoder().encode(value) : value

function statShape(entry: Awaited<ReturnType<HostFs['stat']>>) {
  return {
    size: entry.size,
    mode: entry.kind === 'dir' ? 0o40755 : entry.kind === 'symlink' ? 0o120777 : 0o100644,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.mtimeMs,
    isFile: () => entry.kind === 'file',
    isDirectory: () => entry.kind === 'dir',
    isSymbolicLink: () => entry.kind === 'symlink',
  }
}

/** The narrow HostFs spelling adapted to isomorphic-git's documented promise filesystem plugin. */
export function toGitFs(host: HostFs) {
  const promises = {
    async readFile(path: string, options?: string | { encoding?: string | null }) {
      const value = await host.read(path)
      const encoding = typeof options === 'string' ? options : options?.encoding
      return encoding ? new TextDecoder().decode(value) : value
    },
    async writeFile(path: string, value: Uint8Array | string) {
      await host.write(path, bytes(value))
    },
    async unlink(path: string) {
      await host.rm(path)
    },
    async readdir(path: string, options?: { withFileTypes?: boolean }) {
      const entries = await host.list(path)
      if (!options?.withFileTypes) return entries.map((entry) => entry.name)
      return entries.map((entry) => ({
        name: entry.name,
        isFile: () => entry.kind === 'file',
        isDirectory: () => entry.kind === 'dir',
        isSymbolicLink: () => entry.kind === 'symlink',
      }))
    },
    // biome-ignore format: direct HostFs adapter.
    async mkdir(path: string) { await host.mkdir(path) },
    // biome-ignore format: direct HostFs adapter.
    async rmdir(path: string) { await host.rm(path, { recursive: true }) },
    // biome-ignore format: direct HostFs adapter.
    async stat(path: string) { return statShape(await host.stat(path)) },
    // biome-ignore format: direct HostFs adapter.
    async lstat(path: string) { return statShape(await host.stat(path)) },
    // biome-ignore format: HostFs lacks rename; the checkpoint contract does not claim atomic ref writes.
    async rename(before: string, after: string) { const value = await host.read(before); await host.write(after, value); await host.rm(before) },
    async chmod() {},
    async readlink(path: string): Promise<string> {
      throw Object.assign(new Error(`readlink is unavailable for ${path}`), { code: 'ENOSYS' })
    },
    async symlink(_target: string, path: string): Promise<void> {
      throw Object.assign(new Error(`symlink is unavailable for ${path}`), { code: 'ENOSYS' })
    },
  }
  return { promises }
}
