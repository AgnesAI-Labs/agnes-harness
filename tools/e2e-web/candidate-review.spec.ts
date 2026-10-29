import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session } from '@agnes/sdk'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { accessible, screen, translated } from './quality.js'
import { describingFirst, install, prompt, toolResult } from './sdk.js'
import {
  chooseWorkspace,
  closeSettings,
  expand,
  expandActivityGroups,
  fresh,
  pluginTab,
  preferences,
  section,
  settings,
  traceSequence,
} from './ui.js'

/** The page opened the session: its latest durable turn is the last one shown, inside the opening window. */
async function latestTurnShown(page: Page, session: Session) {
  const latest = (await session.projectUI(undefined, { surface: 'web' })).turns.at(-1)
  if (!latest) throw new Error('The session must have a turn to show')
  await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-turn-id', latest.id)
}

test('agent candidate review binds exact tests and hashes, refuses edited approval, publishes only for new sessions', async ({
  page,
  runtime,
  expectedBrowserErrors,
}, info) => {
  test.setTimeout(300_000)
  const pluginPage = page.getByTestId('home-page-plugins')
  const skillReview = page.getByTestId('candidate-review')
  async function reviewType(kind: 'plugin' | 'skill') {
    await section(page, 'review')
    const zh = (await page.locator('html').getAttribute('lang')) === 'zh-CN'
    await page
      .getByTestId('review-type')
      .getByRole('radio', {
        name: kind === 'plugin' ? (zh ? '插件' : 'Plugins') : zh ? '技能' : 'Skills',
        exact: true,
      })
      .check()
  }

  const client = await runtime.connect()
  const old = await client.session.new({
    sessionKey: crypto.randomUUID(),
    cwd: runtime.workspace,
    preset: 'standard',
    permission: 'workspace-write',
  })
  await old.attach()
  const authoringIdle = async () => {
    const view = await old.projectUI(undefined, { surface: 'web' })
    return { op: view.opState, pending: view.pendingInputs ?? [] }
  }
  const followUp = async (input: string) => {
    const before = (await old.projectUI(undefined, { surface: 'web' })).upto
    // Authoring receipts may continue in a backend turn. Queue the next input once through the
    // supported SDK, then require this exact input's durable completed turn, without resubmitting.
    await old.followUp(input, { commandId: crypto.randomUUID() })
    await expect
      .poll(
        async () => {
          const view = await old.projectUI(undefined, { surface: 'web' })
          const user = view.nodes.findLast(
            (node) =>
              node.kind === 'user' &&
              node.seq > before &&
              node.content.some((block) => block.type === 'text' && block.text === input),
          )
          const turn = user && view.turns.find((turn) => turn.nodeIds.includes(user.id))
          return turn && { status: turn.status, reason: turn.reason }
        },
        { timeout: 20_000 },
      )
      .toEqual({ status: 'completed', reason: 'completed' })
  }
  const promptOld = describingFirst(followUp)
  expect((await old.tools()).tools.some((tool) => tool.name === 'skill_read')).toBe(true)
  await client.session.rename(old.id, 'Text statistics workshop')
  old.onPermissionRequest(async () => ({ verdict: 'allowed-once' }))
  await promptOld('call plugin_helper_guide {"kind":"tool"}')
  const guide = JSON.parse(
    (await toolResult(old, 'plugin_helper_guide'))!.content[0]!.type === 'text'
      ? ((await toolResult(old, 'plugin_helper_guide'))!.content[0] as { text: string }).text
      : '{}',
  ) as { files: { path: string; content: string }[] }
  await promptOld('call plugin_helper_create ' + JSON.stringify({ files: guide.files }))
  const createdResult = (await toolResult(old, 'plugin_helper_create'))!.content[0] as { text: string }
  const draft = JSON.parse(createdResult.text) as import('@agnes/protocol').AuthoringCandidate
  // Turns 1 and 3 describe the on-demand guide and create tools.
  expect(draft).toMatchObject({ state: 'draft', installer: 'agent', origin: { turn: 4 } })
  expect(
    (await client.packages.list({ profile: 'local-dev' })).packages.some((p) => p.id === draft.packageId),
  ).toBe(false)
  await promptOld(
    'call plugin_helper_install ' + JSON.stringify({ action: 'test', proposalId: draft.candidateId }),
  )
  await promptOld(
    'call plugin_helper_install ' + JSON.stringify({ action: 'commit', proposalId: draft.candidateId }),
  )
  const reviewed = await client.request('_agnes/v1/plugins.candidates.show', {
    profile: 'local-dev',
    candidateId: draft.candidateId,
  })
  expect(reviewed).toMatchObject({ state: 'review', tests: { state: 'passed', hash: draft.candidateHash } })
  await page.addInitScript(() => {
    if (location.protocol !== 'http:') return
    localStorage.setItem('agnes-locale', localStorage.getItem('e2e-authoring-locale') ?? 'en')
    localStorage.setItem('agnes-theme', localStorage.getItem('e2e-authoring-theme') ?? 'light')
  })
  await page.goto(runtime.url)
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
  await expect(page.locator('.workspace-heading .workspace-name').filter({ hasText: /^w$/ })).toHaveCount(1)
  expect((await client.workspace.list()).items.every((workspace) => workspace.name.trim().length > 0)).toBe(
    true,
  )
  if (!(await page.getByTestId('settings-navigation').isVisible())) await settings(page)
  await reviewType('plugin')
  await pluginPage
    .locator(`li[data-candidate-id="${draft.candidateId}"]`)
    .getByTestId('candidate-open')
    .click()
  await expect(pluginPage.getByTestId('candidate-state')).toHaveText('Awaiting review')
  await expect(pluginPage.getByTestId('candidate-tests')).toContainText('Tests passed 1/1')
  await expect(pluginPage.getByTestId('candidate-provenance')).toContainText(
    'Drafted by Agent · From “Text statistics workshop” (turn 4)',
  )
  await expect(pluginPage.getByTestId('candidate-capability-delta')).toContainText('New permissions: none')
  await expect(pluginPage.getByTestId('candidate-summary')).toContainText('No new permissions')
  await expect(pluginPage.getByTestId('candidate-hash')).toBeHidden()
  await expect(pluginPage.getByTestId('candidate-technical')).toHaveAttribute('data-open', 'false')
  await expect(pluginPage.getByTestId('candidate-approve')).toBeInViewport({ ratio: 1 })
  await expect(pluginPage.getByTestId('candidate-reject')).toBeInViewport({ ratio: 1 })
  const diff = pluginPage
    .getByTestId('candidate-file-diff')
    .filter({ has: page.getByText('index.mjs', { exact: true }) })
  await diff.locator('summary, .agh-disclosure-summary').click()
  await expect(diff).toContainText('my_text_stats')
  await expect(diff.getByText('New file', { exact: true })).toBeVisible()
  await expect(diff.locator('.candidate-diff-added').first()).toContainText('+')
  await translated(page)
  await accessible(page, info, 'candidate-review')
  // Review each changed screen across both languages and themes. Digest and session IDs are dynamic.
  for (const [locale, theme] of [
    ['en', 'light'],
    ['en', 'dark'],
    ['zh-CN', 'light'],
    ['zh-CN', 'dark'],
  ] as const) {
    await page.evaluate(
      ({ locale, theme }) => {
        localStorage.setItem('e2e-authoring-locale', locale)
        localStorage.setItem('e2e-authoring-theme', theme)
      },
      { locale, theme },
    )
    await page.goto(runtime.url)
    await latestTurnShown(page, old)
    await expect(
      page.getByRole('button', { name: locale === 'en' ? 'Settings' : '设置', exact: true }),
    ).toBeVisible()
    if (!(await page.getByTestId('settings-navigation').isVisible())) await settings(page, locale)
    await reviewType('plugin')
    await pluginPage
      .locator(`li[data-candidate-id="${draft.candidateId}"]`)
      .getByTestId('candidate-open')
      .click()
    await expect(pluginPage.getByTestId('candidate-approve')).toBeInViewport({ ratio: 1 })
    await expect(pluginPage.getByTestId('candidate-reject')).toBeInViewport({ ratio: 1 })
    await expect(pluginPage.getByTestId('candidate-hash')).toBeHidden()
    await translated(page)
    await accessible(page, info, `candidate-review-${locale}-${theme}`)
    await expect(skillReview.locator('.candidate-summary-facts')).toHaveCSS('display', 'flex')
    await screen(page, info, `candidate-review-${locale}-${theme}`)
    await pluginPage.getByTestId('candidate-fact-chain').click()
    const facts = page.getByTestId('trace-authoring')
    await expect(facts).toContainText(draft.packageId)
    await expect(facts).toContainText(locale === 'en' ? 'Tests passed: 1' : '测试通过 1 项')
    await expect(facts.locator('.agh-disclosure')).toHaveAttribute('data-open', 'false')
    await translated(page)
    await accessible(page, info, `fact-authoring-${locale}-${theme}`)
    // The originating candidate is selected in the unified Trace source inspector.
    await expect(page.locator('.trace-tab[data-pane="source"]')).toHaveAttribute('aria-selected', 'true')
    await traceSequence(page)
    await page.mouse.move(0, 0)
    await expect(page.locator('.trace-inspector')).toBeInViewport({ ratio: 1 })
    await screen(page, info, `fact-authoring-${locale}-${theme}`)
  }
  await page.evaluate(() => {
    localStorage.setItem('e2e-authoring-locale', 'en')
    localStorage.setItem('e2e-authoring-theme', 'light')
  })
  await page.goto(runtime.url)
  await latestTurnShown(page, old)
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
  if (!(await page.getByTestId('settings-navigation').isVisible())) await settings(page)
  await reviewType('plugin')
  await pluginPage
    .locator(`li[data-candidate-id="${draft.candidateId}"]`)
    .getByTestId('candidate-open')
    .click()
  await client.session.rename(old.id, 'A very long workshop title '.repeat(3).slice(0, 80))
  await page.goto(runtime.url)
  await latestTurnShown(page, old)
  if (!(await page.getByTestId('settings-navigation').isVisible())) await settings(page)
  await reviewType('plugin')
  await pluginPage
    .locator(`li[data-candidate-id="${draft.candidateId}"]`)
    .getByTestId('candidate-open')
    .click()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const [width, height] of [
    [1440, 900],
    [1024, 900],
    [900, 900],
    [840, 900],
    [540, 900],
    [390, 900],
    [540, 600],
  ]) {
    await page.setViewportSize({ width: width!, height: height! })
    await expect(pluginPage.getByTestId('candidate-approve')).toBeInViewport({ ratio: 1 })
    await expect(pluginPage.getByTestId('candidate-reject')).toBeInViewport({ ratio: 1 })
    expect(
      await pluginPage
        .getByTestId('candidate-review')
        .evaluate((panel) => panel.scrollWidth <= panel.clientWidth),
    ).toBe(true)
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await client.session.rename(old.id, 'Text statistics workshop')
  await pluginPage.getByTestId('candidate-approve').click()
  const dialog = page.getByRole('dialog', { name: 'Approve and publish', exact: true })
  await expect(dialog.getByTestId('candidate-hash')).toBeHidden()
  await dialog.getByTestId('candidate-technical').locator('summary, .agh-disclosure-summary').focus()
  await dialog.getByTestId('candidate-technical').locator('summary, .agh-disclosure-summary').press('Enter')
  await expect(dialog.getByTestId('candidate-hash')).toHaveText(reviewed.candidateHash)
  // A model edit after the human opened the review must invalidate that dialog's captured hashes.
  const changed = guide.files.map((f) =>
    f.path === 'index.mjs' ? { ...f, content: f.content + '\n// Edited after review\n' } : f,
  )
  const { readFile, writeFile } = await import('node:fs/promises'),
    { join } = await import('node:path')
  const record = JSON.parse(
    await readFile(
      join(runtime.home, 'profiles/local-dev/.authoring-candidates', draft.candidateId, 'record.json'),
      'utf8',
    ),
  ) as { tree: string }
  await writeFile(join(record.tree, 'index.mjs'), changed.find((f) => f.path === 'index.mjs')!.content)
  expectedBrowserErrors.push(
    'console: Failed to load resource: the server responded with a status of 409 (Conflict)',
  )
  const staleResponse = page.waitForResponse((response) => response.url().endsWith('/candidates/approve'))
  await dialog.getByRole('button', { name: 'Approve and publish', exact: true }).click()
  expect((await staleResponse).status()).toBe(409)
  await expect(pluginPage.getByTestId('candidate-error')).toBeVisible()
  expect(
    (await client.packages.list({ profile: 'local-dev' })).packages.some((p) => p.id === draft.packageId),
  ).toBe(false)
  await pluginPage.getByTestId('push-back').click()
  await pluginPage
    .locator(`li[data-candidate-id="${draft.candidateId}"]`)
    .getByTestId('candidate-open')
    .click()
  await expect(pluginPage.getByTestId('candidate-state')).toHaveText('Draft; review invalidated after edits')
  await expect(pluginPage.getByTestId('candidate-approve')).toHaveCount(0)
  await pluginPage.getByTestId('candidate-test').click()
  await page
    .getByRole('dialog', { name: 'Run tests', exact: true })
    .getByRole('button', { name: 'Run tests', exact: true })
    .click()
  await expect(pluginPage.getByTestId('candidate-state')).toHaveText('Tests passed; awaiting submission')
  await pluginPage.getByTestId('candidate-submit').click()
  await expect(pluginPage.getByTestId('candidate-state')).toHaveText('Awaiting review')
  await pluginPage.getByTestId('candidate-approve').click()
  await page
    .getByRole('dialog', { name: 'Approve and publish', exact: true })
    .getByRole('button', { name: 'Approve and publish', exact: true })
    .click()
  await expect(pluginPage.getByTestId('candidate-review')).toHaveCount(0, { timeout: 25_000 })
  await expect(pluginPage.getByTestId('candidate-published-link')).toContainText(draft.packageId)
  const provenance = await client.request('_agnes/v1/packages.provenance', {
    profile: 'local-dev',
    id: draft.packageId,
  })
  expect(provenance).toMatchObject({
    installer: 'agent',
    authoring: { candidateId: draft.candidateId, origin: draft.origin },
  })
  expect(provenance.authoring!.candidateHash).not.toBe(reviewed.candidateHash)
  expect((await old.tools()).tools.some((t) => t.name === 'my_text_stats')).toBe(false)
  const freshSession = await client.session.new({
    sessionKey: crypto.randomUUID(),
    cwd: runtime.workspace,
    preset: 'standard',
    permission: 'full-access',
  })
  await freshSession.attach()
  // Keep the sidebar title stable across review screenshots instead of its creation-time fallback.
  await client.session.rename(freshSession.id, 'Published plugin check')
  expect((await freshSession.tools()).tools.some((tool) => tool.name === 'skill_read')).toBe(true)
  expect((await freshSession.tools()).tools.some((t) => t.name === 'my_text_stats')).toBe(true)
  await prompt(freshSession, 'call my_text_stats {"text":"hello world"}')
  expect((await toolResult(freshSession, 'my_text_stats'))!.structured).toEqual({ characters: 11, words: 2 })
  await promptOld('call read {"path":"report.md"}')
  expect(JSON.stringify(await toolResult(old, 'read'))).toContain('Synthetic delivery')
  // Authored Markdown and adjacent scripts stay inert, and rejection never publishes a Skill.
  const skillBody =
    '---\nname: Reviewed method\ndescription: Synthetic reusable workflow.\n---\n\nUse the normal approved shell tool for scripts.\n'
  await promptOld(
    'call skill_helper_create ' +
      JSON.stringify({
        name: 'reviewed-method',
        files: [
          { path: 'SKILL.md', content: skillBody },
          {
            path: 'scripts/check.mjs',
            content: "throw new Error('This script must never run during review')\n",
          },
        ],
      }),
  )
  const skill = JSON.parse(
    ((await toolResult(old, 'skill_helper_create'))!.content[0] as { text: string }).text,
  ) as import('@agnes/protocol').AuthoringCandidate
  expect(skill).toMatchObject({ state: 'draft', installer: 'agent' })
  await promptOld(
    'call skill_helper_install ' + JSON.stringify({ action: 'test', proposalId: skill.candidateId }),
  )
  await promptOld(
    'call skill_helper_install ' + JSON.stringify({ action: 'commit', proposalId: skill.candidateId }),
  )
  await reviewType('skill')
  await page.getByTestId('home-page-plugins').getByTestId('candidate-refresh').click()
  const skillRow = page
    .getByTestId('home-page-plugins')
    .getByTestId('candidate-list')
    .locator(`li[data-candidate-id="${skill.candidateId}"]`)
  await expect(skillRow.getByTestId('candidate-origin-time')).toHaveCount(1)
  await skillRow.getByTestId('candidate-open').click()
  await expect(skillReview.getByTestId('candidate-tests')).toContainText('Tests passed 1/1')
  await skillReview
    .getByTestId('candidate-file-diff')
    .filter({ has: page.getByText('skills/reviewed-method/SKILL.md', { exact: true }) })
    .locator('summary, .agh-disclosure-summary')
    .click()
  const skillDiff = skillReview
    .getByTestId('candidate-file-diff')
    .filter({ has: page.getByText('skills/reviewed-method/SKILL.md', { exact: true }) })
    .locator('.candidate-diff-added')
  await expect
    .poll(async () => (await skillDiff.allTextContents()).map((line) => line.slice(2, -1)).join('\n'))
    .toBe(skillBody)
  await skillReview.getByTestId('candidate-reject').click()
  await page
    .getByRole('dialog', { name: 'Reject candidate', exact: true })
    .getByRole('button', { name: 'Reject candidate', exact: true })
    .click()
  await expect(skillReview.getByTestId('candidate-state')).toHaveText('Rejected')
  await pluginPage.getByTestId('push-back').click()
  await expect(page.getByTestId('home-page-plugins').getByTestId('candidate-list').locator('li')).toHaveCount(
    0,
  )
  const skillHistory = page.getByTestId('home-page-plugins').getByTestId('candidate-history')
  await expect(skillHistory).toHaveAttribute('data-open', 'false')
  await skillHistory.locator('summary, .agh-disclosure-summary').click()
  await expect(skillHistory.locator('li')).toHaveCount(1)
  await expect(skillHistory.locator(`li[data-candidate-id="${skill.candidateId}"]`)).toContainText('Rejected')
  await reviewType('plugin')
  await expect(pluginPage.getByTestId('candidate-review')).toHaveCount(0)
  await expect(pluginPage.getByTestId('candidate-list').getByTestId('candidate-open')).toHaveCount(0)
  const pluginHistory = pluginPage.getByTestId('candidate-history')
  await expect(pluginHistory).toHaveAttribute('data-open', 'false')
  await pluginHistory.locator('summary, .agh-disclosure-summary').click()
  await expect(pluginHistory.getByTestId('candidate-open')).toHaveCount(1)
  await expect(pluginHistory.locator(`li[data-candidate-id="${draft.candidateId}"]`)).toContainText(
    'Published',
  )
  expect(
    (await client.packages.list({ profile: 'local-dev' })).packages.some((p) => p.id === skill.packageId),
  ).toBe(false)
  // A reviewed update supplies a genuine replacement diff, and the inbox shows all three review outcomes.
  await expect.poll(authoringIdle).toEqual({ op: null, pending: [] })
  const updateFiles = guide.files.map((file) =>
    file.path === 'index.mjs' ? { ...file, content: file.content + '\n// Reviewed update\n' } : file,
  )
  // Escape template text so the demo's natural-language authoring shortcut does not replace this explicit call.
  await promptOld(
    'call plugin_helper_create ' +
      JSON.stringify({ files: updateFiles }).replace(/[Pp]/g, (letter) =>
        letter === 'P' ? '\\u0050' : '\\u0070',
      ),
  )
  const update = JSON.parse(
    ((await toolResult(old, 'plugin_helper_create'))!.content[0] as { text: string }).text,
  ) as import('@agnes/protocol').AuthoringCandidate
  const updateReview = await client.request('_agnes/v1/plugins.candidates.show', {
    profile: 'local-dev',
    candidateId: update.candidateId,
  })
  expect(updateReview.files.find((file) => file.path === 'index.mjs')?.after).toBe(
    updateFiles.find((file) => file.path === 'index.mjs')!.content,
  )
  await expect.poll(authoringIdle).toEqual({ op: null, pending: [] })
  await promptOld(
    'call plugin_helper_install ' + JSON.stringify({ action: 'test', proposalId: update.candidateId }),
  )
  await promptOld(
    'call plugin_helper_install ' + JSON.stringify({ action: 'commit', proposalId: update.candidateId }),
  )
  for (const [locale, theme] of [
    ['en', 'light'],
    ['en', 'dark'],
    ['zh-CN', 'light'],
    ['zh-CN', 'dark'],
  ] as const) {
    await page.evaluate(
      ({ locale, theme }) => {
        localStorage.setItem('e2e-authoring-locale', locale)
        localStorage.setItem('e2e-authoring-theme', theme)
      },
      { locale, theme },
    )
    await page.goto(runtime.url)
    await latestTurnShown(page, old)
    if (!(await page.getByTestId('settings-navigation').isVisible())) await settings(page, locale)
    await reviewType('plugin')
    await expect(pluginPage.getByTestId('candidate-list').getByTestId('candidate-open')).toHaveCount(1)
    const history = pluginPage.getByTestId('candidate-history')
    await expect(history).toHaveAttribute('data-open', 'false')
    await history.locator('summary, .agh-disclosure-summary').click()
    await expect(history.getByTestId('candidate-open')).toHaveCount(1)
    const rows = pluginPage.locator('li[data-candidate-id]')
    await expect(rows).toHaveCount(2)
    await expect(
      rows
        .filter({ hasText: draft.packageId })
        .filter({ hasText: locale === 'en' ? 'New plugin' : '新插件' }),
    ).toHaveCount(1)
    await expect(
      rows.filter({ hasText: draft.packageId }).filter({ hasText: locale === 'en' ? 'Update' : '更新' }),
    ).toHaveCount(1)
    await expect(rows.filter({ hasText: skill.packageId })).toHaveCount(0)
    await expect(rows.getByTestId('candidate-origin-time')).toHaveCount(2)
    await reviewType('skill')
    const skillCandidateHistory = page.getByTestId('home-page-plugins').getByTestId('candidate-history')
    await expect(skillCandidateHistory).toHaveAttribute('data-open', 'false')
    await skillCandidateHistory.locator('summary, .agh-disclosure-summary').click()
    await expect(
      page
        .getByTestId('home-page-plugins')
        .getByTestId('candidate-history')
        .locator(`li[data-candidate-id="${skill.candidateId}"]`),
    ).toContainText(locale === 'en' ? 'Skill · New skill' : '技能 · 新技能')
    await expect(
      page
        .getByTestId('home-page-plugins')
        .getByTestId('candidate-history')
        .locator(`li[data-candidate-id="${skill.candidateId}"]`)
        .getByTestId('candidate-origin-time'),
    ).toHaveCount(1)
    await reviewType('plugin')
    await expect(rows.first()).toContainText(locale === 'en' ? 'Plugin · Update' : '插件 · 更新')
    await expect(rows.getByTestId('candidate-list-facts').first()).toContainText('0.1.0')
    await expect(page.getByTestId('plugin-drain-summary')).toHaveCount(0)
    const installed = (await client.packages.list({ profile: 'local-dev' })).packages
    const draining = (await client.packages.generations({ profile: 'local-dev' })).plugins.find(
      (plugin) => plugin.drainingSessions > 0 && installed.some((item) => item.id === plugin.id),
    )
    expect(draining).toBeDefined()
    await section(page, 'plugins')
    await page.locator(`.plugin-row[data-plugin-id="${draining!.id}"] .plugin-details-button`).click()
    await pluginTab(page, 'versions').click()
    await expect(page.getByTestId('plugin-drain-summary')).toHaveCount(1)
    await expect(page.getByTestId('plugin-drain-summary')).not.toContainText('@agnes/')
    await page.getByTestId('push-back').click()
    await reviewType('plugin')
    await expand(pluginPage.getByTestId('candidate-history'))
    // Assert real timestamps above; normalize only elapsed text for stable screenshots.
    const times = rows.getByTestId('candidate-origin-time')
    const originals = await times.allTextContents()
    await times.evaluateAll(
      (nodes, text) =>
        nodes.forEach((node) => {
          node.textContent = text
        }),
      locale === 'en' ? 'Session turn: 2 min ago' : '来源轮次：2 分钟前',
    )
    await screen(page, info, `candidate-list-${locale}-${theme}`)
    await times.evaluateAll(
      (nodes, labels) =>
        nodes.forEach((node, index) => {
          node.textContent = labels[index] ?? ''
        }),
      originals,
    )
    await pluginPage
      .locator(`li[data-candidate-id="${update.candidateId}"]`)
      .filter({ hasText: locale === 'en' ? 'Awaiting review' : '待审阅' })
      .getByTestId('candidate-open')
      .click()
    const file = pluginPage
      .getByTestId('candidate-file-diff')
      .filter({ has: page.getByText('index.mjs', { exact: true }) })
    await file.locator('summary, .agh-disclosure-summary').click()
    const removed = file.locator('.candidate-diff-removed').filter({ hasText: '// Edited after review' })
    const added = file.locator('.candidate-diff-added').filter({ hasText: '// Reviewed update' })
    const diff = file.getByTestId('candidate-diff-lines')
    await diff.focus()
    await diff.press('ArrowDown')
    await expect.poll(() => diff.evaluate((pre) => pre.scrollTop)).toBeGreaterThan(0)
    await file.getByTestId('candidate-diff-lines').evaluate((pre) => {
      pre.scrollIntoView({ block: 'nearest' })
      pre.scrollTop = pre.scrollHeight
    })
    await expect(removed).toContainText('- // Edited after review')
    await expect(removed).toBeInViewport({ ratio: 1 })
    await expect(added).toContainText('+ // Reviewed update')
    await expect(added).toBeInViewport({ ratio: 1 })
    await expect(file.locator('summary, .agh-disclosure-summary')).toBeInViewport({ ratio: 1 })
    await expect(pluginPage.getByTestId('candidate-approve')).toBeInViewport({ ratio: 1 })
    await translated(page)
    await accessible(page, info, `candidate-diff-${locale}-${theme}`)
    await screen(page, info, `candidate-diff-${locale}-${theme}`)
  }
  await page.evaluate(() => {
    localStorage.setItem('e2e-authoring-locale', 'en')
    localStorage.setItem('e2e-authoring-theme', 'light')
  })
  await page.goto(runtime.url)
  await latestTurnShown(page, old)
  if (!(await page.getByTestId('settings-navigation').isVisible())) await settings(page)
  await reviewType('plugin')
  await promptOld(
    'call skill_helper_create ' +
      JSON.stringify({
        name: 'reviewed-published',
        files: [
          {
            path: 'SKILL.md',
            content: skillBody.replace('name: Reviewed method', 'name: reviewed-published'),
          },
          {
            path: 'scripts/check.mjs',
            content: "throw new Error('This script must never run during review')\n",
          },
        ],
      }),
  )
  await expect.poll(authoringIdle).toEqual({ op: null, pending: [] })
  const publishSkill = JSON.parse(
    ((await toolResult(old, 'skill_helper_create'))!.content[0] as { text: string }).text,
  ) as import('@agnes/protocol').AuthoringCandidate
  expect(publishSkill).toMatchObject({ state: 'draft', installer: 'agent', candidateId: expect.any(String) })
  await promptOld(
    'call skill_helper_install ' + JSON.stringify({ action: 'test', proposalId: publishSkill.candidateId }),
  )
  await promptOld(
    'call skill_helper_install ' + JSON.stringify({ action: 'commit', proposalId: publishSkill.candidateId }),
  )
  await reviewType('skill')
  await page.getByTestId('home-page-plugins').getByTestId('candidate-refresh').click()
  const publishSkillRow = page
    .getByTestId('home-page-plugins')
    .getByTestId('candidate-list')
    .locator(`li[data-candidate-id="${publishSkill.candidateId}"]`)
  await expect(publishSkillRow.getByTestId('candidate-origin-time')).toHaveCount(1)
  await publishSkillRow.getByTestId('candidate-open').click()
  await skillReview.getByTestId('candidate-approve').click()
  await page
    .getByRole('dialog', { name: 'Approve and publish', exact: true })
    .getByRole('button', { name: 'Approve and publish', exact: true })
    .click()
  await expect(skillReview).toBeHidden({ timeout: 25_000 })
  await expect(page.getByTestId('home-page-plugins').getByTestId('candidate-published')).toBeVisible()
  await expect(page.getByTestId('home-page-plugins').getByTestId('candidate-published-link')).toHaveAttribute(
    'href',
    /page=plugins&tab=skills/,
  )
  // Approved static resources are discovered automatically; do not request a manual refresh.
  await expect
    .poll(async () => {
      const result = await client.resources.list({ profile: 'local-dev', kind: 'skill' })
      return result.items.find(
        (resource) => resource.kind === 'skill' && resource.name === 'reviewed-published',
      )
    })
    .toMatchObject({
      kind: 'skill',
      name: 'reviewed-published',
      trust: 'trusted',
      desired: 'enabled',
      actual: 'ready',
    })
  const skillSession = await client.session.new({
    sessionKey: crypto.randomUUID(),
    cwd: runtime.workspace,
    preset: 'standard',
    permission: 'full-access',
  })
  await skillSession.attach()
  await prompt(skillSession, 'call skill_read {"name":"reviewed-published"}')
  expect(JSON.stringify(await toolResult(skillSession, 'skill_read'))).toContain(
    'Use the normal approved shell tool for scripts.',
  )
  await promptOld('call skill_read {"name":"reviewed-published"}')
  expect(JSON.stringify(await toolResult(old, 'skill_read'))).toContain(
    'Use the normal approved shell tool for scripts.',
  )
  expect((await old.tools()).tools.some((t) => t.name === 'my_text_stats')).toBe(false)
  const list = JSON.parse(await runtime.cli(['plugins', 'candidates', 'list', '--json'])) as {
    candidates: { state: string }[]
  }
  expect(list.candidates.some((c) => c.state === 'published')).toBe(true)
  await info.attach('reviewed-publication.json', {
    body: JSON.stringify({ reviewed, provenance }),
    contentType: 'application/json',
  })
  await section(page, 'plugins')
  // Installed provenance opens the retained published candidate, not the pending replacement.
  await page.getByRole('button', { name: `View details for ${draft.packageId}`, exact: true }).click()
  await pluginTab(page, 'permissions').click()
  await page.getByTestId(`push-page-plugin:${draft.packageId}`).getByTestId('plugin-fact-chain').click()
  const publishedFacts = page.getByTestId('trace-authoring')
  await expect(publishedFacts).toContainText(`${draft.packageId} 0.1.0 · Published`)
  await expect(publishedFacts).toContainText('Human review recorded')
  await expect(publishedFacts).toContainText('Tests passed: 1')
})

test('full access candidate submission publishes without a human offer and retains daemon evidence', async ({
  page,
  runtime,
}) => {
  test.setTimeout(120_000)
  const client = await runtime.connect()
  const session = await client.session.new({
    sessionKey: crypto.randomUUID(),
    cwd: runtime.workspace,
    preset: 'standard',
    permission: 'full-access',
  })
  await session.attach()
  // No approval handler: any attempted human delivery makes the real tool flow fail.
  const send = describingFirst((input) => prompt(session, input))
  await send('call plugin_helper_guide {"kind":"tool"}')
  const guideResult = (await toolResult(session, 'plugin_helper_guide'))!.content[0]!
  if (guideResult.type !== 'text') throw new Error('Expected authoring guide')
  const guide = JSON.parse(guideResult.text) as { files: { path: string; content: string }[] }
  await send(`call plugin_helper_create ${JSON.stringify({ files: guide.files })}`)
  const created = (await toolResult(session, 'plugin_helper_create'))!.content[0]!
  if (created.type !== 'text') throw new Error('Expected candidate receipt')
  const draft = JSON.parse(created.text) as import('@agnes/protocol').AuthoringCandidate
  for (const name of ['plugin_test', 'plugin_install_local']) {
    await send(
      `call ${name} ${JSON.stringify({ candidateId: draft.candidateId, expectedHash: draft.candidateHash })}`,
    )
    await toolResult(session, name)
  }
  expect(
    await client.request('_agnes/v1/plugins.candidates.show', {
      profile: 'local-dev',
      candidateId: draft.candidateId,
    }),
  ).toMatchObject({ state: 'published', candidateHash: draft.candidateHash, reviewer: 'full-access' })
  const installed = (await client.packages.list({ profile: 'local-dev' })).packages.find(
    (p) => p.id === draft.packageId,
  )
  expect(installed).toMatchObject({ desired: 'enabled' })
  const timeline = await session.projectUI(undefined, { surface: 'web' })
  expect(timeline.nodes.filter((node) => node.kind === 'approval' && node.state === 'pending')).toEqual([])
  expect(timeline.nodes.filter((node) => node.kind === 'tool' && node.permissionDecision)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'plugin_test',
        permissionDecision: expect.objectContaining({ reason: 'full-access' }),
      }),
      expect.objectContaining({
        name: 'plugin_install_local',
        permissionDecision: expect.objectContaining({ reason: 'full-access' }),
      }),
    ]),
  )
  await preferences(page)
  await page.goto(`${runtime.url}/?session=${encodeURIComponent(session.id)}`)
  await latestTurnShown(page, session)
  for (const toggle of await page.getByTestId('turn-process-toggle').all()) {
    // A turn whose process has nothing to show keeps its toggle hidden.
    if (!(await toggle.isVisible())) continue
    if (!(await toggle.evaluate((node) => node.parentElement?.getAttribute('data-open') === 'true')))
      await toggle.click()
  }
  for (const turn of await page.getByTestId('conversation-turn').all()) await expandActivityGroups(turn)
  await expect(page.getByTestId('approval-card')).toHaveCount(0)
  await expect(
    page.getByTestId('approval-step').filter({ hasText: 'Auto-allowed (Full access)' }).first(),
  ).toBeVisible()
})
