export type LockOwner = Readonly<{ pid: number; startId?: string; token: string }>
export function pidExists(pid: number): boolean
export function readLockOwner(lock: string): LockOwner | undefined
export function acquireOwnerFileLock(lock: string, owner: LockOwner): boolean
export function takeOverOwnerFileLock(lock: string, seenToken: string): void
export function releaseOwnerFileLock(lock: string, token: string): void
