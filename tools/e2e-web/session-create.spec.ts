import { expect, test } from './fixtures.js'
import { openWorkspace } from './ui.js'

test('A session that takes longer than 30 s to create still opens and sends', async ({ page, runtime }) => {
  test.setTimeout(180_000)
  let slowed = false
  await page.routeWebSocket(/.*/, (ws) => {
    const server = ws.connectToServer()
    const held = new Set<number | string>()
    ws.onMessage((message) => {
      try {
        const frame = JSON.parse(String(message)) as { id?: number | string; method?: string }
        // The first creation answers late, the way a loaded daemon assembling its host would.
        if (!slowed && frame.method === 'session/new' && frame.id !== undefined) {
          slowed = true
          held.add(frame.id)
        }
      } catch {
        /* Not JSON-RPC. */
      }
      server.send(message)
    })
    server.onMessage((message) => {
      try {
        const frame = JSON.parse(String(message)) as { id?: number | string }
        if (frame.id !== undefined && held.has(frame.id)) {
          held.delete(frame.id)
          setTimeout(() => ws.send(message), 40_000)
          return
        }
      } catch {
        /* Not JSON-RPC. */
      }
      ws.send(message)
    })
  })
  await openWorkspace(page, runtime)
  const composer = page.getByRole('textbox', { name: 'Task content', exact: true })
  await composer.fill('请生成一个扫雷游戏的 HTML')
  await composer.press('Enter')
  await expect(page.locator('#composer')).toContainText('Preparing session')
  // Past the old 30 s budget the request is still pending, not failed.
  await page.waitForTimeout(32_000)
  await expect(page.getByText('timed out')).toHaveCount(0)
  await expect(page.getByTestId('conversation-turn').first()).toContainText('扫雷', { timeout: 30_000 })
  await expect(page.locator('.session-row')).toHaveCount(1)
})
