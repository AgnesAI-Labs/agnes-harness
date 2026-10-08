import type { FsIo, FsIoKind, FsIoStat } from './fs-io.js'
import type { RemoteTransport } from './remote-transport.js'

// The remote process opens each directory relative to a held no-follow descriptor. File contents
// use that same descriptor, including bounded byte windows. Transport upload/download methods
// cannot supply this guarantee and are deliberately not used by the fenced adapter.
const SCRIPT = String.raw`
import os, sys, stat, errno, base64, json
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

def directory(path, create=False):
    if not path.startswith('/') or '\x00' in path: raise OSError(errno.EINVAL, 'absolute path required')
    fd = os.open('/', flags)
    parts = path.split('/')[1:]
    if parts == ['']: return fd
    try:
        for index, part in enumerate(parts):
            if not part or part in ('.', '..'): raise OSError(errno.EINVAL, 'canonical component required')
            if create:
                try: os.mkdir(part, dir_fd=fd)
                except FileExistsError: pass
            try: child = os.open(part, flags, dir_fd=fd)
            except OSError as error:
                if create and index == len(parts)-1 and error.errno in (errno.ENOTDIR, errno.ELOOP):
                    raise OSError(errno.EEXIST, 'directory collision')
                raise
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise

def parent(path):
    outer, leaf = os.path.split(path)
    if not leaf or leaf in ('.', '..'): raise OSError(errno.EINVAL, 'canonical leaf required')
    return directory(outer), leaf

def kind(mode):
    return 'symlink' if stat.S_ISLNK(mode) else 'dir' if stat.S_ISDIR(mode) else 'file' if stat.S_ISREG(mode) else 'other'

def metadata(fd, leaf):
    meta = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
    result = {'kind': kind(meta.st_mode), 'size': meta.st_size, 'mtimeMs': meta.st_mtime_ns / 1000000}
    if stat.S_ISLNK(meta.st_mode): result['linkTarget'] = os.readlink(leaf, dir_fd=fd)
    return result

def remove(fd, leaf, recursive, depth=0):
    if depth >= 256: raise OSError(errno.ELOOP, 'directory depth exceeded')
    observed = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
    if not stat.S_ISDIR(observed.st_mode):
        os.unlink(leaf, dir_fd=fd)
        return
    if not recursive: raise OSError(errno.EISDIR, 'recursive flag required')
    child = os.open(leaf, flags, dir_fd=fd)
    try:
        opened = os.fstat(child)
        if (opened.st_dev, opened.st_ino) != (observed.st_dev, observed.st_ino): raise OSError(errno.EACCES, 'directory changed')
        for name in os.listdir(child):
            try: remove(child, name, True, depth+1)
            except FileNotFoundError: pass
        current = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
        if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
            raise OSError(errno.EACCES, 'directory changed')
        os.rmdir(leaf, dir_fd=fd)
    finally: os.close(child)

operation, path = sys.argv[1:3]
try:
    if operation == 'mkdir':
        fd = directory(path, True)
        os.close(fd)
    elif operation == 'list':
        fd = directory(path)
        try:
            result = []
            for name in os.listdir(fd):
                try: meta = os.stat(name, dir_fd=fd, follow_symlinks=False)
                except FileNotFoundError: continue
                result.append({'name': name, 'kind': kind(meta.st_mode)})
            print(json.dumps(result))
        finally: os.close(fd)
    elif operation == 'stat' and path == '/':
        fd = directory('/')
        try:
            meta = os.fstat(fd)
            print(json.dumps({'kind': 'dir', 'size': meta.st_size, 'mtimeMs': meta.st_mtime_ns/1000000}))
        finally: os.close(fd)
    else:
        fd, leaf = parent(path)
        try:
            if operation == 'stat': print(json.dumps(metadata(fd, leaf)))
            elif operation == 'readlink': print(json.dumps(os.readlink(leaf, dir_fd=fd)))
            elif operation == 'rm': remove(fd, leaf, sys.argv[3] == '1')
            elif operation in ('read', 'write'):
                mode = os.O_WRONLY | os.O_CREAT if operation == 'write' else os.O_RDONLY
                child = os.open(leaf, mode | os.O_NOFOLLOW | os.O_NONBLOCK, 0o666, dir_fd=fd)
                try:
                    meta = os.fstat(child)
                    if not stat.S_ISREG(meta.st_mode): raise OSError(errno.EISDIR if stat.S_ISDIR(meta.st_mode) else errno.EACCES, 'regular file required')
                    if operation == 'write':
                        data = base64.b64decode(sys.stdin.buffer.read(), validate=True)
                        os.ftruncate(child, 0)
                        view = memoryview(data)
                        while view:
                            written = os.write(child, view)
                            if written <= 0: raise OSError(errno.EIO, 'incomplete write')
                            view = view[written:]
                    else:
                        offset = int(sys.argv[3])
                        limit = int(sys.argv[4]) if sys.argv[4] != '-' else meta.st_size
                        remaining = max(0, min(limit, meta.st_size-offset))
                        os.lseek(child, offset, os.SEEK_SET)
                        chunks = []
                        while remaining:
                            chunk = os.read(child, min(remaining, 65536))
                            if not chunk: break
                            chunks.append(chunk)
                            remaining -= len(chunk)
                        print(base64.b64encode(b''.join(chunks)).decode('ascii'))
                finally: os.close(child)
            else: raise OSError(errno.EINVAL, 'unknown operation')
        finally: os.close(fd)
except OSError as error:
    if operation == 'stat' and error.errno in (errno.ENOENT, errno.ENOTDIR):
        print('null')
    else:
        code = 'ERR_FS_EISDIR' if operation == 'rm' and error.errno == errno.EISDIR else errno.errorcode.get(error.errno, 'EIO')
        print(code, file=sys.stderr)
        sys.exit(1)
`

export function createRemoteFsIo(transport: RemoteTransport): FsIo {
  const run = async (
    operation: string,
    abs: string,
    args: string[] = [],
    options: { stdin?: string; maxOutputBytes?: number } = {},
  ) => {
    const result = await transport.exec(['python3', '-c', SCRIPT, operation, abs, ...args], {
      cwd: '/',
      ...options,
    })
    if (result.truncated || result.timedOut)
      throw Object.assign(new Error('Remote filesystem operation did not complete'), {
        code: result.truncated ? 'EFBIG' : 'ETIMEDOUT',
      })
    if (result.code !== 0)
      throw Object.assign(new Error('Remote filesystem operation failed'), {
        code: /^(?:E[A-Z0-9_]+|ERR_FS_EISDIR)$/.test(result.stderr.trim()) ? result.stderr.trim() : 'EIO',
      })
    return result.stdout.trim()
  }
  const bytes = async (abs: string, offset: number, limit?: number) => {
    const encoded = await run(
      'read',
      abs,
      [String(offset), limit === undefined ? '-' : String(limit)],
      limit === undefined ? {} : { maxOutputBytes: Math.ceil(limit / 3) * 4 + 32 },
    )
    if (limit !== undefined && encoded.length > Math.ceil(limit / 3) * 4)
      throw Object.assign(new Error('Remote byte read exceeded its limit'), { code: 'EFBIG' })
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
    if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(encoded.slice(0, encoded.length - padding)))
      throw Object.assign(new Error('Invalid remote byte read'), { code: 'EIO' })
    const data = new Uint8Array(Buffer.from(encoded, 'base64'))
    if (limit !== undefined && data.length > limit)
      throw Object.assign(new Error('Remote byte read exceeded its limit'), { code: 'EFBIG' })
    return data
  }
  return Object.freeze({
    async lstat(abs: string) {
      return (JSON.parse(await run('stat', abs)) as FsIoStat | null) ?? undefined
    },
    async readlink(abs: string) {
      return JSON.parse(await run('readlink', abs)) as string
    },
    readFile: (abs: string) => bytes(abs, 0),
    readRange: (abs: string, opts: { offset: number; limit?: number }) => bytes(abs, opts.offset, opts.limit),
    async writeFile(abs: string, data: Uint8Array) {
      await run('write', abs, [], { stdin: Buffer.from(data).toString('base64') })
    },
    async mkdir(abs: string) {
      await run('mkdir', abs)
    },
    async readdir(abs: string) {
      return JSON.parse(await run('list', abs)) as { name: string; kind: FsIoKind }[]
    },
    async rm(abs: string, opts: { recursive: boolean }) {
      await run('rm', abs, [opts.recursive ? '1' : '0'])
    },
  })
}
