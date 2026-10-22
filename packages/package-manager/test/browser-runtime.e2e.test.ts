import { createReadStream, existsSync } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import { expect, it } from 'vitest'

const { BrowserRuntime } = await import(
  new URL('../bundled-plugins/browser/src/runtime.mjs', import.meta.url).href
)
const { createLauncher } = await import(
  new URL('../bundled-plugins/browser/src/launcher.mjs', import.meta.url).href
)
const { showPage, showView, selectView } = await import(
  new URL('../bundled-plugins/browser/src/streams.mjs', import.meta.url).href
)
const archive = process.env.AGH_BROWSER_TEST_ARCHIVE

it.skipIf(process.env.AGH_BROWSER_TEST_CACHED !== '1')(
  'reflows the same page at adaptive and fixed sizes, preserves sharp scroll frames and rejects stale clicks',
  async () => {
    const website = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>
        body{margin:0;font:16px system-ui;background:white;color:#123}
        .grid{display:grid;grid-template-columns:repeat(3,1fr)}
        @media(max-width:760px){.grid{grid-template-columns:1fr}}
        button{position:fixed;right:10px;bottom:10px;width:80px;height:50px;border:0;background:white}
        p{height:48px;margin:0} </style><div class="grid"><div>一</div><div>二</div><div>三</div></div>
        ${Array.from({ length: 150 }, (_, index) => `<p>清晰文字 Sharp scrolling ${index}</p>`).join('')}
        <button>0</button><script>let n=0;document.querySelector('button').onclick=e=>{e.target.textContent=++n;e.target.style.background=n%2?'rgb(0,128,0)':'white'}</script>`)
    })
    await new Promise<void>((resolve) => website.listen(0, '127.0.0.1', resolve))
    const port = (website.address() as { port: number }).port
    const launcher = createLauncher()
    const runtime = new BrowserRuntime({ launch: () => launcher.launch() })
    const session = { key: 'responsive-test', lane: 'main' },
      actor = { id: 'responsive-viewer' }
    const viewer = new AbortController()
    const frames: { metadata: Record<string, any>; bytes: Buffer }[] = []
    let sequence = 0,
      inputSequence = 0,
      clicks = 0
    try {
      const opened = await runtime.act(session, { action: 'open', url: `http://127.0.0.1:${port}/` })
      const item = runtime.get(session, opened.pageId),
        page = item.page
      const context = { session, actor }
      await showView(
        runtime,
        {
          pageId: opened.pageId,
          viewId: 'adaptive',
          viewport: { width: 540, height: 900 },
          displayVersion: 2,
        },
        {
          actor,
          scope: { kind: 'session', sessionId: session.key, laneId: 'main' },
          signal: viewer.signal,
          stream: {
            send(value: Uint8Array) {
              const frame = Buffer.from(value),
                size = frame.readUInt32BE()
              const metadata = JSON.parse(frame.subarray(4, size + 4).toString())
              if (metadata.media !== 'audio') frames.push({ metadata, bytes: frame.subarray(size + 4) })
              return 'accepted'
            },
            close() {},
            onDisconnect() {},
          },
        },
      )
      const control = await runtime.control(session, { pageId: opened.pageId, mode: 'human' }, actor)
      const feedback: number[] = []
      for (const viewport of [
        { width: 540, height: 900 },
        { width: 1000, height: 650 },
        { width: 1280, height: 800 },
        { width: 420, height: 1100 },
      ]) {
        const before = runtime.describe(item)
        await selectView(
          runtime,
          { viewId: 'adaptive', pageId: opened.pageId, sequence: ++sequence, viewport },
          context,
        )
        expect(
          await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })),
        ).toEqual({ ...viewport, dpr: 2 })
        expect(
          (
            await page
              .locator('.grid')
              .evaluate((element: Element) => getComputedStyle(element).gridTemplateColumns)
          ).split(' '),
        ).toHaveLength(viewport.width <= 760 ? 1 : 3)
        const current = runtime.describe(item)
        await expect
          .poll(() => frames.at(-1)?.metadata.pageEpoch, { timeout: 10_000 })
          .toBe(current.pageEpoch)
        await expect.poll(() => frames.at(-1)?.metadata.frameMime, { timeout: 10_000 }).toBe('image/png')
        expect(await sharp(frames.at(-1)!.bytes).metadata()).toMatchObject({
          width: viewport.width * 2,
          height: viewport.height * 2,
        })
        if (before.pageEpoch !== current.pageEpoch)
          await expect(
            runtime.humanInput(
              session,
              { ...control, seq: inputSequence++, pageEpoch: before.pageEpoch, type: 'click', x: 10, y: 10 },
              actor,
            ),
          ).rejects.toMatchObject({ code: 'STALE_INPUT' })
        const started = performance.now()
        await runtime.humanInput(
          session,
          {
            ...control,
            seq: inputSequence++,
            pageEpoch: current.pageEpoch,
            type: 'click',
            x: viewport.width - 40,
            y: viewport.height - 40,
          },
          actor,
        )
        clicks++
        expect(await page.locator('button').innerText()).toBe(String(clicks))
        await expect
          .poll(
            async () => {
              const frame = frames.at(-1)!
              if (frame.metadata.pageEpoch !== current.pageEpoch) return false
              const pixel = await sharp(frame.bytes)
                .extract({
                  left: (viewport.width - 30) * 2,
                  top: (viewport.height - 25) * 2,
                  width: 1,
                  height: 1,
                })
                .removeAlpha()
                .raw()
                .toBuffer()
              return clicks % 2 ? pixel[1]! > 120 && pixel[0]! < 10 : pixel[0]! > 245 && pixel[1]! > 245
            },
            { timeout: 5000, interval: 5 },
          )
          .toBe(true)
        feedback.push(performance.now() - started)
      }
      const epoch = runtime.describe(item).pageEpoch
      const scrollStart = frames.length
      const scrollFeedback: number[] = []
      for (let index = 0; index < 8; index++) {
        const priorY = await page.evaluate(() => scrollY)
        const priorFrames = frames.length
        const started = performance.now()
        await runtime.humanInput(
          session,
          { ...control, seq: inputSequence++, pageEpoch: epoch, type: 'scroll', x: 0, y: 120.5 },
          actor,
        )
        await expect.poll(() => page.evaluate(() => scrollY), { interval: 5 }).toBeGreaterThan(priorY)
        await expect.poll(() => frames.length, { interval: 5 }).toBeGreaterThan(priorFrames)
        expect(frames.at(-1)!.metadata.frameMime).toBe('image/png')
        scrollFeedback.push(performance.now() - started)
      }
      expect(frames.slice(scrollStart).every((frame) => frame.metadata.frameMime === 'image/png')).toBe(true)
      expect(await sharp(frames.at(-1)!.bytes).metadata()).toMatchObject({ width: 840, height: 2200 })
      const reference = await sharp(await page.screenshot({ scale: 'device' }))
        .removeAlpha()
        .raw()
        .toBuffer()
      await expect
        .poll(
          async () => {
            const actual = await sharp(frames.at(-1)!.bytes).removeAlpha().raw().toBuffer()
            return actual.equals(reference)
          },
          { timeout: 10_000, interval: 20 },
        )
        .toBe(true)
      feedback.sort((a, b) => a - b)
      const p95 = Math.round(feedback[Math.ceil(feedback.length * 0.95) - 1]!)
      scrollFeedback.sort((a, b) => a - b)
      const scrollP95 = Math.round(scrollFeedback[Math.ceil(scrollFeedback.length * 0.95) - 1]!)
      console.info(
        'Adaptive browser measurement',
        JSON.stringify({
          clickFeedbackP95Ms: p95,
          scrollFeedbackP95Ms: scrollP95,
          scrollFrames: frames.length - scrollStart,
          scrollMime: 'image/png',
          logical: '420x1100',
          raster: '840x2200',
        }),
      )
      expect(p95).toBeLessThan(250)
      expect(scrollP95).toBeLessThan(250)
    } finally {
      viewer.abort()
      launcher.cancel()
      try {
        await runtime.close()
      } finally {
        await new Promise<void>((resolve, reject) =>
          website.close((error) => (error ? reject(error) : resolve())),
        )
      }
    }
  },
)

// A single VP8 frame in a small valid WebM container, generated without external tools.
function webm(packet: Buffer) {
  const element = (id: string, bytes: Buffer) =>
    Buffer.concat([
      Buffer.from(id, 'hex'),
      bytes.length < 127
        ? Buffer.from([0x80 | bytes.length])
        : Buffer.from([0x40 | (bytes.length >> 8), bytes.length & 255]),
      bytes,
    ])
  const uint = (id: string, value: number) => element(id, Buffer.from([value]))
  const header = element(
    '1a45dfa3',
    Buffer.concat([
      uint('4286', 1),
      uint('42f7', 1),
      uint('42f2', 4),
      uint('42f3', 8),
      element('4282', Buffer.from('webm')),
      uint('4287', 2),
      uint('4285', 2),
    ]),
  )
  const duration = Buffer.alloc(8)
  duration.writeDoubleBE(1000)
  const info = element(
    '1549a966',
    Buffer.concat([element('2ad7b1', Buffer.from([15, 66, 64])), element('4489', duration)]),
  )
  const track = element(
    '1654ae6b',
    element(
      'ae',
      Buffer.concat([
        uint('d7', 1),
        uint('73c5', 1),
        uint('83', 1),
        element('86', Buffer.from('V_VP8')),
        element('e0', Buffer.concat([uint('b0', 32), uint('ba', 32)])),
      ]),
    ),
  )
  const cluster = element(
    '1f43b675',
    Buffer.concat([uint('e7', 0), element('a3', Buffer.concat([Buffer.from([0x81, 0, 0, 0x80]), packet]))]),
  )
  return Buffer.concat([header, element('18538067', Buffer.concat([info, track, cluster]))])
}

it.skipIf(process.env.AGH_BROWSER_TEST_CACHED !== '1')(
  'renders authorized files in the pinned background browser and publishes sharp frames with responsive input',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agh-browser-files-中文-')))
    const launcher = createLauncher()
    const runtime = new BrowserRuntime({ launch: () => launcher.launch() })
    const session = { key: 'file-test', lane: 'main' }
    const files = {
      async stat(path: string) {
        const info = await lstat(path)
        return { kind: info.isFile() ? 'file' : 'dir', size: info.size, mtimeMs: info.mtimeMs }
      },
      async read(path: string, opts: { offset: number; limit: number }) {
        const handle = await open(path, 'r')
        try {
          const bytes = Buffer.alloc(opts.limit)
          const result = await handle.read(bytes, 0, bytes.length, opts.offset)
          return bytes.subarray(0, result.bytesRead)
        } finally {
          await handle.close()
        }
      },
    }
    const access = { root, files }
    const viewer = new AbortController()
    let website: ReturnType<typeof createServer> | undefined
    try {
      await writeFile(
        join(root, 'style.css'),
        'body{margin:0}button{width:1280px;height:800px;background:white;border:0}',
      )
      await writeFile(
        join(root, 'app.js'),
        'let count=0;document.querySelector("button").onclick=()=>document.querySelector("button").style.background=++count%2?"rgb(0,128,0)":"white"',
      )
      await writeFile(
        join(root, 'index.html'),
        '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><button>清晰文字 Browser test</button><script src="app.js"></script>',
      )
      await writeFile(
        join(root, 'image.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>',
      )
      await sharp({ create: { width: 32, height: 32, channels: 3, background: '#abcdef' } })
        .png()
        .toFile(join(root, 'image.png'))
      await writeFile(join(root, 'data.json'), '{"message":"中文"}')
      await writeFile(join(root, 'data.xml'), '<test>XML</test>')
      await writeFile(join(root, 'note.txt'), 'Readable text 中文')
      await writeFile(join(root, 'utf8.html'), '<!doctype html><p>中文预览</p>')
      await writeFile(join(root, 'commented.html'), '<!-- <meta charset="utf-8"> --><p>中文</p>')
      await writeFile(
        join(root, 'description.html'),
        '<meta name="description" content="Use charset=utf-8"><p>中文</p>',
      )
      await writeFile(
        join(root, 'scripted.html'),
        '<script>const x=\'<meta charset="utf-8">\'</script><p>中文</p>',
      )
      await writeFile(
        join(root, 'quoted.html'),
        Buffer.concat([
          Buffer.from('<meta data-note=">" charset="gbk">' + ' '.repeat(4096) + '<p>'),
          Buffer.from('d6d0cec4', 'hex'),
          Buffer.from('</p>'),
        ]),
      )
      await writeFile(
        join(root, 'legacy.html'),
        Buffer.concat([
          Buffer.from('<meta charset="gbk"><p>'),
          Buffer.from('d6d0cec4', 'hex'),
          Buffer.from('</p>'),
        ]),
      )
      await writeFile(
        join(root, 'bom.txt'),
        Buffer.concat([Buffer.from([255, 254]), Buffer.from('中文', 'utf16le')]),
      )
      // One second of PCM audio: no proprietary codec or external fixture dependency.
      const wave = Buffer.alloc(44 + 16000)
      wave.write('RIFF')
      wave.writeUInt32LE(wave.length - 8, 4)
      wave.write('WAVEfmt ', 8)
      wave.writeUInt32LE(16, 16)
      wave.writeUInt16LE(1, 20)
      wave.writeUInt16LE(1, 22)
      wave.writeUInt32LE(8000, 24)
      wave.writeUInt32LE(16000, 28)
      wave.writeUInt16LE(2, 32)
      wave.writeUInt16LE(16, 34)
      wave.write('data', 36)
      wave.writeUInt32LE(16000, 40)
      for (let index = 0; index < 8000; index++)
        wave.writeInt16LE(Math.round(Math.sin((index * Math.PI * 2 * 440) / 8000) * 12000), 44 + index * 2)
      await writeFile(join(root, 'audio.wav'), wave)
      const parts = ['%PDF-1.4\n'],
        offsets = [0]
      for (const object of [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>',
        '<< /Length 0 >>\nstream\n\nendstream',
      ]) {
        offsets.push(Buffer.byteLength(parts.join('')))
        parts.push(`${offsets.length - 1} 0 obj\n${object}\nendobj\n`)
      }
      const xref = Buffer.byteLength(parts.join(''))
      parts.push(
        'xref\n0 5\n0000000000 65535 f \n' +
          offsets
            .slice(1)
            .map((at) => String(at).padStart(10, '0') + ' 00000 n \n')
            .join('') +
          `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`,
      )
      await writeFile(join(root, 'document.pdf'), parts.join(''))
      const opened = await runtime.act(session, { action: 'open', url: 'index.html' }, undefined, access)
      expect(opened.url).toContain('file:///')
      const page = runtime.get(session, opened.pageId).page
      const failedResources: string[] = []
      page.on('requestfailed', (request: any) => failedResources.push(request.url()))
      expect(await page.locator('button').innerText()).toContain('清晰文字')
      await expect
        .poll(() => page.locator('button').evaluate((node: Element) => getComputedStyle(node).width))
        .toBe('1280px')
      let latest: Buffer | undefined,
        frameMime: string | undefined,
        frameCount = 0
      await showPage(
        runtime,
        { pageId: opened.pageId, displayVersion: 2 },
        {
          scope: { kind: 'session', sessionId: session.key, laneId: 'main' },
          signal: viewer.signal,
          stream: {
            send(value: Uint8Array) {
              const frame = Buffer.from(value),
                size = frame.readUInt32BE()
              frameMime = JSON.parse(frame.subarray(4, 4 + size).toString()).frameMime
              latest = frame.subarray(4 + size)
              frameCount++
              return 'accepted'
            },
            onDisconnect() {},
            close() {},
          },
        },
      )
      await expect.poll(() => frameMime, { timeout: 10000 }).toBe('image/png')
      // Surface capture must settle at sharp pixels instead of repeatedly
      // downgrading them with its own transient compositor repaints.
      await delay(750)
      expect(frameMime).toBe('image/png')
      expect(await sharp(latest!).metadata()).toMatchObject({ width: 2560, height: 1600 })
      const actor = { id: 'file-user' }
      const control = await runtime.control(session, { pageId: opened.pageId, mode: 'human' }, actor)
      const feedback: number[] = []
      for (let seq = 0; seq < 12; seq++) {
        const started = performance.now()
        await runtime.humanInput(session, { ...control, seq, type: 'click', x: 100, y: 100 }, actor)
        await expect
          .poll(
            async () => {
              if (!latest) return false
              const pixel = await sharp(latest)
                .extract({ left: 10, top: 10, width: 1, height: 1 })
                .removeAlpha()
                .raw()
                .toBuffer()
              return seq % 2 === 0
                ? pixel[1]! > 120 && pixel[0]! < 10 && pixel[2]! < 10
                : pixel[0]! > 245 && pixel[1]! > 245 && pixel[2]! > 245
            },
            { timeout: 5000, interval: 5 },
          )
          .toBe(true)
        feedback.push(performance.now() - started)
      }
      feedback.sort((left, right) => left - right)
      const feedbackP95Ms = feedback[Math.ceil(feedback.length * 0.95) - 1]!
      console.info(
        'Browser measurement',
        JSON.stringify({
          backendFeedbackP95Ms: Math.round(feedbackP95Ms),
          samples: feedback.length,
          frameCount,
          display: '2560x1600',
          logical: '1280x800',
        }),
      )
      expect(feedbackP95Ms).toBeLessThan(150)
      await runtime.control(session, { pageId: opened.pageId, mode: 'agent' }, actor)
      await runtime.act(session, { action: 'inspect', pageId: opened.pageId })
      viewer.abort()
      const recorded = await page.evaluate(async () => {
        const canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 32
        canvas.getContext('2d')!.fillRect(0, 0, 32, 32)
        let bytes = new Uint8Array()
        const encoder = new (globalThis as any).VideoEncoder({
          output(chunk: any) {
            bytes = new Uint8Array(chunk.byteLength)
            chunk.copyTo(bytes)
          },
          error(error: Error) {
            throw error
          },
        })
        encoder.configure({ codec: 'vp8', width: 32, height: 32, framerate: 1 })
        const frame = new (globalThis as any).VideoFrame(canvas, { timestamp: 0 })
        encoder.encode(frame, { keyFrame: true })
        frame.close()
        await encoder.flush()
        encoder.close()
        if (!bytes.length) throw new Error('Video encoder produced no fixture')
        return btoa(String.fromCharCode(...bytes))
      })
      await writeFile(join(root, 'video.webm'), webm(Buffer.from(recorded, 'base64')))
      for (const name of [
        'image.svg',
        'image.png',
        'data.json',
        'data.xml',
        'note.txt',
        'utf8.html',
        'commented.html',
        'description.html',
        'scripted.html',
        'quoted.html',
        'legacy.html',
        'bom.txt',
        'audio.wav',
        'video.webm',
        'document.pdf',
      ]) {
        await runtime.act(session, { action: 'open', url: name, pageId: opened.pageId }, undefined, access)
        expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:/)
        if (name.endsWith('.png'))
          expect(await page.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(32)
        if (name.endsWith('.wav')) {
          await expect
            .poll(() => page.locator('audio,video').evaluate((audio: HTMLMediaElement) => audio.readyState), {
              timeout: 5000,
            })
            .toBeGreaterThan(0)
          expect(
            await page.locator('audio,video').evaluate((audio: HTMLMediaElement) => audio.duration),
          ).toBe(1)
          // A player may acquire its source only when playback starts.
          const audioUrl = page.url()
          await page.locator('audio,video').evaluate((audio: HTMLMediaElement) => {
            audio.removeAttribute('src')
            audio.load()
          })
          const audioView = new AbortController()
          let audible = false
          try {
            await showPage(
              runtime,
              { pageId: opened.pageId, displayVersion: 2 },
              {
                scope: { kind: 'session', sessionId: session.key, laneId: 'main' },
                signal: audioView.signal,
                stream: {
                  send(value: Uint8Array) {
                    const frame = Buffer.from(value),
                      size = frame.readUInt32BE()
                    const metadata = JSON.parse(frame.subarray(4, size + 4).toString())
                    if (metadata.media === 'audio')
                      audible ||= frame.subarray(size + 4).some((byte) => byte !== 0)
                    return 'accepted'
                  },
                  onDisconnect() {},
                  close() {},
                },
              },
            )
            await page.locator('audio,video').evaluate(async (audio: HTMLMediaElement, url: string) => {
              audio.src = url
              await audio.play()
            }, audioUrl)
            await expect.poll(() => audible, { timeout: 5000 }).toBe(true)
          } finally {
            audioView.abort()
          }
        }
        if (name.endsWith('.webm')) {
          await expect
            .poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.videoWidth), {
              timeout: 5000,
            })
            .toBe(32)
        }
        if (
          [
            'note.txt',
            'utf8.html',
            'commented.html',
            'description.html',
            'scripted.html',
            'quoted.html',
            'legacy.html',
            'bom.txt',
          ].includes(name)
        )
          expect(await page.locator('body').innerText()).toContain('中文')
        if (name.endsWith('.pdf')) {
          await expect
            .poll(
              async () => {
                const frame = page
                  .frames()
                  .find((candidate: any) => candidate.url().startsWith('chrome-extension:'))
                return frame ? frame.locator('embed').count() : 0
              },
              { timeout: 10000 },
            )
            .toBe(1)
          await expect
            .poll(
              async () => {
                const bytes = await sharp(await page.screenshot({ scale: 'css' }))
                  .raw()
                  .removeAlpha()
                  .toBuffer()
                let white = 0
                for (let at = 0; at < bytes.length; at += 3)
                  if (bytes[at] === 255 && bytes[at + 1] === 255 && bytes[at + 2] === 255) white++
                return white
              },
              { timeout: 10000 },
            )
            .toBeGreaterThan(10000)
            .catch(async (error) => {
              if (process.env.AGH_BROWSER_TEST_OUTPUT)
                await page.screenshot({ path: join(process.env.AGH_BROWSER_TEST_OUTPUT, 'pdf-failed.png') })
              console.info('PDF rendering failure', {
                failedResources,
                frames: page.frames().map((frame: any) => frame.url()),
              })
              throw error
            })
          if (process.env.AGH_BROWSER_TEST_OUTPUT)
            await page.screenshot({ path: join(process.env.AGH_BROWSER_TEST_OUTPUT, 'pdf.png') })
          expect(failedResources).toEqual([])
        }
      }
      const events = await runtime.act(session, { action: 'events', pageId: opened.pageId })
      expect(events.events.filter((e: { kind: string }) => e.kind === 'pageerror')).toEqual([])
      const fileOrigin = new URL(page.url()).origin
      await writeFile(join(root, 'leak.js'), 'globalThis.__fileLeaked = true')
      website = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end(`<h1>Untrusted website</h1><script src="${fileOrigin}/leak.js"></script>`)
      })
      await new Promise<void>((done) => website!.listen(0, '127.0.0.1', done))
      const address = website.address()
      if (!address || typeof address === 'string') throw new Error('Missing website address')
      const external = await runtime.act(session, {
        action: 'open',
        url: `http://127.0.0.1:${address.port}`,
        pageId: opened.pageId,
      })
      expect(await page.evaluate(() => '__fileLeaked' in globalThis)).toBe(false)
      expect(failedResources).toContain(fileOrigin + '/leak.js')
      await runtime.act(session, { action: 'back', pageId: opened.pageId, pageEpoch: external.pageEpoch })
      expect(runtime.list(session)[0].url).toContain('document.pdf')
      await writeFile(join(root, 'archive.zip'), Buffer.from([0x50, 0x4b, 3, 4, 0, 0]))
      await expect(
        runtime.act(
          session,
          { action: 'open', url: 'archive.zip', pageId: opened.pageId },
          undefined,
          access,
        ),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' })
    } finally {
      viewer.abort()
      await runtime.close()
      website?.closeAllConnections()
      await new Promise<void>((done) => (website ? website.close(() => done()) : done()))
      await rm(root, { recursive: true, force: true })
    }
  },
  60000,
)

it.skipIf((!archive || !existsSync(archive)) && process.env.AGH_BROWSER_TEST_CACHED !== '1')(
  'uses the pinned archive/cache and shares a real Chromium page across tools, frames and legacy human input',
  async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'agh-browser-e2e-中文 space-'))
    if (!cacheRoot.startsWith(join(tmpdir(), 'agh-browser-e2e-')))
      throw new Error('Unexpected test cache path')
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(
        '<!doctype html><meta charset="utf-8"><style>body{margin:0;min-height:2000px}#bottom{position:absolute;top:900px;left:0;width:1280px;height:800px;background:rgb(0,128,0)}</style><h1>AGH browser fixture</h1>' +
          '<p id="identity"></p><input placeholder="Name"><button onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'input\').value">Confirm</button>' +
          '<p id="result"></p><div id="bottom"></div><script>document.querySelector("#identity").textContent=crypto.randomUUID()</script>',
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture did not start')
    const url = 'http://127.0.0.1:' + address.port
    const launcher = createLauncher(
      archive
        ? {
            cacheRoot,
            fetchArchive: async () => ({ ok: true, body: createReadStream(archive) }),
          }
        : {},
    )
    const store = new Map()
    let instance: { isConnected(): boolean } | undefined
    const runtime = new BrowserRuntime({
      launch: async () => {
        const browser = await launcher.launch()
        const newContext = browser.newContext.bind(browser)
        // Exercise retina frames explicitly, independent of the machine's display scale.
        browser.newContext = (options: Record<string, unknown>) =>
          newContext({ ...options, deviceScaleFactor: 2 })
        instance = browser
        return browser
      },
      store: {
        get: (key: string) => store.get(key),
        set: (key: string, value: unknown) => store.set(key, value),
      },
    })
    const session = { key: 'real-session', lane: 'main' }
    try {
      if (archive) {
        launcher.prepare(runtime)
        await expect(runtime.act(session, { action: 'open', url })).rejects.toMatchObject({
          code: 'PREPARING',
        })
        expect(runtime.status()).toMatchObject({ enabled: true, state: 'preparing', error: null })
        const deadline = Date.now() + 120_000
        while (runtime.status().state === 'preparing' && Date.now() < deadline) await delay(100)
      } else await launcher.check(runtime)
      expect(runtime.status(), runtime.status().error ?? 'Browser preparation timed out').toMatchObject({
        state: 'ready',
        error: null,
      })
      const opened = await runtime.act(session, { action: 'open', url })
      const item = runtime.get(session, opened.pageId)
      const page = item.page
      expect(await page.evaluate(() => devicePixelRatio)).toBe(2)
      let frames = 0,
        shownPage: string | undefined,
        shownEpoch: number | undefined,
        latestPixels: Buffer | undefined
      const shown = new AbortController()
      let onDisconnect: (() => void) | undefined
      await showPage(
        runtime,
        { pageId: opened.pageId },
        {
          scope: { kind: 'session', sessionId: session.key, laneId: 'main' },
          signal: shown.signal,
          stream: {
            send(bytes: Uint8Array) {
              const frame = Buffer.from(bytes),
                size = frame.readUInt32BE()
              const description = JSON.parse(frame.subarray(4, 4 + size).toString())
              shownPage = description.pageId
              shownEpoch = description.pageEpoch
              latestPixels = frame.subarray(size + 4)
              expect(['image/jpeg', 'image/png']).toContain(description.frameMime)
              frames++
              return 'accepted'
            },
            onDisconnect(fn: () => void) {
              onDisconnect = fn
            },
            close() {
              onDisconnect?.()
            },
          },
        },
      )
      await expect.poll(() => frames, { timeout: 10_000 }).toBeGreaterThan(0)
      expect(shownPage).toBe(opened.pageId)
      let observation = await runtime.act(session, { action: 'inspect', pageId: opened.pageId })
      const input = observation.elements.find((element: { label: string }) => element.label === 'Name')
      await runtime.act(session, {
        action: 'fill',
        pageId: opened.pageId,
        pageEpoch: observation.pageEpoch,
        ref: input.ref,
        text: 'AGH 同页测试',
      })
      observation = await runtime.act(session, { action: 'inspect', pageId: opened.pageId })
      const button = observation.elements.find((element: { label: string }) => element.label === 'Confirm')
      await runtime.act(session, {
        action: 'click',
        pageId: opened.pageId,
        pageEpoch: observation.pageEpoch,
        ref: button.ref,
      })
      expect(await page.locator('#result').innerText()).toBe('AGH 同页测试')
      // A same-document URL change must also deliver pixels bearing the current target epoch.
      await page.evaluate(() => history.pushState({}, '', '#same-document'))
      await expect.poll(() => shownEpoch, { timeout: 10_000 }).toBe(runtime.get(session, opened.pageId).epoch)
      const actor = { id: 'synthetic-user' }
      const control = await runtime.control(session, { pageId: opened.pageId, mode: 'human' }, actor)
      const box = await page.locator('input').boundingBox()
      await runtime.humanInput(
        session,
        { ...control, seq: 1, type: 'click', x: box.x + 10, y: box.y + 10 },
        actor,
      )
      await runtime.humanInput(session, { ...control, seq: 2, type: 'key', key: 'ControlOrMeta+A' }, actor)
      await runtime.humanInput(session, { ...control, seq: 3, type: 'text', text: '人工接管' }, actor)
      expect(await page.locator('input').inputValue()).toBe('人工接管')
      expect(runtime.get(session, opened.pageId).page).toBe(page)
      await runtime.humanInput(session, { ...control, seq: 4, type: 'scroll', x: 0, y: 900 }, actor)
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(900)
      await expect
        .poll(
          async () => {
            if (!latestPixels) return undefined
            return page.evaluate(async (encoded: string) => {
              const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
              const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
              try {
                const canvas = document.createElement('canvas')
                canvas.width = bitmap.width
                canvas.height = bitmap.height
                const context = canvas.getContext('2d')!
                context.drawImage(bitmap, 0, 0)
                const pixel = [...context.getImageData(100, 100, 1, 1).data]
                return {
                  width: bitmap.width,
                  height: bitmap.height,
                  green: pixel[1]! > 120 && pixel[0]! < 10 && pixel[2]! < 10,
                }
              } finally {
                bitmap.close()
              }
            }, latestPixels.toString('base64'))
          },
          { timeout: 10_000 },
        )
        .toEqual({ width: 2560, height: 1600, green: true })
      const second = { key: 'other-session', lane: 'main' }
      const other = await runtime.act(second, { action: 'open', url })
      expect(await runtime.get(second, other.pageId).page.locator('#identity').innerText()).not.toBe(
        await page.locator('#identity').innerText(),
      )
      await expect(runtime.act(second, { action: 'screenshot', pageId: opened.pageId })).rejects.toBeDefined()
      const screenshot = await runtime.act(session, { action: 'screenshot', pageId: opened.pageId })
      expect(Buffer.from(screenshot.bytes).subarray(0, 4)).toEqual(Buffer.from([137, 80, 78, 71]))
      expect([
        Buffer.from(screenshot.bytes).readUInt32BE(16),
        Buffer.from(screenshot.bytes).readUInt32BE(20),
      ]).toEqual([1280, 800])
      await runtime.close()
      expect(instance?.isConnected()).toBe(false)
      await expect(
        runtime.humanInput(session, { ...control, seq: 5, type: 'key', key: 'Enter' }, actor),
      ).rejects.toMatchObject({ code: 'DISABLED' })
      shown.abort()
    } finally {
      launcher.cancel()
      await runtime.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      // cacheRoot is an absolute directory returned by mkdtemp under this test's owned prefix.
      await rm(cacheRoot, { recursive: true, force: true })
    }
  },
  150_000,
)
