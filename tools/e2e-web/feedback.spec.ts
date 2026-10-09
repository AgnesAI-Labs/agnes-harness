import { startProviderFixture } from '../acceptance/provider-fixture.js'
import { expect, test } from './fixtures.js'
import { accessible, translated } from './quality.js'
import { chooseWorkspace, fresh, preferences, section, settings, turn } from './ui.js'

test('message feedback drafts a Skill with a scripted local model and publishes only after review', async ({
  page,
  runtime,
}, info) => {
  test.setTimeout(240_000)
  const client = await runtime.connect()
  const model = 'deepseek-v4-flash'
  const fixture = await startProviderFixture(
    JSON.stringify({
      name: 'review-evidence',
      description: 'Use when reporting observations',
      body: 'Cite observed evidence before drawing conclusions. Ask for missing evidence.',
    }),
    undefined,
    model,
  )
  try {
    const config = await client.config.get()
    await client.config.save({
      providerId: 'deepseek',
      baseUrl: fixture.baseUrl,
      apiKey: fixture.apiKey,
      model,
      accountId: 'feedback-fixture',
      label: 'Local scripted feedback model',
      expectedRevision: config.revision,
      makeDefault: true,
    })
    await preferences(page, 'en', 'light')
    await page.goto(runtime.url)
    await chooseWorkspace(page, runtime)
    await fresh(page)
    await turn(page, 'Summarize the observed evidence')
    const sessionId = new URL(page.url()).searchParams.get('session')
    if (!sessionId) throw new Error('Missing session')
    const feedback = page.getByTestId('message-feedback').last()
    await expect(feedback.getByTestId('feedback-down')).toBeEnabled()
    await feedback.getByTestId('feedback-down').click()
    await expect(feedback.getByTestId('feedback-down')).toHaveAttribute('aria-pressed', 'true')
    await feedback.getByTestId('feedback-category').selectOption('accuracy')
    await feedback.getByTestId('feedback-note').fill('Cite observed evidence and state uncertainty.')
    await feedback.getByTestId('feedback-save').click()
    await expect(feedback.getByTestId('feedback-generate')).toBeEnabled()
    await feedback.getByTestId('feedback-generate').click()
    await expect(feedback).toContainText('Draft saved.', { timeout: 40_000 })
    const facts = await client.request('_agnes/v1/admin.feedback', { action: 'list', sessionId })
    expect(facts.items[0]).toMatchObject({ rating: 'down', category: 'accuracy', withdrawn: false })
    const candidateId = facts.growth[0]?.candidateId
    if (!candidateId) throw new Error('Missing candidate')
    const candidate = await client.request('_agnes/v1/plugins.candidates.show', {
      profile: 'local-dev',
      candidateId,
    })
    expect(candidate).toMatchObject({
      state: 'draft',
      origin: { feedbackId: facts.items[0]!.id, feedbackRevision: facts.items[0]!.revision },
    })
    expect(
      (await client.packages.list({ profile: 'local-dev' })).packages.some(
        (item) => item.id === candidate.packageId,
      ),
    ).toBe(false)
    await settings(page)
    await section(page, 'plugins')
    await page.getByTestId('candidate-open').filter({ hasText: candidate.packageId }).click()
    await page.getByTestId('candidate-test').click()
    await page.getByRole('dialog').getByRole('button', { name: 'Run tests', exact: true }).click()
    await expect(page.getByTestId('candidate-submit')).toBeEnabled({ timeout: 30_000 })
    await page.getByTestId('candidate-submit').click()
    await expect(page.getByTestId('candidate-approve')).toBeEnabled()
    await translated(page)
    await accessible(page, info, 'feedback-candidate-review')
    await page.getByTestId('candidate-approve').click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Approve|Publish/ })
      .click()
    await expect(page.getByTestId('candidate-state')).toHaveText('Published', { timeout: 40_000 })
    const published = await client.request('_agnes/v1/admin.feedback', { action: 'list', sessionId })
    expect(published.growth[0]).toMatchObject({
      state: 'published',
      candidateHash: candidate.candidateHash,
      reviewer: 'local',
    })
    expect(published.growth[0]?.reviewHash).toMatch(/^sha256-/)
    expect(
      (await client.packages.list({ profile: 'local-dev' })).packages.some(
        (item) => item.id === candidate.packageId,
      ),
    ).toBe(true)
    const finalCandidate = await client.request('_agnes/v1/plugins.candidates.show', {
      profile: 'local-dev',
      candidateId,
    })
    expect(finalCandidate.tests?.hash).toBe(finalCandidate.candidateHash)
    expect(finalCandidate.reviewHash).toBe(published.growth[0]?.reviewHash)
    await page.goto(`${runtime.url}/?session=${encodeURIComponent(sessionId)}&factCandidate=${candidateId}`)
    await expect(page.getByTestId('feedback-provenance')).toContainText('Published version')
    await expect(page.getByTestId('feedback-provenance')).toContainText(
      'feedback-skill-review-evidence@1.0.0',
    )
    await translated(page)
    await accessible(page, info, 'feedback-provenance')
    const exported = await runtime.cli(['export', sessionId])
    expect(exported).toContain('x/feedback/item')
    expect(exported).toContain('x/feedback/growth')
    await settings(page)
    await section(page, 'feedback')
    await expect(page.getByTestId('feedback-admin-item')).toContainText('Cite observed evidence')
    await page.getByTestId('feedback-candidate-filter').selectOption('yes')
    await expect(page.getByTestId('feedback-counts')).toContainText('1 negative')
    await page.getByTestId('feedback-rating-filter').selectOption('up')
    await expect(page.getByTestId('feedback-admin-item')).toHaveCount(0)
    await expect(page.getByTestId('feedback-counts')).toContainText('0 negative')
    await preferences(page, 'zh-CN', 'dark')
    await page.goto(`${runtime.url}/?session=${encodeURIComponent(sessionId)}&factCandidate=${candidateId}`)
    await expect(page.getByTestId('feedback-provenance')).toContainText('发布版本')
    const restored = page.getByTestId('message-feedback').last()
    await restored.getByTestId('feedback-details').click()
    await expect(restored.getByTestId('feedback-note')).toHaveValue(
      'Cite observed evidence and state uncertainty.',
    )
    await restored.getByTestId('feedback-withdraw').click()
    await expect(restored.getByTestId('feedback-down')).toHaveAttribute('aria-pressed', 'false')
    await expect(restored.getByTestId('feedback-generate')).toHaveCount(0)
    await page.getByTestId('workbench-tab-feedback').click()
    const sessionFeedback = page.getByTestId('session-feedback')
    await sessionFeedback.getByTestId('feedback-up').click()
    await expect(sessionFeedback).toContainText('反馈已保存')
    await expect(sessionFeedback.getByTestId('feedback-generate')).toHaveCount(0)
    await translated(page)
    await accessible(page, info, 'feedback-zh')
  } finally {
    await client.close()
    await fixture.close()
  }
})
