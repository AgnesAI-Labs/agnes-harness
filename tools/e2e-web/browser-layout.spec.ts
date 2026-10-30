import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { expect, test } from './fixtures.js'
import { prompt, toolResult } from './sdk.js'
import { preferences, workbenchTab } from './ui.js'

test('browser display fits desktop frames to wide, narrow and short panels without distortion', async ({
  page,
}) => {
  const css = readFileSync(
    new URL('../../packages/package-manager/bundled-plugins/browser/src/browser.css', import.meta.url),
    'utf8',
  )
  for (const [width, height] of [
    [890, 710],
    [1400, 400],
    [400, 900],
  ]) {
    await page.setContent(`<style>${css}</style>
      <div style="display:flex;flex-direction:column;width:${width}px;height:${height}px">
        <div class="agh-browser-screen" data-scale="fit"><canvas width="2560" height="1600"></canvas></div>
      </div>`)
    const canvas = page.locator('canvas')
    const geometry = await canvas.evaluate((element) => {
      const box = element.getBoundingClientRect(),
        parent = element.parentElement!
      return {
        width: box.width,
        height: box.height,
        availableWidth: parent.clientWidth,
        availableHeight: parent.clientHeight,
      }
    })
    expect(geometry.width).toBeGreaterThan(0)
    expect(geometry.width).toBeLessThanOrEqual(geometry.availableWidth)
    expect(geometry.height).toBeLessThanOrEqual(geometry.availableHeight)
    expect(geometry.width / geometry.height).toBeCloseTo(1280 / 800)
    await canvas.evaluate((element) => {
      element.parentElement!.dataset.scale = 'actual'
      element.style.width = '1280px'
    })
    expect(await canvas.boundingBox()).toMatchObject({ width: 1280, height: 800 })
  }
})

test.describe('live browser layout and input', () => {
  const archive = process.env.AGH_BROWSER_TEST_ARCHIVE
  test.skip(
    !archive || !existsSync(archive),
    'Provision the reviewed native archive with AGH_BROWSER_TEST_ARCHIVE.',
  )
  test.describe.configure({ timeout: 480_000 })
  test('drag selection keeps direct keyboard input on the same browser page without stealing editor focus', async ({
    page,
    runtime,
  }) => {
    let state = { value: '', start: 0, end: 0, releases: 0, width: 0, height: 0 }
    const site = createServer((request, response) => {
      if (request.method === 'POST') {
        let body = ''
        request.on('data', (part) => {
          body += part.toString()
        })
        request.on('end', () => {
          state = JSON.parse(body)
          response.end('ok')
        })
        return
      }
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end(`<!doctype html><meta charset="utf-8">
      <style>body{margin:0}input{position:absolute;left:30px;top:80px;width:400px;height:40px;font:20px monospace;padding:0;border:1px solid}</style>
      <input aria-label="Selection input" value="0123456789">
      <script>
        const input=document.querySelector('input');
        let queue=Promise.resolve(),releases=0,pressed=false;
        function report(){const body=JSON.stringify({value:input.value,start:input.selectionStart,end:input.selectionEnd,releases,width:innerWidth,height:innerHeight});queue=queue.then(()=>fetch('/state',{method:'POST',body}));}
        input.addEventListener('input',report);
        document.addEventListener('selectionchange',report);
        document.addEventListener('pointerdown',()=>{pressed=true});
        // Control handover may release an already-up button. Count completed
        // presses only, so a safety release cannot masquerade as the tested drag.
        document.addEventListener('pointerup',()=>{if(pressed){pressed=false;releases++;report()}});
        window.addEventListener('resize',report);
        report();
      </script>`)
    })
    await new Promise<void>((done) => site.listen(0, '127.0.0.1', done))
    const address = site.address()
    if (!address || typeof address === 'string') throw new Error('Missing selection fixture address')
    try {
      const client = await runtime.connect()
      const session = await client.session.new({
        sessionKey: randomUUID(),
        cwd: runtime.workspace,
        preset: 'standard',
        permission: 'full-access',
      })
      await prompt(session, 'call tool_describe {"name":"browser"}')
      await prompt(
        session,
        'call browser ' + JSON.stringify({ action: 'open', url: `http://127.0.0.1:${address.port}` }),
      )
      await toolResult(session, 'browser')
      await preferences(page)
      const skip = page.getByTestId('first-run-skip')
      await page.addLocatorHandler(skip, () => skip.click(), { times: 1 })
      await page.goto(runtime.url + '/?session=' + session.id)
      await page.locator('#prompt').waitFor({ timeout: 60_000 })
      await workbenchTab(page, 'browser')
      await expect(page.locator('.agh-browser-screen [data-connected="true"]')).toHaveCount(1)
      const canvas = page.locator('.agh-browser-screen canvas')
      const typing = page.getByRole('textbox', { name: 'Type into the web page', exact: true })
      // Default opening and subsequent resizes must use the whole panel, not
      // merely shrink a fixed desktop frame and leave a large blank area below.
      for (const size of [null, { width: 1600, height: 1000 }, { width: 1280, height: 900 }]) {
        if (size) await page.setViewportSize(size)
        await expect(async () => {
          const geometry = await canvas.evaluate((element) => ({
            width: element.getBoundingClientRect().width,
            height: element.getBoundingClientRect().height,
            availableWidth: element.parentElement!.clientWidth,
            availableHeight: element.parentElement!.clientHeight,
          }))
          expect(state.width).toBe(geometry.availableWidth)
          expect(state.height).toBe(geometry.availableHeight)
          expect(Math.abs(geometry.width - geometry.availableWidth)).toBeLessThanOrEqual(1)
          expect(Math.abs(geometry.height - geometry.availableHeight)).toBeLessThanOrEqual(1)
        }).toPass({ timeout: 10_000 })
      }
      await page
        .locator('.agh-browser-panel')
        .screenshot({ path: test.info().outputPath('adaptive-panel.png') })
      const point = async (x: number, y = 100) => {
        const box = await canvas.boundingBox()
        if (!box) throw new Error('Missing browser canvas')
        return { x: box.x + (x * box.width) / state.width, y: box.y + (y * box.height) / state.height }
      }
      const drag = async () => {
        const from = await point(55),
          to = await point(105)
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        await page.mouse.move(to.x, to.y, { steps: 6 })
        await page.mouse.up()
      }
      // First contact is a drag, including native control admission. Do not focus
      // the hidden input or use locator.fill: the user's keyboard must work itself.
      await drag()
      await expect(typing).toBeFocused()
      await expect.poll(() => state.releases).toBe(1)
      await expect.poll(() => state.end - state.start).toBeGreaterThan(0)
      expect(state.end - state.start).toBeLessThan(state.value.length)
      const replacement = state.value.slice(0, state.start) + 'X' + state.value.slice(state.end)
      await page.keyboard.type('X')
      await expect.poll(() => state.value).toBe(replacement)

      const reset = async () => {
        const at = await point(80)
        await page.mouse.click(at.x, at.y)
        await page.keyboard.press('ControlOrMeta+A')
        await page.keyboard.type('0123456789')
        await expect.poll(() => state.value).toBe('0123456789')
      }
      await reset()
      await drag()
      // Type immediately after mouseup: the existing queue must place text after
      // release, even if the final selection frame has not reached the workbench.
      await page.keyboard.type('FAST')
      await expect.poll(() => state.value.includes('FAST')).toBe(true)
      expect(state.value.startsWith('0')).toBe(true)
      expect(state.value.endsWith('9')).toBe(true)

      await reset()
      const releases = state.releases
      await drag()
      await expect.poll(() => state.releases).toBe(releases + 1)
      await expect.poll(() => state.end - state.start).toBeGreaterThan(0)
      const unicode = state.value.slice(0, state.start) + '中文' + state.value.slice(state.end)
      await page.keyboard.insertText('中文')
      await expect.poll(() => state.value).toBe(unicode)

      // A different editor taking focus during a drag must keep that focus after
      // the captured release; typing there must not alter the remote selection.
      const from = await point(55),
        to = await point(105)
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 6 })
      const composer = page.locator('#prompt')
      await composer.focus()
      await page.mouse.up()
      await expect(composer).toBeFocused()
      await page.keyboard.type('local-editor-only')
      await expect(composer).toHaveValue('local-editor-only')
      expect(state.value).toBe(unicode)
    } finally {
      site.closeAllConnections()
      await new Promise<void>((done) => site.close(() => done()))
    }
  })
})
