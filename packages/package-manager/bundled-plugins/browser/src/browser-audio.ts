/** A bounded PCM playout buffer. Starts only from a local user gesture, never in the background. */
export class BrowserAudio {
  #context: AudioContext | undefined
  #activated = false
  #next = 0
  #sources = new Set<AudioBufferSourceNode>()
  resume() {
    // A click on a text-only page must not synchronously open an audio device.
    // Some output drivers block AudioContext construction on the UI thread.
    this.#activated = true
    void this.#context?.resume().catch(() => {})
  }
  push(bytes: Uint8Array, sampleRate: number) {
    if (
      !this.#activated ||
      !Number.isInteger(sampleRate) ||
      sampleRate < 8000 ||
      sampleRate > 192000 ||
      !bytes.length ||
      bytes.length > 16384 ||
      bytes.length % 4
    )
      return
    const count = bytes.length / 4
    if (count / sampleRate > 0.1) return
    if (!this.#context) {
      const Context = globalThis.AudioContext
      if (!Context) return
      try {
        this.#context = new Context()
        void this.#context.resume().catch(() => {})
      } catch {
        // An unavailable device must not terminate the shared picture stream.
        // Retry only after another explicit user gesture, not on every packet.
        this.#activated = false
        return
      }
    }
    const context = this.#context
    if (context.state !== 'running') return
    if (this.#next > context.currentTime + 0.15) this.reset()
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
      this.#sources.delete(source)
      source.disconnect()
    }
    this.#sources.add(source)
    const when = Math.max(context.currentTime + 0.025, this.#next)
    source.start(when)
    this.#next = when + buffer.duration
  }
  reset() {
    for (const source of this.#sources) {
      source.stop()
      source.disconnect()
    }
    this.#sources.clear()
    this.#next = 0
  }
  close() {
    this.reset()
    this.#activated = false
    void this.#context?.close().catch(() => {})
    this.#context = undefined
  }
}
