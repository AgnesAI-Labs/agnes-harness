import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

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
