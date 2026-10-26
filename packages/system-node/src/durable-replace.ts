import { renameSync } from 'node:fs'

const waiting = new Int32Array(new SharedArrayBuffer(4))

/** Sync publication cannot yield; bound the wait for external Windows readers to 100 ms.
 * Never unlink the destination, retry a successful move, or hide a permanent refusal. */
export function replacePublishedFileSync(source: string, target: string, windows: boolean): void {
  const deadline = performance.now() + 100
  for (;;) {
    try {
      renameSync(source, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!windows || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || performance.now() >= deadline)
        throw error
      Atomics.wait(waiting, 0, 0, 5)
    }
  }
}
