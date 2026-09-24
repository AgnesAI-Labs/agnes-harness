import { realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ExtensionManifest } from '@agnes/extension-api'
import type { ClientContribution } from '@agnes/protocol'
import { containedEntry } from './entry-path.js'
import { PackageError } from './errors.js'

/**
 * 安装期 client 资源上限。它们是成本与体积不变量，不是部署可调项，所以按常量固定，
 * 不向插件配置开放（与 skin-assets.ts 的上限同一理由）。
 */
export const CLIENT_MAX_FILE_BYTES = 4194304
export const CLIENT_MAX_TOTAL_BYTES = 16777216
export const CLIENT_ASSET_EXTENSIONS: readonly string[] = Object.freeze(['js', 'mjs', 'css', 'map'])
const CLIENT_ENTRY_EXTENSIONS: readonly string[] = Object.freeze(['js', 'mjs'])
const CLIENT_STYLE_EXTENSIONS: readonly string[] = Object.freeze(['css'])
const PRIVATE_CONFIG_KEY = /(?:credential|secret|token|api[-_]?key|password|authorization)/i

function fail(file: string, why: string, reason: string): never {
  throw new PackageError('E_EXT_LOAD', `${file}: ${why}`, { source: { file }, detail: { reason } })
}

/**
 * 包内相对路径的词法检查：拒绝绝对路径、以 `/` 开头、反斜杠/盘符、NUL，以及空段、`.`、`..` 段。
 * 允许可选的 `./` 前缀，其余写法必须是朴素的包内相对路径。
 */
function portableClientPath(value: string): boolean {
  if (value === '' || isAbsolute(value) || /[\\:]/.test(value) || value.includes('\0')) return false
  const body = value.startsWith('./') ? value.slice(2) : value
  if (body === '') return false
  return !body.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
}

/** 路径统一为包内相对形态：去掉可选的 `./` 前缀，其余保持原样（词法合法性由校验阶段保证）。 */
function normalizeClientPath(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value
}

/**
 * `publicConfig` is intentionally a manifest-only browser projection.  It is
 * not a generic escape hatch for runtime configuration: reject the credential
 * shaped names and secret-reference values that commonly cross that boundary.
 * This cannot prove a prose string is harmless, but it makes the safe contract
 * explicit and fail-closed for the credential forms Agnes understands.
 */
export function validatePublicClientConfig(value: unknown, path = 'publicConfig'): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return
  if (typeof value === 'string') {
    if (/secret:\/\//i.test(value))
      fail(path, 'public client config cannot contain secret references', 'client-public-config-secret')
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validatePublicClientConfig(item, `${path}[${index}]`)
    })
    return
  }
  if (!value || typeof value !== 'object')
    fail(path, 'public client config must be JSON data', 'client-public-config')
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_CONFIG_KEY.test(key))
      fail(
        `${path}.${key}`,
        'public client config cannot contain credential-shaped fields',
        'client-public-config-secret',
      )
    validatePublicClientConfig(item, `${path}.${key}`)
  }
}

function decodeUrlPathSegments(segments: readonly string[]): string[] | null {
  const decoded: string[] = []
  for (const segment of segments) {
    let value: string
    try {
      value = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (
      value === '' ||
      value === '.' ||
      value === '..' ||
      value.includes('/') ||
      value.includes('\\') ||
      value.includes('\0')
    )
      return null
    decoded.push(value)
  }
  return decoded
}

/**
 * 能力快照用的规范化 `client` 字段：styles 保序；slots/services/projections 去重排序；
 * 缺省数组归一为 `[]`；路径统一为包内相对。inspect 与 inventory 复核共用这一个函数，
 * 同一份清单在任何一条路径上得到的摘要字节都相同。
 */
export type NormalizedClientContribution = {
  id?: string
  entry: string
  styles: string[]
  slots: string[]
  slotCatalogVersion?: string
  services: string[]
  projections: string[]
  legacyRowIds?: string[]
  /** Immutable author-declared browser metadata. Never copied from a runtime row. */
  publicConfig?: Readonly<Record<string, unknown>>
}

export function normalizeClientContribution(client: ClientContribution): NormalizedClientContribution {
  if (client.publicConfig !== undefined) validatePublicClientConfig(client.publicConfig)
  const set = (values: readonly string[] | undefined): string[] => [...new Set(values ?? [])].sort()
  return {
    ...(client.id === undefined ? {} : { id: client.id }),
    entry: normalizeClientPath(client.entry),
    styles: (client.styles ?? []).map(normalizeClientPath),
    slots: set(client.slots),
    ...(client.slotCatalogVersion === undefined ? {} : { slotCatalogVersion: client.slotCatalogVersion }),
    services: set(client.services),
    projections: set(client.projections),
    ...(client.legacyRowIds === undefined ? {} : { legacyRowIds: [...new Set(client.legacyRowIds)] }),
    ...(client.publicConfig === undefined ? {} : { publicConfig: client.publicConfig }),
  }
}

/** 一份声明过 client 的清单，其 entry/styles 在校验后的真实文件位置（已过 realpath）。 */
export type ResolvedClientAssets = {
  /** client 入口文件的绝对路径，符号链接已解析。 */
  entryPath: string
  /** 样式表文件的绝对路径，按声明顺序，符号链接已解析。 */
  stylePaths: string[]
}

/**
 * 对照包目录核验清单声明的 client 资源：词法路径、扩展名白名单、单文件与总量上限，
 * 以及文件必须真实落在安装树内（`containedEntry` 同时拒绝越界符号链接）。
 *
 * 注意：这是**格式校验，不是安全边界**——本函数不做 import 闭包分析，也不扫描代码内容；
 * 浏览器侧能否加载由快照下发通道与信任决策另行保证。
 *
 * @param dir - 包根目录。
 * @param manifest - 已通过 `checkManifest` 的清单。
 * @returns 声明了 client 时返回解析结果，未声明时返回 `undefined`。
 */
export function resolveClientAssets(
  dir: string,
  manifest: ExtensionManifest,
): ResolvedClientAssets | undefined {
  const client = manifest.contributes?.client
  if (client === undefined) return undefined
  if (client.publicConfig !== undefined) validatePublicClientConfig(client.publicConfig)
  const file = join(dir, 'agnes.extension.json')
  const assets = [
    { path: client.entry, extensions: CLIENT_ENTRY_EXTENSIONS, reason: 'client-entry-extension' },
    ...(client.styles ?? []).map((path) => ({
      path,
      extensions: CLIENT_STYLE_EXTENSIONS,
      reason: 'client-style-extension',
    })),
  ]
  const resolved: string[] = []
  let total = 0
  for (const asset of assets) {
    const { path } = asset
    if (!portableClientPath(path))
      fail(path, 'client asset is not a portable relative path inside the package', 'client-path')
    const extension = extname(path).slice(1).toLowerCase()
    if (!asset.extensions.includes(extension))
      fail(path, `client asset extension .${extension} is not valid for this field`, asset.reason)
    // containedEntry 负责文件真实存在、类型正确且 realpath 后仍在包内。
    const target = containedEntry(dir, path, 'file', file)
    const bytes = statSync(target).size
    if (bytes > CLIENT_MAX_FILE_BYTES)
      fail(
        path,
        `client asset is ${bytes} bytes, over the ${CLIENT_MAX_FILE_BYTES}-byte cap`,
        'client-asset-too-large',
      )
    total += bytes
    resolved.push(target)
  }
  if (total > CLIENT_MAX_TOTAL_BYTES)
    fail(
      client.entry,
      `client assets total ${total} bytes, over the ${CLIENT_MAX_TOTAL_BYTES}-byte cap`,
      'client-assets-too-large',
    )
  const entryPath = resolved[0]
  if (entryPath === undefined) fail(client.entry, 'client entry did not resolve', 'client-path')
  return { entryPath, stylePaths: resolved.slice(1) }
}

/** web 下发通道只允许这四类扩展名（对应 text/javascript / text/css / application/json 三种 MIME）；与安装期白名单一致。 */
export const CLIENT_MODULE_SERVABLE_EXTENSIONS: readonly string[] = CLIENT_ASSET_EXTENSIONS

/** 包 id 的词法形态（与锁文件 schema 中的 id 模式一致）：一段，或 `scope/name` 两段。 */
const PACKAGE_ID_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?)$/

/**
 * 把 `/plugins/<packageId>/<revision>/<包内相对路径>` 裁决成快照内的一个真实文件，或 `null`。
 * 这是 web 下发通道的唯一裁决函数：revision 段不得以 `_` 开头（`/plugins/<id>/_api/` 前缀
 * 保留给未来的插件 HTTP 路由）；目标经 realpath 解析后还要再做一次 containment 检查，
 * 快照目录里埋的符号链接不能借此逃出该版本目录。裁决根目录是调用方给的快照根，
 * 不是安装树——本函数对安装树零感知。miss 与拒绝同答 `null`。
 *
 * packageId 可以占一段（`acme/pkg`）或两段（`@scope/pkg`），两种切分都按
 * 「快照目录真实存在」消歧，先试两段再试一段。
 *
 * @param snapshotRoot - daemon 管理的快照根目录，按 `<packageId>/<revision>/` 组织。
 * @param pathname - 请求路径，已由 HTTP 层剥掉 query 与 fragment。
 * @returns 普通文件的绝对规范路径，或 `null`。
 */
export function resolveClientModuleAsset(snapshotRoot: string, pathname: string): string | null {
  const prefix = '/plugins/'
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  if (rest === '' || rest.includes('\0')) return null
  const segments = rest.split('/')
  for (const idSegments of [2, 1]) {
    // 需要 id 各段 + revision 段 + 至少一段包内路径。
    if (segments.length < idSegments + 2) continue
    const id = segments.slice(0, idSegments).join('/')
    if (!PACKAGE_ID_PATTERN.test(id)) continue
    const revision = segments[idSegments] as string
    // `_` 开头的 revision 段（含保留的 `_api`）与 `.`/`..`/空段一律硬性拒绝：切分再换一种也
    // 不允许放行，否则 `/plugins/<id>/_api/…` 会被曲解成「一段 id + 正常 revision」而漏过。
    if (revision === '' || revision === '.' || revision === '..' || revision.startsWith('_')) return null
    let base: string
    try {
      base = realpathSync(join(snapshotRoot, id, revision))
      if (!statSync(base).isDirectory()) continue
      // revision 目录本身若是被埋进快照根的符号链接，realpath 后的 base 会指到快照根之外——
      // 以 base 为 containment 根会放行外部文件，所以 base 必须先证明自己仍在快照根内。
      const canonicalRoot = realpathSync(snapshotRoot)
      const baseRel = relative(canonicalRoot, base)
      if (baseRel === '' || baseRel === '..' || baseRel.startsWith(`..${sep}`) || isAbsolute(baseRel))
        continue
    } catch {
      continue
    }
    const decodedWithin = decodeUrlPathSegments(segments.slice(idSegments + 1))
    if (!decodedWithin) return null
    const within = decodedWithin.join('/')
    const extension = extname(within).slice(1).toLowerCase()
    if (!CLIENT_MODULE_SERVABLE_EXTENSIONS.includes(extension)) return null
    return canonicalFile(resolve(base, within), base)
  }
  return null
}

/** 规范化目标路径，确认它是普通文件，且在 realpath 之后仍位于 `root` 之内。 */
function canonicalFile(target: string, root: string): string | null {
  let canonical: string
  try {
    canonical = realpathSync(target)
    if (!statSync(canonical).isFile()) return null
  } catch {
    return null
  }
  const rel = relative(root, canonical)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return canonical
}
