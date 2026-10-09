import { createServer } from 'node:http'
import { expect, type Page } from '@playwright/test'
import { settled } from './quality.js'

/** Read-only DOM frames from the production shell, captured by the two real first-run flows.
 * No daemon, worker, provider or copied UI implementation is used when replaying a frame.
 */
export async function firstRunSnapshots() {
  const frames = new Map<string, string>()
  const assets = new Map<string, { body: Buffer; type: string }>()
  const reads = new Set<Promise<void>>()
  const server = createServer((request, response) => {
    const path = request.url ?? '/'
    const frame = frames.get(path)
    if (frame) {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end(frame)
      return
    }
    const asset = assets.get(path)
    if (asset) {
      response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' }).end(asset.body)
      return
    }
    response.writeHead(404).end('First-run snapshot asset unavailable')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing snapshot fixture address')
  const url = `http://127.0.0.1:${address.port}`
  const framePath = (name: string, theme: string, width: number) => `/frames/${name}-${theme}-${width}`
  const theme = async (page: Page, value: string) => {
    await page.evaluate((value) => {
      localStorage.setItem('agnes-theme', value)
      window.dispatchEvent(new CustomEvent('agnes:theme-changed'))
    }, value)
    await expect
      .poll(() => page.locator('html').evaluate((root) => root.classList.contains('dark')))
      .toBe(value === 'dark')
    await settled(page)
  }
  return {
    recordAssets(page: Page) {
      page.on('response', (response) => {
        const contentType = response.headers()['content-type'] ?? ''
        if (
          !['stylesheet', 'image', 'font'].includes(response.request().resourceType()) &&
          !/^(image\/|font\/|text\/css)/.test(contentType)
        )
          return
        const read = (async () => {
          const asset = new URL(response.url())
          const path = asset.pathname + asset.search
          if (response.status() === 304 && assets.has(path)) return
          if (!response.ok()) throw new Error(`First-run asset failed: ${response.url()}`)
          assets.set(path, {
            body: await response.body(),
            type: contentType || 'application/octet-stream',
          })
        })()
        reads.add(read)
        // Handle the rejection immediately, and propagate it when capture awaits all reads.
        void read.catch(() => undefined)
      })
    },
    async capture(page: Page, name: string) {
      try {
        for (const appearance of ['light', 'dark']) {
          await theme(page, appearance)
          for (const width of [1440, 1280]) {
            await page.setViewportSize({ width, height: width === 1440 ? 900 : 800 })
            await settled(page)
            await Promise.all(reads)
            const html = await page.evaluate(() => {
              const copy = document.documentElement.cloneNode(true) as HTMLElement
              const originals = [document.documentElement, ...document.documentElement.querySelectorAll('*')]
              const copies = [copy, ...copy.querySelectorAll('*')]
              originals.forEach((element, index) => {
                const target = copies[index]!
                if (element === document.activeElement) {
                  target.setAttribute('data-fixture-focus', '')
                  if (element.matches(':focus-visible')) target.setAttribute('data-fixture-focus-visible', '')
                }
                if (element.matches('dialog:modal')) {
                  target.removeAttribute('open')
                  target.setAttribute('data-fixture-modal', '')
                }
                if (element.scrollTop)
                  target.setAttribute('data-fixture-scroll-top', String(element.scrollTop))
                if (element.scrollLeft)
                  target.setAttribute('data-fixture-scroll-left', String(element.scrollLeft))
                if (element instanceof HTMLInputElement) {
                  target.setAttribute('value', element.value)
                  target.toggleAttribute('checked', element.checked)
                }
                if (element instanceof HTMLTextAreaElement) target.textContent = element.value
                if (element instanceof HTMLOptionElement) target.toggleAttribute('selected', element.selected)
              })
              // Keep production DOM and CSS, but stop all app startup, RPCs and module effects.
              copy.querySelectorAll('script, #agnes-config').forEach((element) => element.remove())
              copy.querySelectorAll('link[href], img[src]').forEach((element) => {
                const attribute = element.tagName === 'LINK' ? 'href' : 'src'
                const asset = new URL(element.getAttribute(attribute)!, location.href)
                if (asset.origin === location.origin)
                  element.setAttribute(attribute, asset.pathname + asset.search)
              })
              return `<!doctype html>${copy.outerHTML}`
            })
            frames.set(framePath(name, appearance, width), html)
          }
        }
      } finally {
        await page.setViewportSize({ width: 1440, height: 900 })
        await theme(page, 'light')
      }
    },
    async show(page: Page, name: string, appearance: string, width: number) {
      const path = framePath(name, appearance, width)
      if (!frames.has(path)) throw new Error(`Real first-run flow did not capture ${path}`)
      await page.goto(url + path)
      // Preserve keyboard/pointer focus styling as well as the active control.
      if (await page.locator('[data-fixture-focus-visible]').count()) await page.keyboard.press('Shift')
      else await page.mouse.click(0, 0)
      await page.evaluate(() => {
        document.querySelectorAll<HTMLDialogElement>('dialog[data-fixture-modal]').forEach((dialog) => {
          dialog.showModal()
        })
        document.querySelectorAll<HTMLElement>('[data-fixture-scroll-top]').forEach((element) => {
          element.scrollTop = Number(element.dataset.fixtureScrollTop)
        })
        document.querySelectorAll<HTMLElement>('[data-fixture-scroll-left]').forEach((element) => {
          element.scrollLeft = Number(element.dataset.fixtureScrollLeft)
        })
        document.querySelector<HTMLElement>('[data-fixture-focus]')?.focus({ preventScroll: true })
      })
      await settled(page)
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
