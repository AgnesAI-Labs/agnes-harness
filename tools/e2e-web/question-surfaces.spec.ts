import { type ChildProcess, spawn } from 'node:child_process'
import { expect, type Page, test } from '@playwright/test'

let fixture: ChildProcess, url: string
test.beforeAll(async () => {
  fixture = spawn(
    process.execPath,
    ['tools/e2e-web/serve-intelligent-ui-fixture.mjs', 'tools/e2e-web/fixtures/question-surfaces.tsx'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  url = await new Promise((resolve, reject) => {
    let output = '',
      errors = ''
    fixture.stdout?.on('data', (chunk) => {
      output += String(chunk)
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/)
      if (match) resolve(match[0])
    })
    fixture.stderr?.on('data', (chunk) => {
      errors += String(chunk)
    })
    fixture.once('error', reject)
    fixture.once('exit', (code) => reject(new Error(`${code}: ${errors}`)))
  })
})
test.afterAll(async () => {
  if (!fixture || fixture.exitCode !== null) return
  await new Promise<void>((resolve) => {
    fixture.once('exit', () => resolve())
    fixture.kill('SIGTERM')
  })
})
/** Questions now live above the composer; their card is the submission confirmation. */
async function answer(page: Page, single: 'A' | 'B', multi: string[], text: string) {
  const card = page.getByTestId('question-card')
  await card.getByTestId('question-step-0').click()
  await card.getByTestId(`question-option-single-${single === 'A' ? 0 : 1}`).check()
  await card.getByTestId('question-next').click()
  for (const [index, option] of ['A', 'B'].entries())
    await card.getByTestId(`question-option-multi-${index}`).setChecked(multi.includes(option))
  await card
    .getByTestId('question-other-multi')
    .fill(multi.find((value) => !['A', 'B'].includes(value)) ?? '')
  await card.getByTestId('question-next').click()
  await card.getByTestId('question-text-text').fill(text)
  return card
}
for (const locale of ['en', 'zh-CN'])
  test(`question forms share choices, recover receipts and preserve answers (${locale})`, async ({
    page,
  }) => {
    await page.goto(`${url}/?locale=${locale}`)
    const card = await answer(page, 'B', ['A', 'B', 'C'], 'Human answer')
    await expect(page.getByTestId('intelligent-ui-panel')).toBeHidden()
    // Folding and moving among steps keeps the same draft, without a second workbench form.
    await card.getByTestId('question-toggle').click()
    await expect(card.getByTestId('question-text-text')).toBeHidden()
    await card.getByTestId('question-toggle').click()
    await card.getByTestId('question-step-0').click()
    await expect(card.getByTestId('question-option-single-1')).toBeChecked()
    await card.getByTestId('question-step-1').click()
    await expect(card.getByTestId('question-option-multi-1')).toBeChecked()
    await expect(card.getByTestId('question-other-multi')).toHaveValue('C')
    await card.getByTestId('question-step-2').click()
    await expect(card.getByTestId('question-text-text')).toHaveValue('Human answer')
    await card.getByTestId('question-submit').click()
    await expect(card.getByTestId('question-submit')).toBeDisabled()
    await expect(page.getByTestId('fixture-requests')).toContainText(
      '"answers":{"single":"B","multi":["A","B","C"],"text":"Human answer"}',
    )
    await expect
      .poll(async () => JSON.parse(await page.getByTestId('fixture-requests').innerText()).length)
      .toBe(1)
    await page.reload()
    await expect(card.getByTestId('question-option-single-1')).toBeChecked()
    await card.getByTestId('question-step-2').click()
    await expect(card.getByTestId('question-submit')).toBeDisabled()
    await expect
      .poll(async () => JSON.parse(await page.getByTestId('fixture-requests').innerText()).length)
      .toBe(1)
    await page.getByTestId('fixture-complete').click()
    await expect(card).toBeHidden()
    await expect(page.getByTestId('question-answers')).toContainText('Human answer')
    await expect(page.getByTestId('question-answers')).toContainText('B')
  })
test('question submission rejects a stale revision and an ordinary policy refusal', async ({ page }) => {
  await page.goto(url)
  const card = await answer(page, 'A', ['A'], 'Answer')
  await page.getByTestId('fixture-change').click()
  await card.getByTestId('question-submit').click()
  await expect(card.getByTestId('question-recovery')).toHaveText(
    'This question changed or closed. Reload it before answering.',
  )
  await card.getByTestId('question-recover').click()
  await answer(page, 'A', ['A'], 'Reviewed answer')
  await page.getByTestId('fixture-deny').click()
  await card.getByTestId('question-submit').click()
  await expect(card.getByRole('alert')).toHaveText('Denied')
  await expect(card.getByTestId('question-submit')).toBeEnabled()
  const requests = JSON.parse(await page.getByTestId('fixture-requests').innerText())
  expect(requests.map((request: { revision: number }) => request.revision)).toEqual([1, 2])
  expect(requests[1].input.answers.text).toBe('Reviewed answer')
})
