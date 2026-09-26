export type FsIoKind = 'file' | 'dir' | 'symlink' | 'other'
export type FsIoStat = Readonly<{ kind: FsIoKind; size: number; mtimeMs: number }>

/**
 * The raw storage under the fence. Every path is absolute and already lexically resolved; the
 * fence has not yet decided anything about it, and the io must not either. lstat never follows the
 * final link - that is what lets the fence see a symlink before it is crossed.
 */
export type FsIo = Readonly<{
  /** Resolves undefined for ENOENT and ENOTDIR (a path through a plain file); throws otherwise. */
  lstat(abs: string): Promise<FsIoStat | undefined>
  readlink(abs: string): Promise<string>
  readFile(abs: string): Promise<Uint8Array>
  writeFile(abs: string, data: Uint8Array): Promise<void>
  /** Recursive. */
  mkdir(abs: string): Promise<void>
  readdir(abs: string): Promise<readonly { name: string; kind: FsIoKind }[]>
  rm(abs: string, opts: { recursive: boolean }): Promise<void>
  /**
   * The volume's own spelling of an existing path that contains no link. Present only where one
   * directory entry answers to more than one name - Windows, where every entry may also carry an
   * 8.3 short name - so the fence decides on a single spelling of each entry. Absent means the
   * spelling the walk reached is already the only one.
   */
  finalPath?(abs: string): Promise<string>
}>
