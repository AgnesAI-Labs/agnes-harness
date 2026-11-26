import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { buildPdfPreview } from '../../../tools/pdf-preview-build.mjs'
import { createWebServer } from '../src/server.js'
import { twoPages } from './pdf-fixture.js'

for (const cloud of [false, true])
  for (const locale of ['en', 'zh-CN']) {
    test(`offline PDF pages survive ${cloud ? 'cloud' : 'local'} isolation (${locale})`, async ({
      page,
    }, info) => {
      const pageErrors: string[] = []
      page.on('pageerror', (error) => pageErrors.push(error.message))
      const root = await mkdtemp(join(tmpdir(), 'agh-pdf-viewer-'))
      const reservation = createServer()
      await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
      const address = reservation.address()
      if (!address || typeof address === 'string') throw Error('missing port')
      await new Promise<void>((resolve) => reservation.close(() => resolve()))
      await writeFile(
        join(root, 'index.html'),
        '<!doctype html><meta id="agnes-config"><meta content="__AGNES_CSP_NONCE__"><meta name="ws" content="__AGNES_WS_URL__"><script src="/app.js"></script>',
      )
      await buildPdfPreview(root)
      const pdf = process.env.AGH_PDF_PREVIEW_FIXTURE
        ? await readFile(process.env.AGH_PDF_PREVIEW_FIXTURE)
        : twoPages()
      const previous = locale === 'zh-CN' ? '上一页' : 'Previous page',
        next = locale === 'zh-CN' ? '下一页' : 'Next page'
      await writeFile(
        join(root, 'app.js'),
        `
      addEventListener('DOMContentLoaded', () => {
        if (${cloud} && !new URLSearchParams(location.search).has('child')) {
          const outer=document.createElement('iframe');outer.id='cloud';outer.width='1000';outer.height='850';
          outer.sandbox='allow-scripts allow-same-origin allow-forms allow-downloads allow-popups';
          outer.src=document.querySelector('#agnes-config').dataset.cloudOrigin+'/?remote=https%3A%2F%2Ffixture.example&child=1';
          document.body.append(outer);return;
        }
        const frame=document.createElement('iframe');frame.id='pdf';frame.width='900';frame.height='800';frame.sandbox='allow-scripts';
        window.sendPdf = base64 => frame.contentWindow.postMessage({type:'agnes-pdf-data',base64,title:'PDF preview',previous:${JSON.stringify(previous)},next:${JSON.stringify(next)},failure:'PDF_FAILED'},'*');
        addEventListener('message', event => {
          if(event.source!==frame.contentWindow)return;
          if(event.data?.type==='agnes-pdf-ready')window.sendPdf(frame.dataset.bad ? btoa('%PDF-1.4 not a document') : ${JSON.stringify(pdf.toString('base64'))});
          else document.body.dataset.pdfState=event.data?.type;
        });
        frame.src='/__agnes/pdf-preview';document.body.append(frame);
      });`,
      )
      const web = await createWebServer({ root, port: address.port, wsUrl: 'ws://127.0.0.1:4312' })
      try {
        await page.goto(web.url)
        const host = cloud ? page.frameLocator('#cloud') : page
        const viewer = host.frameLocator('#pdf')
        await expect(viewer.locator('canvas')).toHaveJSProperty(
          'width',
          process.env.AGH_PDF_PREVIEW_FIXTURE ? 1190 : 600,
        )
        await expect(viewer.locator('#page')).toHaveText(
          process.env.AGH_PDF_PREVIEW_FIXTURE ? '1 / 1' : '1 / 2',
        )
        await expect(viewer.getByRole('button', { name: previous })).toBeDisabled()
        const first = await viewer.locator('canvas').screenshot()
        if (process.env.AGH_PDF_PREVIEW_FIXTURE) {
          const titleInk = await viewer.locator('canvas').evaluate((element) => {
            const canvas = element as HTMLCanvasElement
            const rgba = canvas.getContext('2d')?.getImageData(100, 50, 400, 100).data
            if (!rgba) return 0
            let ink = 0
            for (let i = 0; i < rgba.length; i += 4)
              if (
                (rgba[i] ?? 255) < 180 &&
                (rgba[i + 1] ?? 255) < 180 &&
                (rgba[i + 2] ?? 255) < 180 &&
                (rgba[i + 3] ?? 0) > 0
              )
                ink++
            return ink
          })
          expect(titleInk).toBeGreaterThan(200)
        }
        if (!process.env.AGH_PDF_PREVIEW_FIXTURE) {
          await viewer.getByRole('button', { name: next }).click()
          await expect(viewer.locator('#page')).toHaveText('2 / 2')
          expect((await viewer.locator('canvas').screenshot()).equals(first)).toBe(false)
          await expect(viewer.getByRole('button', { name: next })).toBeDisabled()
          await viewer.getByRole('button', { name: previous }).click()
          await expect(viewer.locator('#page')).toHaveText('1 / 2')
        }
        await info.attach('pdf-page.png', { body: first, contentType: 'image/png' })
        if (process.env.AGH_PDF_PREVIEW_FIXTURE && process.env.AGH_WEB_TEST_OUTPUT)
          await writeFile(
            join(process.env.AGH_WEB_TEST_OUTPUT, `real-pdf-${cloud ? 'cloud' : 'local'}-${locale}.png`),
            first,
          )
        expect(await viewer.locator('iframe,object,embed').count()).toBe(0)
        expect(
          await viewer.locator('html').evaluate(() => {
            try {
              return parent.document.title
            } catch {
              return 'isolated'
            }
          }),
        ).toBe('isolated')
        await host.locator('#pdf').evaluate((frame) => {
          frame.setAttribute('data-bad', '1')
          frame.setAttribute('src', '/__agnes/pdf-preview?invalid=1')
        })
        await expect(viewer.getByRole('alert')).toHaveText('PDF_FAILED')
        await expect(viewer.locator('canvas')).toBeHidden()
        await host.locator('#pdf').evaluate((frame) => {
          frame.removeAttribute('data-bad')
          frame.setAttribute('src', '/__agnes/pdf-preview?reopen=1')
        })
        await expect(viewer.locator('#page')).toHaveText(
          process.env.AGH_PDF_PREVIEW_FIXTURE ? '1 / 1' : '1 / 2',
        )
        await expect(viewer.getByRole('alert')).toBeHidden()
        expect(pageErrors).toEqual([])
      } finally {
        await web.close()
        await rm(root, { recursive: true, force: true })
      }
    })
  }
