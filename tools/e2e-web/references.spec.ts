import { realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { UserMessage } from '@agnes/protocol'
import { expect, test } from './fixtures.js'
import { readSessionEvents } from './ledger.js'
import { toolResult } from './sdk.js'
import { chooseWorkspace, fresh, preferences, turn } from './ui.js'

test('selects workspace file chips and versioned session references and links the source', async ({
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
  await expect(page.getByTestId('composer-file-mention')).toContainText('reference.txt')
  await expect(composer).toHaveValue('@reference.txt ')
  await composer.press('End')
  await composer.pressSequentially('@session needle')
  const sourceOption = page.getByTestId('reference-option').first()
  await expect(sourceOption).toBeVisible()
  await composer.press('Tab')
  await expect(page.getByTestId('reference-draft-chips').locator('li')).toHaveCount(1)
  await writeFile(join(runtime.workspace, 'reference.txt'), 'new send-time file contents')
  // Continue typing after the chosen file chip; replacing the entire input would remove it.
  await expect(composer).toHaveValue('@reference.txt ')
  await composer.press('End')
  await composer.pressSequentially('Compare these references.')
  await expect(page.getByTestId('composer-file-mention')).toContainText('reference.txt')
  await expect(page.getByTestId('reference-option')).toHaveCount(0)
  await expect(page.locator('#send')).toBeEnabled()
  await composer.press('Enter')
  await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-status', 'completed', {
    timeout: 30_000,
  })
  await expect(page.locator('[data-testid=reference-sent-chips]:visible').locator('li')).toHaveCount(1)
  await expect(page.locator('[data-testid=reference-session-link]:visible')).toHaveAttribute(
    'href',
    `?session=${sourceId}`,
  )
  const targetId = new URL(page.url()).searchParams.get('session')!
  const client = await runtime.connect()
  const session = await client.session.load(targetId, { cwd: runtime.workspace })
  const messages = (await readSessionEvents(session))
    .filter((row) => row.type === 'user/message')
    .slice(0, 100)
  const referenceMessages = messages.filter((row) =>
    (row.data as UserMessage).content.some((block) => block.type === 'text' && block.reference !== undefined),
  )
  expect(referenceMessages).toHaveLength(1)
  const message = referenceMessages[0]
  expect(message).toMatchObject({ origin: 'system', trust: 'untrusted' })
  expect(messages.find((row) => row.origin === 'principal')).toMatchObject({
    trust: 'trusted',
    data: {
      content: [
        { type: 'text', text: '@reference.txt Compare these references.' },
        {
          type: 'resource_link',
          uri: pathToFileURL(await realpath(join(runtime.workspace, 'reference.txt'))).href,
          name: 'reference.txt',
        },
      ],
    },
  })
  const serialized = JSON.stringify(message)
  // Session references are versioned untrusted context; file chips remain explicit workspace links.
  expect(serialized).toContain('Reference source needle: compare the release notes.')
  expect(serialized).not.toContain('new send-time file contents')
  expect(serialized).not.toContain('old file contents')
  expect(serialized).toContain('UNTRUSTED REFERENCE')
  await turn(page, 'call read {"path":"reference.txt"}')
  expect(JSON.stringify((await toolResult(session, 'read'))?.content)).toContain(
    'new send-time file contents',
  )
  await page.reload()
  await expect(page.locator('[data-testid=reference-session-link]:visible')).toHaveAttribute(
    'href',
    `?session=${sourceId}`,
  )
  await expect(page.locator('[data-testid=reference-session-link]:visible')).toBeVisible()
  await page.locator('[data-testid=reference-session-link]:visible').click()
  await expect(page).toHaveURL(new RegExp(`session=${sourceId}`))
})
