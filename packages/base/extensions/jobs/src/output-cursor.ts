import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

export type OutputPosition = {
  generation: string
  stdoutStart: number
  stderrStart: number
  lost: number
}
export const outputPosition = (): OutputPosition => ({
  generation: randomUUID(),
  stdoutStart: 0,
  stderrStart: 0,
  lost: 0,
})

/** Stateless authenticated cursors cannot be transplanted to another owner, job or registry. */
export class OutputCursors {
  private readonly key = randomBytes(32)

  read(owner: string, id: string, position: OutputPosition, stdout: string, stderr: string, cursor?: string) {
    const scope = [owner, id, position.generation]
    const ends = [
      position.stdoutStart + Buffer.byteLength(stdout),
      position.stderrStart + Buffer.byteLength(stderr),
    ]
    let offsets = [position.stdoutStart, position.stderrStart]
    let gap = false
    if (cursor !== undefined) {
      try {
        if (cursor.length > 4096) throw new Error()
        const [payload, signature, extra] = cursor.split('.')
        if (!payload || !signature || extra !== undefined) throw new Error()
        const mac = createHmac('sha256', this.key).update(payload).digest()
        const supplied = Buffer.from(signature, 'base64url')
        if (supplied.length !== mac.length || !timingSafeEqual(mac, supplied)) throw new Error()
        const data: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
        if (!Array.isArray(data) || data.length !== 6 || !scope.every((value, i) => data[i] === value))
          throw new Error()
        if (!data.slice(3).every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error()
        offsets = [data[3], data[4]]
        if (offsets.some((value, i) => value > ends[i]!) || data[5] > position.lost) throw new Error()
        gap =
          offsets[0]! < position.stdoutStart || offsets[1]! < position.stderrStart || data[5] < position.lost
      } catch {
        throw new Error(
          'JOB_CURSOR_INVALID: cursor is invalid, belongs to another session/lane/job, or predates a restart; read without a cursor',
        )
      }
    }
    const slice = (text: string, offset: number, start: number) => {
      const bytes = Buffer.from(text)
      let at = Math.max(0, offset - start)
      while (at < bytes.length && (bytes[at]! & 0xc0) === 0x80) at++
      return bytes.subarray(at).toString('utf8')
    }
    const payload = Buffer.from(JSON.stringify([...scope, ...ends, position.lost])).toString('base64url')
    const next = `${payload}.${createHmac('sha256', this.key).update(payload).digest('base64url')}`
    return {
      stdout: slice(stdout, offsets[0]!, position.stdoutStart),
      stderr: slice(stderr, offsets[1]!, position.stderrStart),
      cursor: next,
      gap,
    }
  }
}
