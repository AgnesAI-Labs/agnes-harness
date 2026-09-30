import { spawnSync } from 'node:child_process'

/** Read one committed tree. Callers pass repository paths; this never reads the working tree. */
export class GitTree {
  readonly rev: string

  private constructor(
    private readonly root: string,
    rev: string,
  ) {
    this.rev = rev
  }

  static open(root: string, rev: string): GitTree {
    const resolved = git(root, ['rev-parse', '--verify', `${rev}^{commit}`])
      .toString('utf8')
      .trim()
    if (!/^[0-9a-f]{40}$/.test(resolved)) throw new Error(`unusable commit id for ${rev}`)
    return new GitTree(root, resolved)
  }

  files(): string[] {
    const raw = git(this.root, ['ls-tree', '-r', '-z', '--name-only', this.rev])
    return raw
      .toString('utf8')
      .split('\0')
      .filter((path) => path.length > 0)
      .sort()
  }

  read(path: string): Buffer {
    const found = this.readMany([path]).get(path)
    if (!found) throw new Error(`missing ${this.rev}:${path}`)
    return found
  }

  readMany(paths: readonly string[]): Map<string, Buffer> {
    const out = new Map<string, Buffer>()
    if (paths.length === 0) return out
    const input = paths.map((path) => `${this.rev}:${path}\n`).join('')
    const raw = git(this.root, ['cat-file', '--batch'], input)
    let offset = 0
    for (const path of paths) {
      const newline = raw.indexOf(0x0a, offset)
      if (newline < 0) throw new Error(`truncated git header for ${path}`)
      const header = raw.toString('utf8', offset, newline)
      offset = newline + 1
      if (header.endsWith(' missing')) throw new Error(`missing ${this.rev}:${path}`)
      const sizeText = header.split(' ')[2]
      const size = Number(sizeText)
      if (!Number.isInteger(size) || size < 0) throw new Error(`bad git header for ${path}: ${header}`)
      out.set(path, Buffer.from(raw.subarray(offset, offset + size)))
      offset += size
      if (raw[offset] !== 0x0a) throw new Error(`truncated git object for ${path}`)
      offset += 1
    }
    if (offset !== raw.length) throw new Error('unexpected trailing git batch output')
    return out
  }

  text(path: string): string {
    return this.read(path).toString('utf8')
  }
}

function git(root: string, args: readonly string[], input?: string): Buffer {
  const result = spawnSync('git', args, {
    cwd: root,
    input,
    maxBuffer: 512 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr?.toString('utf8').trim() || `git ${args.join(' ')} failed`
    throw new Error(detail)
  }
  return result.stdout
}
