import { renameSync } from 'node:fs'

const waiting = new Int32Array(new SharedArrayBuffer(4))
/**
 * How long a sync replacement waits for Windows readers to let go of the destination. A reader that
 * has the file open (Defender scanning a file just written, the search indexer, another AGH process
 * reading it) makes the rename fail with EPERM, EACCES or EBUSY; 100 ms was too short under load and
 * failed session creation. This matches the async `renameWriteThrough` bound.
 */
export const REPLACE_WAIT_MS = 1_000

/** Sync publication cannot yield, so it waits in place, backing off from 5 ms to 50 ms between tries.
 * Never unlink the destination, retry a successful move, or hide a permanent refusal. */
export function replacePublishedFileSync(
  source: string,
  target: string,
  windows: boolean,
  rename: (source: string, target: string) => void = renameSync,
): void {
  const deadline = performance.now() + REPLACE_WAIT_MS
  for (let pause = 5; ; pause = Math.min(50, pause * 2)) {
    try {
      rename(source, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!windows || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || performance.now() >= deadline)
        throw error
      Atomics.wait(waiting, 0, 0, pause)
    }
  }
}
