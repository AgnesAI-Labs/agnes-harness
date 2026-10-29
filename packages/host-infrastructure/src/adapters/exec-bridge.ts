import type { ChildProcess } from 'node:child_process'
import type { Duplex } from 'node:stream'

/** Private duplex pipe, separate from program output. Frames and outstanding requests are bounded. */
export function attachProcessBridge(
  child: ChildProcess,
  handler: (frame: unknown) => Promise<unknown>,
  terminate: () => void,
): () => void {
  const pipe = child.stdio[3] as Duplex
  let buffer = Buffer.alloc(0)
  let active = true
  let pending = 0
  const fail = () => {
    if (!active) return
    active = false
    terminate()
  }
  pipe.on('error', fail)
  pipe.on('data', (chunk: Buffer) => {
    if (!active) return
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > 1048576) return fail()
    let end = buffer.indexOf(10)
    while (end >= 0 && active) {
      const line = buffer.subarray(0, end).toString('utf8')
      buffer = buffer.subarray(end + 1)
      let frame: unknown
      try {
        frame = JSON.parse(line)
      } catch {
        return fail()
      }
      if (++pending > 64) return fail()
      void Promise.resolve()
        .then(() => handler(frame))
        .then((reply) => {
          if (!active) return
          const encoded = JSON.stringify(reply) + '\n'
          if (Buffer.byteLength(encoded) > 1048576 || pipe.writableLength > 1048576) return fail()
          pipe.write(encoded)
        }, fail)
        .catch(fail)
        .finally(() => {
          pending--
        })
      end = buffer.indexOf(10)
    }
  })
  return () => {
    active = false
    pipe.destroy()
  }
}
