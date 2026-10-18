// Human-admin acceptance, only for a previously isolated real-eval home.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'
import { realRuntime } from './real-runtime.mjs'

const root = process.argv[2],
  candidateId = process.argv[3]
assert.ok(root && /^candidate-[a-f0-9]{32}$/.test(candidateId ?? ''), 'Pass evaluation root and candidate ID')
const rt = await realRuntime('panel', root)
const evidence = { candidateId, checks: [] }
const itemText = `REAL-EVAL ${randomUUID()}`
evidence.itemText = itemText
let browser, page
try {
  await rt.connect()
  let candidate = await rt.client.request('_agnes/v1/plugins.candidates.show', {
    profile: 'local-dev',
    candidateId,
  })
  if (process.argv.includes('--prepare-review') && !['review', 'published'].includes(candidate.state)) {
    const command = async () => ({
      profile: 'local-dev',
      clientId: await rt.client.clientId(),
      commandId: randomUUID(),
      candidateId,
      expectedHash: candidate.candidateHash,
    })
    candidate = await rt.client.request('_agnes/v1/plugins.candidates.test', await command())
    await rt.save('admin-test.json', candidate)
    assert.equal(candidate.tests?.state, 'passed', candidate.tests?.output)
    candidate = await rt.client.request('_agnes/v1/plugins.candidates.submit', await command())
    await rt.save('admin-submit.json', candidate)
    evidence.checks.push('admin-test-and-submit')
  }
  assert.ok(['review', 'published'].includes(candidate.state), 'Only a submitted candidate may be approved')
  assert.equal(candidate.tests?.state, 'passed')
  assert.equal(candidate.tests.hash, candidate.candidateHash)
  assert.ok(candidate.tests.count > 0)
  evidence.candidateHash = candidate.candidateHash
  evidence.reviewHash = candidate.reviewHash
  if (candidate.state === 'review')
    evidence.publication = await rt.client.request('_agnes/v1/plugins.candidates.approve', {
      profile: 'local-dev',
      clientId: await rt.client.clientId(),
      commandId: randomUUID(),
      candidateId,
      expectedHash: candidate.candidateHash,
      reviewHash: candidate.reviewHash,
    })
  const inventory = await rt.client.packages.list({ profile: 'local-dev' })
  const installed = inventory.packages.find((row) => row.id === candidate.packageId)
  assert.equal(installed?.actual, 'running')
  assert.ok(candidate.preview?.integrity, 'Missing reviewed package integrity')
  assert.equal(installed.actualIntegrity, candidate.preview.integrity)
  await rt.startWeb()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(rt.url)
  await page.screenshot({ path: join(root, 'panel-home.png'), fullPage: true })
  // Generated candidates can rename their page. The human reviewer supplies selectors after source review.
  const plan = JSON.parse(await readFile(join(root, 'panel-plan.json'), 'utf8'))
  async function open() {
    await page.goto(`${rt.url}${plan.path ?? '/'}`)
    if (plan.openText) await page.getByRole('button', { name: plan.openText, exact: true }).click()
    await page.getByRole('heading', { name: plan.heading, exact: true }).waitFor()
  }
  await open()
  await page.getByRole('textbox', { name: plan.input }).fill(itemText)
  if (plan.fields)
    for (const [name, value] of Object.entries(plan.fields))
      await page.getByLabel(name, { exact: true }).fill(value)
  await page.getByRole('button', { name: plan.add, exact: true }).click()
  await page.getByText(itemText, { exact: true }).waitFor()
  evidence.checks.push('add')
  if (plan.toggle) {
    const checkbox = page.getByRole('checkbox', { name: itemText })
    await checkbox.click()
    await expect(checkbox).toBeChecked()
    await expect(checkbox).toBeEnabled()
    evidence.checks.push('toggle')
  }
  await page.screenshot({ path: join(root, 'panel-added.png'), fullPage: true })
  await page.reload()
  if (plan.openText && !(await page.getByRole('heading', { name: plan.heading, exact: true }).count()))
    await page.getByRole('button', { name: plan.openText, exact: true }).click()
  await page.getByText(itemText, { exact: true }).waitFor()
  evidence.checks.push('reopen')
  await rt.restart()
  await rt.startWeb()
  await open()
  await page.getByText(itemText, { exact: true }).waitFor()
  if (plan.toggle) await expect(page.getByRole('checkbox', { name: itemText })).toBeChecked()
  evidence.checks.push('restart-persist')
  if (plan.remove) {
    await page
      .getByRole('listitem')
      .filter({ hasText: itemText })
      .getByRole('button', { name: plan.remove })
      .click()
    if (plan.confirmRemove)
      await page.getByRole('dialog').getByRole('button', { name: plan.confirmRemove, exact: true }).click()
    await page.getByText(itemText, { exact: true }).waitFor({ state: 'detached' })
    evidence.checks.push('delete')
  }
  await page.screenshot({ path: join(root, 'panel-after-restart.png'), fullPage: true })
  evidence.browserErrors = errors
  evidence.packages = await rt.client.packages.list({ profile: 'local-dev' })
  assert.deepEqual(errors, [])
  evidence.passed = true
} catch (error) {
  evidence.error = rt.redact(error.message)
  evidence.passed = false
  if (page) {
    await page.screenshot({ path: join(root, 'panel-failed.png'), fullPage: true }).catch(() => {})
    evidence.pageText = await page
      .locator('body')
      .innerText()
      .catch(() => '')
  }
  process.exitCode = 1
} finally {
  await rt.save(`panel-evidence-${Date.now()}.json`, evidence)
  await rt.save('panel-evidence.json', evidence)
  await browser?.close()
  await rt.dispose()
  console.log(JSON.stringify({ root, ...evidence, packages: undefined, publication: undefined }))
}
