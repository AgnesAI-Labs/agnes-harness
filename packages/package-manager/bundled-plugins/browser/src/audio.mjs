import { randomUUID } from 'node:crypto'

/** Runs only in the owned page. Preserve native playback while tapping decoded media;
 * disconnect the tap when no workbench viewer remains. No OS audio capture is used. */
function mediaTap({ binding, enabled, epoch }) {
  const key = binding + '_tap'
  let tap = globalThis[key]
  if (!tap) {
    const pending = key + '_pending'
    globalThis[pending]?.disconnect()
    if (!document.querySelector('audio,video')) {
      if (enabled) {
        const observer = new MutationObserver(() => {
          if (document.querySelector('audio,video')) {
            observer.disconnect()
            mediaTap({ binding, enabled, epoch })
          }
        })
        observer.observe(document, { subtree: true, childList: true })
        globalThis[pending] = observer
      }
      return
    }
    if (!enabled) return
  }
  if (!tap) {
    const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext
    if (!Context) return
    const context = new Context()
    const sources = new WeakMap()
    const elements = new Set()
    const mixer = context.createGain()
    const processor = context.createScriptProcessor(2048, 2, 2)
    tap = { enabled: false, context, observer: undefined }
    processor.onaudioprocess = (event) => {
      if (
        !tap.enabled ||
        ![...elements].some(
          (element) => !element.paused && !element.ended && !element.muted && element.volume > 0,
        )
      )
        return
      const input = event.inputBuffer
      const bytes = new Uint8Array(input.length * 4)
      const samples = new DataView(bytes.buffer)
      for (let channel = 0; channel < 2; channel++) {
        const values = input.getChannelData(Math.min(channel, input.numberOfChannels - 1))
        for (let index = 0; index < values.length; index++)
          samples.setInt16(
            (index * 2 + channel) * 2,
            Math.round(Math.max(-1, Math.min(1, values[index])) * 32767),
            true,
          )
      }
      void globalThis[binding]({
        epoch: tap.epoch,
        rate: input.sampleRate,
        data: btoa(String.fromCharCode(...bytes)),
      }).catch(() => {})
    }
    const scan = () => {
      for (const element of document.querySelectorAll('audio,video')) {
        if (element.srcObject) continue
        const sourceUrl = element.currentSrc || element.src || element.querySelector('source')?.src
        if (!sourceUrl) continue
        const url = new URL(sourceUrl, location.href)
        if (
          !['data:', 'blob:'].includes(url.protocol) &&
          url.origin !== location.origin &&
          !element.crossOrigin
        )
          continue
        if (!sources.has(element)) {
          try {
            const source = context.createMediaElementSource(element)
            source.connect(context.destination)
            sources.set(element, source)
          } catch {
            continue
          }
        }
        if (!elements.has(element)) {
          elements.add(element)
          sources.get(element).connect(mixer)
        }
      }
      for (const element of elements)
        if (!element.isConnected) {
          sources.get(element).disconnect()
          elements.delete(element)
        }
    }
    const resume = () => {
      if (tap.enabled && [...elements].some((element) => !element.paused && !element.ended))
        void context.resume().catch(() => {})
    }
    document.addEventListener('pointerdown', resume, true)
    document.addEventListener(
      'play',
      () => {
        scan()
        resume()
      },
      true,
    )
    tap.set = (value) => {
      if (tap.enabled === value) return
      tap.enabled = value
      if (value) {
        scan()
        mixer.connect(processor)
        processor.connect(context.destination)
        tap.observer = new MutationObserver(scan)
        tap.observer.observe(document, { subtree: true, childList: true })
        resume()
      } else {
        tap.observer?.disconnect()
        mixer.disconnect()
        processor.disconnect()
      }
    }
    globalThis[key] = tap
  }
  tap.epoch = epoch
  tap.set(enabled)
}

/** PCM shares the admitted picture transport and its bounded media allowance. */
export async function captureAudio(runtime, item, capture) {
  if (!item.page.exposeBinding) return // Old test/embedding pages need no audio capability.
  item.audioBinding ??= '__aghAudio_' + randomUUID().replaceAll('-', '')
  const binding = item.audioBinding
  if (!item.audioInstalled) {
    await item.page.exposeBinding(binding, (source, value) => {
      const current = item.capture
      if (
        !current ||
        source.frame !== item.page.mainFrame() ||
        !item.modernViewers?.size ||
        !value ||
        value.epoch !== item.epoch ||
        typeof value.data !== 'string' ||
        value.data.length > 24000 ||
        !Number.isInteger(value.rate) ||
        value.rate < 8000 ||
        value.rate > 192000
      )
        return
      try {
        runtime.guard()
        const bytes = Buffer.from(value.data, 'base64')
        if (!bytes.length || bytes.length > 16384 || bytes.length % 4) return
        const { url: _url, ...description } = runtime.describe(item)
        const metadata = Buffer.from(
          JSON.stringify({ ...description, media: 'audio', sampleRate: value.rate }),
        )
        const header = Buffer.alloc(4)
        header.writeUInt32BE(metadata.length)
        const envelope = Buffer.concat([header, metadata, bytes])
        for (const viewer of item.modernViewers) viewer.send(envelope)
      } catch {
        /* Revoked or closed pages cannot publish sound. */
      }
    })
    item.audioInstalled = true
  }
  let stopped = false
  const attach = async () => {
    if (stopped || item.capture !== capture) return
    await item.page.evaluate(mediaTap, { binding, enabled: true, epoch: item.epoch }).catch(() => {})
    if ((stopped || item.capture !== capture) && (!item.capture || item.capture === capture))
      await item.page.evaluate(mediaTap, { binding, enabled: false, epoch: item.epoch }).catch(() => {})
  }
  item.page.on('domcontentloaded', attach)
  // Frame replacement also invalidates the page's observation epoch. Keep the
  // existing main-document audio tap current without reconnecting its sources.
  const navigate = () => void attach()
  item.page.on('framenavigated', navigate)
  item.page.on('framedetached', navigate)
  await attach()
  return async () => {
    stopped = true
    item.page.off('domcontentloaded', attach)
    item.page.off('framenavigated', navigate)
    item.page.off('framedetached', navigate)
    await item.page.evaluate(mediaTap, { binding, enabled: false, epoch: item.epoch }).catch(() => {})
  }
}
