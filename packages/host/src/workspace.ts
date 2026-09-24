import { constants } from 'node:fs'
import { access, opendir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { createPlatform } from './adapters/platform.js'

export type WorkspaceInvalidReason = 'not-absolute' | 'not-found' | 'not-directory' | 'not-accessible'

/** A directory selection failure that callers can map without parsing an OS-specific message. */
export class WorkspaceDirectoryError extends Error {
  readonly reason: WorkspaceInvalidReason

  constructor(reason: WorkspaceInvalidReason, cause?: unknown) {
    super(`workspace directory is invalid: ${reason}`, { cause })
    this.name = 'WorkspaceDirectoryError'
    this.reason = reason
  }
}

export type WorkspaceDirectory = Readonly<{ path: string; name: string }>

const filesystemReason = (error: unknown): WorkspaceInvalidReason => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'not-found' : 'not-accessible'
}

/**
 * Confirms an existing workspace directory and returns its stable filesystem identity.
 *
 * This is validation, not authorization. The returned path does not extend a Host file policy;
 * session assembly still fits and enforces its own workspace sandbox before any operation runs.
 */
export async function resolveWorkspaceDirectory(input: string): Promise<WorkspaceDirectory> {
  if (!input || input.includes('\0') || !isAbsolute(input)) throw new WorkspaceDirectoryError('not-absolute')

  let path: string
  try {
    path = await realpath(input)
  } catch (error) {
    throw new WorkspaceDirectoryError(filesystemReason(error), error)
  }

  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(path)
  } catch (error) {
    throw new WorkspaceDirectoryError(filesystemReason(error), error)
  }
  if (!info.isDirectory()) throw new WorkspaceDirectoryError('not-directory')

  try {
    if (createPlatform().os === 'win32') {
      // Windows access() does not establish directory read permission from its DACL.
      const directory = await opendir(path)
      await directory.close()
    } else await access(path, constants.R_OK | constants.X_OK)
  } catch (error) {
    throw new WorkspaceDirectoryError('not-accessible', error)
  }

  return Object.freeze({ path, name: basename(path) || path })
}
