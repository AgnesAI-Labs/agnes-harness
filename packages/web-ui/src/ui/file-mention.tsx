import { Icon } from './icon.js'
import type { IconName } from './icon-set.js'

/**
 * A reference to a local file or folder: sent as a `resource_link` whose `uri` is the real absolute
 * path (`file:///…`) and whose `name` is the file name. Only the location travels; nothing is read.
 */
export type FileMention = {
  /** Absolute local path. */
  path: string
  /** File or folder name, shown on the chip. */
  name: string
  directory: boolean
}

/** The MIME type a folder reference carries, so the reader can tell it from a file. */
export const FILE_MENTION_DIRECTORY_MIME = 'inode/directory'

/** `file:///` URI of an absolute path: POSIX as is, a Windows drive path with forward slashes. */
export function fileMentionUri(path: string): string {
  const windows = /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\[^\\]+\\/u.test(path) || /^\/\/[^/]+\//u.test(path)
  const slashed = windows ? path.replace(/\\/g, '/') : path
  const absolute = slashed.startsWith('/') ? slashed : `/${slashed}`
  return `file://${absolute
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%3A/giu, ':'))
    .join('/')}`
}

/** The absolute path of a `file:` URI, or undefined for any other URI. */
export function fileMentionPath(uri: string): string | undefined {
  if (!uri.startsWith('file://')) return undefined
  try {
    const path = decodeURIComponent(uri.slice('file://'.length))
    // `file:///C:/x` names a Windows drive path; keep it as the platform writes it.
    return /^\/[A-Za-z]:\//u.test(path) ? path.slice(1) : path
  } catch {
    return undefined
  }
}

type LinkBlock = { type: string; uri?: string; name?: string; mimeType?: string }

/** The mention a content block carries, if it is a local file or folder link. */
export function fileMentionOf(block: LinkBlock): FileMention | undefined {
  if (block.type !== 'resource_link' || typeof block.uri !== 'string') return undefined
  const path = fileMentionPath(block.uri)
  if (!path) return undefined
  const name = block.name || path.split(/[\\/]/u).filter(Boolean).at(-1) || path
  return { path, name, directory: block.mimeType === FILE_MENTION_DIRECTORY_MIME }
}

/** The content block for a mention. */
export function fileMentionBlock(mention: FileMention): {
  type: 'resource_link'
  uri: string
  name: string
  mimeType?: string
} {
  return {
    type: 'resource_link',
    uri: fileMentionUri(mention.path),
    name: mention.name,
    ...(mention.directory ? { mimeType: FILE_MENTION_DIRECTORY_MIME } : {}),
  }
}

const CODE =
  /\.(?:[cm]?[jt]sx?|json|html?|css|scss|py|go|rs|java|kt|swift|rb|php|c|h|cc|cpp|sh|ya?ml|toml|xml|svg|sql)$/iu
const TEXT = /\.(?:md|mdx|txt|rst|csv|tsv|log|docx?|pdf|rtf)$/iu

/** The icon of a file by its type; a folder has the folder icon. */
export function fileMentionIcon(name: string, directory: boolean): IconName {
  if (directory) return 'folder'
  if (CODE.test(name)) return 'file-code'
  if (TEXT.test(name)) return 'file-text'
  return 'file'
}

/**
 * A file or folder chip inside text: its type icon and name; the full path shows on hover. With
 * `onOpen` it is a button that opens the file.
 */
export function FileMentionChip({
  mention,
  onOpen,
  openLabel,
}: {
  mention: FileMention
  onOpen?: (mention: FileMention) => void
  /** Accessible name of the open action, e.g. "Open bootlab-new.html in the workbench". */
  openLabel?: string
}) {
  const content = (
    <>
      <Icon name={fileMentionIcon(mention.name, mention.directory)} size={16} />
      <span className="agh-file-mention-name">{mention.name}</span>
    </>
  )
  return onOpen ? (
    <button
      type="button"
      className="agh-file-mention"
      data-testid="file-mention-chip"
      data-directory={mention.directory || undefined}
      title={mention.path}
      aria-label={openLabel ?? mention.name}
      onClick={() => onOpen(mention)}
    >
      {content}
    </button>
  ) : (
    <span
      className="agh-file-mention"
      data-testid="file-mention-chip"
      data-directory={mention.directory || undefined}
      title={mention.path}
    >
      {content}
    </span>
  )
}

type FileMentionOpener = (mention: FileMention) => boolean
// The page may load this module more than once (the shell and a region bundle); they share one opener.
const OPENER = Symbol.for('agnes.file-mention.opener')
const slot = globalThis as { [OPENER]?: FileMentionOpener }
/** Where a clicked file chip opens. The session shell registers its workbench here. */
export const fileMentionLinks = {
  register(next: FileMentionOpener): () => void {
    slot[OPENER] = next
    return () => {
      if (slot[OPENER] === next) delete slot[OPENER]
    }
  },
  open(mention: FileMention): boolean {
    return slot[OPENER]?.(mention) ?? false
  },
}
