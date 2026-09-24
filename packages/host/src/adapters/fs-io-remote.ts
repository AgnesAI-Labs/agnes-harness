import type { FsIo, FsIoKind, FsIoStat } from './fs-io.js'
import type { RemoteTransport } from './remote-transport.js'

// One server-side script per structured answer: parsing `ls -l` output is a portability trap, while
// a script that prints exactly the fields wanted, one per line, is not. Every script below reports
// failures by Python's `errno.errorcode` name, which is the same vocabulary Node's `node:fs` uses
// for `.code` (both are POSIX errno names), so a caller can pattern-match the remote io's errors
// exactly as it does the local one's.

const STAT_SCRIPT = [
  'import os, sys, stat as st',
  'p = sys.argv[1]',
  'try:',
  '    s = os.lstat(p)',
  'except (FileNotFoundError, NotADirectoryError):',
  '    print("none")',
  '    sys.exit(0)',
  'kind = "symlink" if st.S_ISLNK(s.st_mode) else "dir" if st.S_ISDIR(s.st_mode) else "file" if st.S_ISREG(s.st_mode) else "other"',
  'print(kind)',
  'print(s.st_size)',
  'print(int(s.st_mtime * 1000))',
].join('\n')

const READDIR_SCRIPT = [
  'import os, sys, stat as st',
  'd = sys.argv[1]',
  'for n in os.listdir(d):',
  '    s = os.lstat(os.path.join(d, n))',
  '    kind = "symlink" if st.S_ISLNK(s.st_mode) else "dir" if st.S_ISDIR(s.st_mode) else "file" if st.S_ISREG(s.st_mode) else "other"',
  '    print(kind + "\\t" + n)',
].join('\n')

const MKDIR_SCRIPT = [
  'import os, sys, errno',
  'p = sys.argv[1]',
  'try:',
  '    os.makedirs(p, exist_ok=True)',
  'except OSError as e:',
  '    print(errno.errorcode.get(e.errno, "UNKNOWN"))',
  '    sys.exit(1)',
  'print("ok")',
].join('\n')

const RM_SCRIPT = [
  'import os, sys, shutil, errno',
  'p = sys.argv[1]',
  'recursive = sys.argv[2] == "1"',
  'try:',
  '    if recursive:',
  '        if os.path.isdir(p) and not os.path.islink(p):',
  '            shutil.rmtree(p)',
  '        else:',
  '            os.remove(p)',
  '    else:',
  '        os.remove(p)',
  'except OSError as e:',
  '    print(errno.errorcode.get(e.errno, "UNKNOWN"))',
  '    sys.exit(1)',
  'print("ok")',
].join('\n')

/**
 * An `FsIo` derived purely from a `RemoteTransport`: `exec()` for every structured read (lstat,
 * readdir), plain commands for the rest, and `upload`/`download` for file content - routing bytes
 * through a shell's stdout would corrupt binaries and hit argument-length limits on anything large.
 *
 * Errors carry a POSIX `.code` (EEXIST, ENOENT, ENOTDIR, ...) wherever the contract's callers match
 * on it, mirroring what `fs-io-local.ts` gets for free from `node:fs`. `rm`'s non-recursive-on-a-
 * directory case is special: Node's `fs.rm` reports that with its own `ERR_FS_EISDIR` code, not a
 * raw errno, so it is checked here before the remote command ever runs, rather than reverse-
 * engineered from a shell failure.
 */
export function createRemoteFsIo(transport: RemoteTransport): FsIo {
  const run = async (cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    await transport.exec(cmd, { cwd: '/' })

  const lstat = async (abs: string): Promise<FsIoStat | undefined> => {
    const r = await run(['python3', '-c', STAT_SCRIPT, abs])
    if (r.code !== 0) throw new Error(`remote lstat failed for ${abs}: ${r.stderr}`)
    const [kind, size, mtime] = r.stdout.trim().split('\n')
    if (kind === 'none') return undefined
    return { kind: kind as FsIoKind, size: Number(size), mtimeMs: Number(mtime) }
  }

  return Object.freeze({
    lstat,
    async readlink(abs) {
      const r = await run(['readlink', abs])
      if (r.code !== 0) throw new Error(`remote readlink failed for ${abs}: ${r.stderr}`)
      return r.stdout.replace(/\n$/, '')
    },
    async readFile(abs) {
      // A missing file must arrive as a rejection carrying `.code === 'ENOENT'`, not as an empty
      // result - see "Error semantics" on the `RemoteTransport` interface. The guard below is the
      // last resort for a transport that ignores that: it reports a failure rather than handing
      // back zero bytes as if the file were empty, but it cannot invent the errno.
      const [got] = await transport.download([abs])
      if (got === undefined) throw new Error(`remote readFile returned nothing for ${abs}`)
      return got.content
    },
    async writeFile(abs, data) {
      // Forward the transport's structured error unchanged. B1 makes EISDIR/ENOTDIR/EACCES
      // best-effort under the errno tiers declared in core/remote-transport. The
      // loopback still gets precise node:fs errors; the retained Python metadata path is unchanged.
      await transport.upload([{ path: abs, content: data }])
    },
    async mkdir(abs) {
      const r = await run(['python3', '-c', MKDIR_SCRIPT, abs])
      if (r.code !== 0) {
        const code = r.stdout.trim() || undefined
        throw Object.assign(
          new Error(`remote mkdir failed for ${abs}: ${code ?? r.stderr}`),
          code ? { code } : {},
        )
      }
    },
    async readdir(abs) {
      const r = await run(['python3', '-c', READDIR_SCRIPT, abs])
      if (r.code !== 0) throw new Error(`remote readdir failed for ${abs}: ${r.stderr}`)
      return r.stdout
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => {
          const tab = l.indexOf('\t')
          return { kind: l.slice(0, tab) as FsIoKind, name: l.slice(tab + 1) }
        })
    },
    async rm(abs, opts) {
      if (!opts.recursive) {
        const st = await lstat(abs)
        if (st?.kind === 'dir') {
          throw Object.assign(
            new Error(`ERR_FS_EISDIR: Path is a directory: rm returned EISDIR (is a directory) ${abs}`),
            { code: 'ERR_FS_EISDIR' },
          )
        }
      }
      const r = await run(['python3', '-c', RM_SCRIPT, abs, opts.recursive ? '1' : '0'])
      if (r.code !== 0) {
        const code = r.stdout.trim() || undefined
        throw Object.assign(
          new Error(`remote rm failed for ${abs}: ${code ?? r.stderr}`),
          code ? { code } : {},
        )
      }
    },
  })
}
