/** A bounded PCM playout buffer. Starts only from a local user gesture, never in the background. */
export class BrowserAudio {
  private context: AudioContext | undefined
  private next = 0
  private sources = new Set<AudioBufferSourceNode>()
  resume() {
    const Context = globalThis.AudioContext
    if (!Context) return
    this.context ??= new Context()
    void this.context.resume().catch(() => {})
  }
  push(bytes: Uint8Array, sampleRate: number) {
    const context = this.context
    if (
      !context ||
      context.state !== 'running' ||
      !Number.isInteger(sampleRate) ||
      sampleRate < 8000 ||
      sampleRate > 192000 ||
      !bytes.length ||
      bytes.length > 16384 ||
      bytes.length % 4
    )
      return
    if (this.next > context.currentTime + 0.15) this.reset()
    const count = bytes.length / 4
    if (count / sampleRate > 0.1) return
    const buffer = context.createBuffer(2, count, sampleRate)
    const values = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel)
      for (let at = 0; at < count; at++) data[at] = values.getInt16((at * 2 + channel) * 2, true) / 32768
    }
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    source.onended = () => {
      this.sources.delete(source)
      source.disconnect()
    }
    this.sources.add(source)
    const when = Math.max(context.currentTime + 0.025, this.next)
    source.start(when)
    this.next = when + buffer.duration
  }
  reset() {
    for (const source of this.sources) {
      source.stop()
      source.disconnect()
    }
    this.sources.clear()
    this.next = 0
  }
  close() {
    this.reset()
    void this.context?.close().catch(() => {})
    this.context = undefined
  }
}
