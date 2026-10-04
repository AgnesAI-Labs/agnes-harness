import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  type Stats,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { jcs } from '@agnes/protocol'
import { requireRelease } from './primitives.js'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** POSIX observations for the private producer, never a local identity or native transaction fence. */
export class ProtectedDeployment {
  readonly root: string
  readonly uid: number
  readonly files = new Map<string, { bytes: Buffer; identity: string }>()
  readonly directories = new Map<string, string>()
  readonly inventories = new Map<string, string>()
  constructor(directory: string) {
    requireRelease(process.getuid && process.geteuid, 'deployment_owner_unavailable', '/deployment')
    this.uid = process.getuid()
    requireRelease(
      this.uid === process.geteuid() && isAbsolute(directory),
      'deployment_denied',
      '/deployment',
    )
    this.root = resolve(directory)
    this.checkDirectory(this.root, true)
  }
  private identity(stat: Stats): string {
    return `${stat.dev}:${stat.ino}:${stat.uid}:${stat.mode}:${stat.isDirectory() ? '-' : stat.nlink}`
  }
  private checkDirectory(path: string, privatePath: boolean): void {
    const stat = lstatSync(path)
    requireRelease(stat.isDirectory() && !stat.isSymbolicLink(), 'deployment_path_denied', '/deployment/path')
    if (privatePath) {
      requireRelease(
        stat.uid === this.uid && (stat.mode & 0o077) === 0,
        'deployment_permissions',
        '/deployment/path',
      )
    } else {
      const sticky = (stat.mode & 0o1000) !== 0 && (stat.uid === 0 || stat.uid === this.uid)
      requireRelease(
        (stat.uid === 0 || stat.uid === this.uid) && ((stat.mode & 0o022) === 0 || sticky),
        'deployment_permissions',
        '/deployment/parent',
      )
    }
    const original = this.directories.get(path)
    requireRelease(
      !original || original === this.identity(stat),
      'deployment_source_changed',
      '/deployment/path',
    )
    this.directories.set(path, this.identity(stat))
    const parent = dirname(path)
    if (parent !== path) this.checkDirectory(parent, false)
  }
  path(name: string): string {
    requireRelease(!isAbsolute(name), 'deployment_path_denied', '/deployment/path')
    const path = resolve(this.root, name),
      rel = relative(this.root, path)
    requireRelease(
      rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`),
      'deployment_path_denied',
      '/deployment/path',
    )
    return path
  }
  read(name: string): Buffer {
    const path = this.path(name)
    let parent = dirname(path)
    while (parent !== this.root) {
      this.checkDirectory(parent, true)
      parent = dirname(parent)
    }
    this.checkDirectory(this.root, true)
    const handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = fstatSync(handle)
      requireRelease(
        before.isFile() &&
          before.uid === this.uid &&
          (before.mode & 0o077) === 0 &&
          before.nlink === 1 &&
          before.size <= 8 * 1024 * 1024,
        'deployment_permissions',
        '/deployment/file',
      )
      const bytes = readFileSync(handle),
        after = fstatSync(handle)
      requireRelease(
        this.identity(before) === this.identity(after) &&
          this.identity(lstatSync(path)) === this.identity(after) &&
          before.mtimeMs === after.mtimeMs &&
          before.ctimeMs === after.ctimeMs &&
          before.size === bytes.length,
        'deployment_source_changed',
        '/deployment/file',
      )
      const original = this.files.get(name)
      requireRelease(
        !original || (original.identity === this.identity(after) && original.bytes.equals(bytes)),
        'deployment_source_changed',
        '/deployment/file',
      )
      this.files.set(name, { bytes, identity: this.identity(after) })
      return bytes
    } finally {
      closeSync(handle)
    }
  }
  json(name: string): unknown {
    return JSON.parse(this.read(name).toString('utf8'))
  }
  scan(name: string): void {
    const path = this.path(name)
    this.checkDirectory(path, true)
    const entries = readdirSync(path, { withFileTypes: true })
    this.inventories.set(path, JSON.stringify(entries.map((entry) => entry.name).sort()))
    for (const entry of entries) {
      requireRelease(!entry.isSymbolicLink(), 'deployment_path_denied', '/deployment/package')
      const child = join(name, entry.name)
      if (entry.isDirectory()) this.scan(child)
      else this.read(child)
    }
  }
  /** All filesystem/hash work belongs before the installer's final native clock. */
  preClock(): void {
    for (const [path, identity] of this.directories) {
      const stat = lstatSync(path)
      requireRelease(
        stat.isDirectory() && this.identity(stat) === identity,
        'deployment_source_changed',
        '/deployment/path',
      )
    }
    for (const [path, inventory] of this.inventories) {
      requireRelease(
        JSON.stringify(readdirSync(path).sort()) === inventory,
        'deployment_source_changed',
        '/deployment/package',
      )
    }
    for (const [name, original] of [...this.files]) {
      const bytes = this.read(name)
      requireRelease(
        this.files.get(name)?.identity === original.identity && bytes.equals(original.bytes),
        'deployment_source_changed',
        '/deployment/file',
      )
    }
  }
  fingerprint(names: readonly string[]): string {
    const material = names.map((name) => {
      const row = this.files.get(name)
      requireRelease(row, 'deployment_source_missing', '/deployment/file')
      return { path: name, rawDigest: hash(row.bytes), bytes: row.bytes.length }
    })
    return hash(Buffer.from(jcs(material)))
  }
}
