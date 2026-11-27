import { basename, dirname, join } from 'node:path'
import { fileSecretsDir } from '@agnes/host-common/paths'

export type FileSecretsDirectoryInput = {
  /** Profile pin. An explicit path wins over the default. */
  path?: string | undefined
  /** Caller override used only when the profile does not pin a path. */
  override?: string | undefined
  dataDir: string
  /** Agnes home. When omitted, a data directory named `data` implies its parent. */
  home?: string | undefined
}

function canonicalDir(input: FileSecretsDirectoryInput): string {
  if (input.home !== undefined && input.home !== '') return fileSecretsDir(input.home)
  if (basename(input.dataDir) === 'data') return fileSecretsDir(dirname(input.dataDir))
  return join(input.dataDir, 'secrets')
}

/** Select the file secrets directory without opening or creating a store. */
export function resolveFileSecretsDirectory(input: FileSecretsDirectoryInput): string {
  return input.path ?? input.override ?? canonicalDir(input)
}
