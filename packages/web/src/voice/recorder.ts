import { rmsOf } from './audio.js'

export type RecordedAudio = { channels: Float32Array[]; sampleRate: number }
/** One open microphone: the current loudness, then the decoded recording or nothing. */
export type VoiceInput = { level(): number; stop(): Promise<RecordedAudio>; cancel(): void }
/** The seam over getUserMedia, MediaRecorder, AnalyserNode and decodeAudioData; tests inject a fake. */
export type VoiceMedia = { open(): Promise<VoiceInput> }

const ANALYSER_SIZE = 2048

/**
 * The browser microphone. The recording is compressed by MediaRecorder and decoded back to PCM on stop;
 * the analyser only reports the loudness the buttons and the end-of-speech detector need.
 */
export function browserMedia(): VoiceMedia {
  return {
    async open() {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      const context = new AudioContext()
      const release = () => {
        for (const track of stream.getTracks()) track.stop()
        void context.close().catch(() => undefined)
      }
      try {
        const analyser = context.createAnalyser()
        analyser.fftSize = ANALYSER_SIZE
        context.createMediaStreamSource(stream).connect(analyser)
        const frame = new Float32Array(analyser.fftSize)
        const recorder = new MediaRecorder(stream)
        const chunks: Blob[] = []
        recorder.addEventListener('dataavailable', (event) => {
          if (event.data.size > 0) chunks.push(event.data)
        })
        // Made before recording starts: a recorder that stops on its own (the headset is unplugged)
        // fires its one stop event before anyone asks for the recording.
        const stopped = new Promise<void>((resolve) => {
          recorder.addEventListener('stop', () => resolve(), { once: true })
        })
        recorder.start()
        let finished = false
        return {
          level() {
            analyser.getFloatTimeDomainData(frame)
            return rmsOf(frame)
          },
          async stop() {
            finished = true
            if (recorder.state !== 'inactive') recorder.stop()
            try {
              await stopped
              const bytes = await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer()
              const decoded = await context.decodeAudioData(bytes)
              const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) =>
                decoded.getChannelData(i),
              )
              return { channels, sampleRate: decoded.sampleRate }
            } finally {
              release()
            }
          },
          cancel() {
            if (finished) return
            finished = true
            chunks.length = 0
            if (recorder.state !== 'inactive') recorder.stop()
            release()
          },
        }
      } catch (error) {
        release()
        throw error
      }
    },
  }
}
