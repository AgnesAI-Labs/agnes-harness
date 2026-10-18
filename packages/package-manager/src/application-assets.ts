import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { ApplicationAsset, ApplicationTemplate } from '@agnes/protocol'
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import { validateApplicationImage } from './application-image.js'

const MAX_BYTES = 128 * 1024
/** Brand bytes are read from the verified immutable package, never from an author URL. */
export async function readApplicationAsset(
  directory: string,
  asset: ApplicationAsset | string,
): Promise<Buffer> {
  const expected = typeof asset === 'string' ? undefined : asset
  const path = (typeof asset === 'string' ? asset : asset.path).replace(/^\.\//, '')
  if (!path || /[\\:\0]/.test(path) || path.split('/').some((p) => !p || p === '.' || p === '..'))
    throw new Error('application-asset-path')
  const root = nativeRealpathSync(directory)
  let file = root
  for (const segment of path.split('/')) {
    file = join(file, segment)
    if (lstatSync(file).isSymbolicLink()) throw new Error('application-asset-symlink')
  }
  const rel = relative(root, nativeRealpathSync(file))
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('application-asset-path')
  const stat = lstatSync(file)
  if (
    !stat.isFile() ||
    stat.size < 1 ||
    stat.size > MAX_BYTES ||
    (expected !== undefined && stat.size !== expected.size)
  )
    throw new Error('application-asset-size')
  const handle = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let bytes: Buffer
  try {
    const opened = fstatSync(handle)
    if (!opened.isFile() || opened.size !== stat.size || opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw new Error('application-asset-changed')
    const buffer = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < buffer.length) {
      const read = readSync(handle, buffer, length, buffer.length - length, null)
      if (!read) break
      length += read
    }
    if (length !== stat.size) throw new Error('application-asset-size')
    bytes = buffer.subarray(0, length)
  } finally {
    closeSync(handle)
  }
  const type = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? 'image/jpeg'
      : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())
        ? 'image/gif'
        : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
          ? 'image/webp'
          : bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))
            ? 'image/x-icon'
            : undefined
  const extensions: Record<string, string[]> = {
    'image/png': ['png'],
    'image/jpeg': ['jpg', 'jpeg'],
    'image/gif': ['gif'],
    'image/webp': ['webp'],
    'image/x-icon': ['ico'],
  }
  if (
    !type ||
    (expected !== undefined && type !== expected.mime) ||
    !extensions[type]?.includes(path.split('.').at(-1) ?? '')
  )
    throw new Error('application-asset-type')
  if (
    bytes.length !== stat.size ||
    (expected !== undefined && createHash('sha256').update(bytes).digest('hex') !== expected.sha256)
  )
    throw new Error('application-asset-digest')
  await validateApplicationImage(bytes, type)
  return bytes
}

export async function readApplicationAssets(directory: string, application: ApplicationTemplate) {
  const assets: { mark?: string; favicon?: string } = {}
  for (const key of ['mark', 'favicon'] as const) {
    const asset = application.brand?.[key]
    if (asset)
      assets[key] =
        `data:${({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon' } as Record<string, string>)[asset.split('.').at(-1) ?? '']};base64,${(await readApplicationAsset(directory, asset)).toString('base64')}`
  }
  return assets
}
