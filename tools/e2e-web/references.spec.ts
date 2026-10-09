import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures.js'
import { chooseWorkspace, fresh, preferences, turn } from './ui.js'

test('selects file and session references, records send-time versions and links the source', async ({
  page,
  runtime,
}) => {
  await preferences(page)
  await writeFile(join(runtime.workspace, 'reference.txt'), 'old file contents')
  await writeFile(join(runtime.workspace, '.gitignore'), 'reference-secret.txt\n')
  await writeFile(join(runtime.workspace, 'reference-secret.txt'), 'must not be offered')
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime)
  await fresh(page)
  await turn(page, 'Reference source needle: compare the release notes.')
  const sourceId = new URL(page.url()).searchParams.get('session')!
  await fresh(page)
  const composer = page.locator('#prompt')
  await composer.fill('@file reference')
  await expect(composer).toHaveAttribute('role', 'combobox')
  await expect(page.getByTestId('reference-option')).toHaveCount(1)
  await expect(page.getByTestId('reference-option')).toContainText('reference.txt')
  await expect(composer).toHaveAttribute('aria-expanded', 'true')
  await composer.press('ArrowDown')
  await expect(page.getByTestId('reference-option')).toHaveAttribute('aria-selected', 'true')
  await composer.press('Enter')
  await expect(page.getByTestId('reference-draft-chips')).toContainText('reference.txt')
  await expect(composer).toHaveValue('')
  await composer.fill('@session needle')
  const sourceOption = page.getByTestId('reference-option').first()
  await expect(sourceOption).toBeVisible()
  await composer.press('Tab')
  await expect(page.getByTestId('reference-draft-chips').locator('li')).toHaveCount(2)
  await writeFile(join(runtime.workspace, 'reference.txt'), 'new send-time file contents')
  await composer.fill('Compare these references.')
  await composer.press('Enter')
  await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-status', 'completed', {
    timeout: 30_000,
  })
  await expect(page.getByTestId('reference-sent-chips').last().locator('li')).toHaveCount(2)
  await expect(page.getByTestId('reference-session-link').last()).toHaveAttribute(
    'href',
    `?session=${sourceId}`,
  )
  const targetId = new URL(page.url()).searchParams.get('session')!
  const client = await runtime.connect()
  const session = await client.session.load(targetId, { cwd: runtime.workspace })
  const [message] = await session.scan({ type: 'user/message', order: 'desc', limit: 1 })
  const serialized = JSON.stringify(message)
  expect(serialized).toContain(createHash('sha256').update('new send-time file contents').digest('hex'))
  expect(serialized).toContain('new send-time file contents')
  expect(serialized).not.toContain('old file contents')
  expect(serialized).toContain('UNTRUSTED REFERENCE')
  await page.reload()
  await expect(page.getByTestId('reference-session-link').last()).toHaveAttribute(
    'href',
    `?session=${sourceId}`,
  )
  await page.getByTestId('reference-session-link').last().click()
  await expect(page).toHaveURL(new RegExp(`session=${sourceId}`))
})
