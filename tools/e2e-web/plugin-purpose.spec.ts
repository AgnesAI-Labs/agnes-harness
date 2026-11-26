import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { NodeClient } from '@agnes/sdk'
import { expect, test } from './fixtures.js'
import { command, complete, install } from './sdk.js'
import { chooseWorkspace, pluginTab, preferences, section, settings } from './ui.js'

const docsFixture = 'tools/e2e-web/fixtures/plugin-config'
const docsOrigin = 'https://queue-docs.example.test'

async function installWithoutActivation(client: NodeClient, directory: string) {
  const source = { type: 'file' as const, ref: `file:${resolve(directory).replaceAll('\\', '/')}` }
  const { preview } = await complete(
    client,
    await client.packages.inspect({ ...(await command(client)), source }),
  )
  if (!preview) throw new Error('Docs fixture inspection did not return a package')
  await complete(
    client,
    await client.packages.install({
      ...(await command(client)),
      source,
      expectedIntegrity: preview.integrity,
    }),
  )
  return preview.id
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`opens installed plugin documentation offline and activates only explicit links (${locale})`, async ({
    context,
    page,
    runtime,
  }) => {
    const client = await runtime.connect()
    const id = await installWithoutActivation(client, docsFixture)
    // A second installed package omits the declared files. Its metadata link remains available.
    const fallbackDir = join(runtime.workspace, 'docs-not-packaged')
    await mkdir(fallbackDir)
    const [manifest, entry] = await Promise.all([
      readFile(join(docsFixture, 'package.json'), 'utf8'),
      readFile(join(docsFixture, 'index.js'), 'utf8'),
    ])
    await writeFile(join(fallbackDir, 'index.js'), entry.replaceAll('e2eConfigAgent', 'e2eConfigAgentNoDocs'))
    await writeFile(
      join(fallbackDir, 'package.json'),
      manifest
        .replace('@agnes-e2e/plugin-config', '@agnes-e2e/plugin-config-no-docs')
        .replace('ext:e2e/config-agent', 'ext:e2e/config-agent-no-docs')
        .replace('e2eConfigAgent', 'e2eConfigAgentNoDocs'),
    )
    const fallbackId = await installWithoutActivation(client, fallbackDir)

    const visited: { path: string; referrer?: string }[] = []
    await context.route(`${docsOrigin}/**`, async (route) => {
      const request = route.request()
      const referrer = (await request.allHeaders()).referer
      visited.push({ path: new URL(request.url()).pathname, ...(referrer ? { referrer } : {}) })
      await route.fulfill({ contentType: 'text/plain', body: 'Synthetic documentation destination' })
    })
    const docsReads: string[] = []
    const packageAssets: string[] = []
    page.on('request', (request) => {
      const { pathname } = new URL(request.url())
      if (pathname === '/admin/plugins/api/docs/get') docsReads.push(request.method())
      if (pathname.startsWith('/plugins/') && pathname.includes('plugin-config')) packageAssets.push(pathname)
    })
    await preferences(page, locale)
    await page.goto(runtime.url)
    await chooseWorkspace(page, runtime, locale)
    await settings(page, locale)
    await section(page, 'plugins')
    const openDetail = (packageId: string) =>
      page.locator(`.plugin-row[data-plugin-id="${packageId}"] .plugin-details-button`).click()
    await openDetail(id)
    expect(docsReads).toEqual([])
    await pluginTab(page, 'docs').press('Enter')

    const docs = page.getByTestId('plugin-docs-detail')
    const article = docs.getByTestId('plugin-docs-markdown')
    await expect(article).toHaveAttribute('lang', locale)
    await expect(
      article.getByRole('heading', { name: locale === 'en' ? 'Queue setup' : '队列设置' }),
    ).toBeVisible()
    await expect(docs.locator(':scope > p').first()).toContainText(
      locale === 'en' ? '**Description stays plain.**' : '**说明是纯文本。**',
    )
    await expect(article.locator('pre code')).toContainText('queue --list')
    await expect(article.locator('table')).toBeVisible()
    await expect(article).toContainText(locale === 'en' ? 'Queue diagram' : '队列示意图')
    await expect(article).toContainText('<b>Literal tag</b>')
    await expect(article.locator('img, iframe, script, style, svg, b, [href], [src]')).toHaveCount(0)
    expect(docsReads).toEqual(['POST'])
    expect(visited).toEqual([])
    const link = article.getByRole('link', { name: locale === 'en' ? /Open guide/ : /打开指南/ })
    await expect(article.getByRole('link')).toHaveCount(1)
    await expect(link).toContainText(`${docsOrigin}/guide`)
    await link.focus()
    const [popup] = await Promise.all([context.waitForEvent('page'), page.keyboard.press('Enter')])
    await expect(popup).toHaveURL(`${docsOrigin}/guide`)
    await popup.waitForLoadState('domcontentloaded')
    expect(await popup.evaluate(() => window.opener === null && document.referrer === '')).toBe(true)
    await popup.close()

    await page.locator('.agh-push-crumbs .agh-push-back:visible').click()
    await expect(docs).toHaveCount(0)
    await openDetail(fallbackId)
    await pluginTab(page, 'docs').click()
    const fallback = docs.getByRole('link', { name: locale === 'en' ? 'Open documentation' : '打开文档' })
    await expect(fallback).toHaveAttribute('href', `${docsOrigin}/fallback`)
    await expect(article).toHaveCount(0)
    expect(visited).toEqual([{ path: '/guide' }])
    const [external] = await Promise.all([context.waitForEvent('page'), fallback.click()])
    await expect(external).toHaveURL(`${docsOrigin}/fallback`)
    await external.close()
    expect(visited).toEqual([{ path: '/guide' }, { path: '/fallback' }])
    expect(docsReads).toEqual(['POST', 'POST'])
    expect(packageAssets).toEqual([])
  })
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`plugin purpose, provides, registered settings and details (${locale})`, async ({ page, runtime }) => {
    const client = await runtime.connect()
    const pkg = await install(client, 'tools/e2e-web/fixtures/plugin-config')
    await preferences(page, locale)
    await page.goto(runtime.url)
    await chooseWorkspace(page, runtime, locale)
    await settings(page, locale)
    await section(page, 'plugins')
    const row = page.locator(`.plugin-row[data-plugin-id="${pkg.id}"]`)
    await expect(row.getByTestId('plugin-summary')).toHaveText(
      locale === 'en' ? 'Coordinates sample work queues for a team.' : '协调团队的样例任务队列。',
    )
    await expect(row.getByTestId('plugin-declared-provides')).toHaveText(
      locale === 'en' ? 'Includes: Service' : '包含：服务',
    )
    const source = row.getByTestId('plugin-source-badge')
    await expect(source).toHaveAttribute('data-origin', 'local-source')
    await expect(source).toHaveText(locale === 'en' ? 'Local' : '本地')
    await expect(row.getByTestId('plugin-registered-provides')).toHaveCount(0)
    await page.getByTestId('plugin-add-more').click()
    await expect(page.getByTestId('plugin-install-source')).toBeVisible()
    await expect(page.getByTestId('plugin-creator')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByTestId('plugin-filter').click()
    const capability = page.getByRole('combobox', {
      name: locale === 'en' ? 'Capability' : '能力',
      exact: true,
    })
    await capability.click()
    await page.getByRole('option', { name: locale === 'en' ? 'Tool' : '工具', exact: true }).click()
    await expect(row).toHaveCount(0)
    await capability.click()
    await page.getByRole('option', { name: locale === 'en' ? 'Service' : '服务', exact: true }).click()
    await expect(row).toHaveCount(1)
    await page.getByTestId('plugin-filter').click()
    const search = page.locator('#plugin-search')
    await search.fill(locale === 'en' ? 'sample work queues' : '样例任务队列')
    await expect(row).toHaveCount(1)
    await search.fill(locale === 'en' ? 'Settings' : '设置')
    await expect(row).toHaveCount(1)
    await search.fill('no-such-purpose')
    await expect(row).toHaveCount(0)
    await search.fill('')
    await page.setViewportSize({ width: 390, height: 844 })
    await row.locator('.plugin-details-button').focus()
    await page.keyboard.press('Enter')
    const detail = page.getByTestId('plugin-purpose-detail')
    await expect(detail).toBeVisible()
    await expect(detail.getByTestId('plugin-overview')).toContainText(
      locale === 'en' ? 'Demonstrates configurable work queues' : '演示可配置的任务队列',
    )
    for (const name of ['provides', 'appears'])
      await expect(detail.getByTestId(`plugin-${name}-detail`)).toBeVisible()
    await expect(detail.getByTestId('plugin-appears-detail')).toContainText(
      locale === 'en' ? 'Settings' : '设置页',
    )
    await pluginTab(page, 'permissions').click()
    await expect(page.getByTestId('plugin-permissions-detail')).toBeVisible()
    await pluginTab(page, 'versions').click()
    await expect(page.getByTestId('plugin-versions-detail')).toBeVisible()
    await pluginTab(page, 'config').click()
    await expect(page.getByTestId('plugin-settings-detail')).toBeVisible()
    await expect(page.getByTestId('plugin-config-field/name')).toHaveValue('Support')
    await page.getByTestId('plugin-config-field/name').fill('Unsaved purpose draft')
    // Overview is clipped after scrolling the phone tab strip; keyboard focus reveals it.
    await pluginTab(page, 'details').focus()
    await pluginTab(page, 'details').press('Enter')
    await pluginTab(page, 'config').click()
    await expect(page.getByTestId('plugin-config-field/name')).toHaveValue('Unsaved purpose draft')
  })
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`skill folders scan real files and retry safely (${locale})`, async ({ page, context, runtime }) => {
    const team = join(runtime.workspace, 'team-skills')
    const missing = join(runtime.workspace, 'missing-skills')
    const valid = (name: string) =>
      `---\nname: ${name}\ndescription: Offline scan fixture\n---\nPRIVATE_SKILL_BODY\n`
    await mkdir(team)
    await writeFile(join(team, 'valid.md'), valid('scan-readable'))
    await writeFile(
      join(team, 'invalid.md'),
      '---\nname: scan-broken\ndescription: []\n---\nPRIVATE_SKILL_BODY\n',
    )
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: runtime.url })
    await preferences(page, locale)
    await page.goto(runtime.url)
    await chooseWorkspace(page, runtime, locale)
    await settings(page, locale)
    await section(page, 'skills')
    const folders = page.getByTestId('skill-folders')
    await page.getByTestId('skill-folders-toggle').click()
    await folders.getByTestId('context-skill-roots').fill(`${team}\n${missing}`)
    await folders.getByTestId('skill-folders-save').click()
    const feedback = folders.getByTestId('skill-scan-feedback')
    await expect(feedback).toContainText(
      locale === 'en' ? 'Found 1 valid skill files; skipped 1.' : '发现 1 项有效技能文件，跳过 1 项。',
    )
    await expect(feedback).toContainText(locale === 'en' ? 'The folder does not exist' : '目录不存在')
    await expect(feedback).toContainText(locale === 'en' ? 'invalid metadata' : '元数据格式无效')
    await folders.getByTestId('skill-scan-copy').click()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(JSON.parse(copied)).toMatchObject({
      complete: false,
      foundCount: 1,
      skippedCount: 1,
      unreadableDirectoryCount: 1,
      directories: expect.arrayContaining([
        expect.objectContaining({ issues: [{ code: 'directory-missing', stage: 'list', osCode: 'ENOENT' }] }),
      ]),
    })
    for (const secret of [team, missing, 'valid.md', 'invalid.md', 'PRIVATE_SKILL_BODY'])
      expect(copied).not.toContain(secret)
    // The retry must read changed files, rather than reuse the preceding scan's cached observation.
    await mkdir(missing)
    await writeFile(join(team, 'invalid.md'), valid('scan-repaired'))
    await writeFile(join(team, 'new.md'), valid('scan-new'))
    await folders.getByTestId('skill-scan-retry').click()
    await expect(feedback).toContainText(locale === 'en' ? 'Folder scan complete.' : '目录扫描完成。')
    await expect(feedback).toContainText(
      locale === 'en' ? 'Found 3 valid skill files; skipped 0.' : '发现 3 项有效技能文件，跳过 0 项。',
    )
    await expect(feedback).not.toContainText(locale === 'en' ? 'The folder does not exist' : '目录不存在')
  })
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`skills teach creation and expose review tabs (${locale})`, async ({ page, runtime }) => {
    await preferences(page, locale)
    await page.goto(runtime.url)
    await chooseWorkspace(page, runtime, locale)
    await settings(page, locale)
    await section(page, 'skills')
    const list = page.locator('.plugins-page-resources .plugin-list')
    await expect(page.getByTestId('skill-new')).toBeVisible()
    await page.getByTestId('plugins-tab-review').click()
    await expect(page.getByTestId('plugin-candidates')).toBeVisible()
    await page
      .getByTestId('review-view')
      .getByRole('radio', { name: locale === 'en' ? 'Feedback' : '反馈记录', exact: true })
      .check()
    await expect(page.getByTestId('feedback-admin')).toBeVisible()
    await page.getByTestId('plugins-tab-skills').click()
    await list.locator('#skill-search').fill('no-such-skill')
    await expect(
      list.getByRole('heading', {
        name: locale === 'en' ? 'No matching skills' : '没有匹配的技能',
        exact: true,
      }),
    ).toBeVisible()
    await expect(list).not.toContainText('AGNES_SKILLS_IMPORT_USER')
    await list.locator('#skill-search').fill('')
    await list.getByTestId('skill-locations').click()
    await expect(page.locator('.agnes-ui-popover')).toBeVisible()
  })
}
