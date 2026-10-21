import { createReadStream, existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'

const { BrowserRuntime } = await import(
  new URL('../bundled-plugins/browser/src/runtime.mjs', import.meta.url).href
)
const { createLauncher } = await import(
  new URL('../bundled-plugins/browser/src/launcher.mjs', import.meta.url).href
)
const { showPage } = await import(new URL('../bundled-plugins/browser/src/streams.mjs', import.meta.url).href)
const archive = process.env.AGH_BROWSER_TEST_ARCHIVE

it.skipIf(!archive || !existsSync(archive))(
  'installs the pinned archive and shares a real Chromium page across tools, frames and human input',
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
    const launcher = createLauncher({
      cacheRoot,
      fetchArchive: async () => ({ ok: true, body: createReadStream(archive!) }),
    })
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
      launcher.prepare(runtime)
      await expect(runtime.act(session, { action: 'open', url })).rejects.toMatchObject({ code: 'PREPARING' })
      expect(runtime.status()).toMatchObject({ enabled: true, state: 'preparing', error: null })
      const deadline = Date.now() + 120_000
      while (runtime.status().state === 'preparing' && Date.now() < deadline) await delay(100)
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
              expect(frame.subarray(size + 4, size + 6)).toEqual(Buffer.from([0xff, 0xd8]))
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
