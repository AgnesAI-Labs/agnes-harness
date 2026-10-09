import { realpath } from 'node:fs/promises'
import { expect, test } from './fixtures.js'
import { accessible, screen, translated } from './quality.js'
import { chooseWorkspace, closeSettings, fresh, preferences, section, settings } from './ui.js'

for (const locale of ['en', 'zh-CN'])
  for (const theme of ['light', 'dark'])
    test(`approved file memory across sessions ${locale}/${theme}`, async ({
      page,
      runtime,
      expectedBrowserErrors,
    }, info) => {
      test.setTimeout(120_000)
      const cwd = await realpath(runtime.workspace)
      await preferences(page, locale, theme)
      await page.goto(runtime.url)
      await chooseWorkspace(page, runtime, locale)
      await settings(page, locale)
      await section(page, 'memory')
      await expect(page.getByTestId('memory-panel')).toHaveAttribute('aria-busy', 'false')
      await expect(
        page.getByTestId('settings-page-memory').getByRole('heading', {
          name: locale === 'en' ? 'Memory' : '记忆',
          exact: true,
        }),
      ).toBeVisible()
      await expect(page.getByTestId('settings-page-memory').getByTestId('settings-refresh')).toHaveCount(0)
      await page.getByTestId('memory-workspace').selectOption(cwd)
      await expect(page.getByTestId('memory-mode')).toHaveValue('off')
      await page.getByTestId('memory-mode').selectOption('auto')
      await expect(page.getByTestId('memory-saved')).toBeVisible()
      const client = await runtime.connect()
      const state = await client.request('_agnes/v1/admin.memory', { cwd })
      expect(state.inspection?.settings.mode).toBe('auto')
      const root = state.inspection!.root
      await page.getByTestId('memory-open').click()
      await expect(page.getByTestId('memory-content')).toBeVisible()
      await expect(page.getByTestId('memory-mode')).toBeEnabled()
      await expect(page.getByTestId('memory-size')).toHaveText(
        locale === 'en' ? '0 KB used / 16 KB · Up to 200 lines' : '已用 0 KB / 16 KB · 最多 200 行',
      )
      const positions = await page
        .getByTestId('memory-actions')
        .getByRole('button')
        .evaluateAll((buttons) =>
          buttons.map((button) => ({
            x: button.getBoundingClientRect().x,
            y: button.getBoundingClientRect().y,
          })),
        )
      expect(positions).toHaveLength(2)
      const [first, second] = positions
      if (!first || !second) throw new Error('Expected two memory toolbar buttons')
      expect(second.x).toBeGreaterThan(first.x)
      expect(second.y).toBe(first.y)
      await translated(page)
      await accessible(page, info, 'memory-settings')
      await screen(page, info, `memory-${locale}-${theme}`, [
        page.getByTestId('memory-root'),
        page.getByTestId('memory-workspace'),
      ])
      await page
        .getByTestId('memory-content')
        .evaluate((editor) => editor.scrollIntoView({ block: 'center', behavior: 'instant' }))
      await screen(page, info, `memory-editor-${locale}-${theme}`, [page.getByTestId('memory-root')])
      await closeSettings(page, locale)
      await fresh(page, locale)
      async function send(text: string) {
        const input = page.getByRole('textbox', {
          name: locale === 'en' ? 'Task content' : '任务内容',
          exact: true,
        })
        const turns = page.getByTestId('conversation-turn')
        const before = await turns.count()
        await input.fill(text)
        await input.press('Enter')
        await expect(turns).toHaveCount(before + 1, { timeout: 25_000 })
        await expect(turns.last()).toHaveAttribute('data-status', 'completed', { timeout: 25_000 })
        return turns.last()
      }
      const path = `${root}/MEMORY.md`
      await send(`call write ${JSON.stringify({ path, content: 'Prefer concise synthetic summaries.' })}`)
      const saved = await client.request('_agnes/v1/admin.memory', { cwd, file: 'MEMORY.md' })
      expect(saved.file?.content).toBe('Prefer concise synthetic summaries.')
      expect(saved.inspection?.lastWriter?.turn).toBe(1)
      await fresh(page, locale)
      await expect(await send('show remembered preferences')).toContainText(
        'Prefer concise synthetic summaries.',
      )
      await settings(page, locale)
      await section(page, 'memory')
      await expect(page.getByTestId('memory-panel')).toHaveAttribute('aria-busy', 'false')
      await page.getByTestId('memory-workspace').selectOption(cwd)
      await page.getByTestId('memory-open').click()
      // Establish the editor's old revision before the external edit; a pending read may otherwise
      // observe that edit and make the following save a valid CAS, rather than the intended conflict.
      await expect(page.getByTestId('memory-content')).toHaveValue('Prefer concise synthetic summaries.')
      await expect(page.getByTestId('memory-panel')).toHaveAttribute('aria-busy', 'false')
      await client.request('_agnes/v1/admin.memory', {
        cwd,
        file: 'MEMORY.md',
        content: 'Human edit outside this editor.',
        baseHash: saved.file!.hash,
      })
      await page.getByTestId('memory-content').fill('Stale editor draft must remain.')
      const conflict = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/memory' && response.status() === 400,
      )
      await page.getByTestId('memory-save').click()
      expect((await (await conflict).json()).error.data.cause.code).toBe('MEMORY_CONFLICT')
      expectedBrowserErrors.push(
        'console: Failed to load resource: the server responded with a status of 400 (Bad Request)',
      )
      await expect(page.getByTestId('memory-error')).toBeVisible()
      await expect(page.getByTestId('memory-content')).toHaveValue('Stale editor draft must remain.')
      expect((await client.request('_agnes/v1/admin.memory', { cwd, file: 'MEMORY.md' })).file?.content).toBe(
        'Human edit outside this editor.',
      )
      await page.getByTestId('memory-reload').click()
      await expect(page.getByTestId('memory-content')).toHaveValue('Human edit outside this editor.')
      await page.getByTestId('memory-content').fill('Prefer precise synthetic summaries.')
      await page.getByTestId('memory-save').click()
      await expect(page.getByTestId('memory-saved')).toBeVisible()
      await closeSettings(page, locale)
      await expect(await send('show remembered preferences')).toContainText(
        'Prefer precise synthetic summaries.',
      )
      await settings(page, locale)
      await section(page, 'memory')
      await expect(page.getByTestId('memory-panel')).toHaveAttribute('aria-busy', 'false')
      await page.getByTestId('memory-workspace').selectOption(cwd)
      await page.getByTestId('memory-mode').selectOption('off')
      await expect(page.getByTestId('memory-saved')).toBeVisible()
      await closeSettings(page, locale)
      await expect(await send('show remembered preferences')).not.toContainText(
        'Prefer precise synthetic summaries.',
      )
      for (const command of [
        `call read ${JSON.stringify({ path })}`,
        `call write ${JSON.stringify({ path, content: 'Forbidden replacement' })}`,
        `call edit ${JSON.stringify({ path, edits: [{ oldText: 'precise', newText: 'forbidden' }] })}`,
      ]) {
        // Declared paths are refused by Core preflight before the file tool executes.
        const refused = await send(command)
        await expect(refused).toContainText('E_FS_DENIED')
        await expect(refused).not.toContainText('Prefer precise synthetic summaries.')
        expect(
          (await client.request('_agnes/v1/admin.memory', { cwd, file: 'MEMORY.md' })).file?.content,
        ).toBe('Prefer precise synthetic summaries.')
      }
      expect((await client.request('_agnes/v1/admin.memory', { cwd, file: 'MEMORY.md' })).file?.content).toBe(
        'Prefer precise synthetic summaries.',
      )
    })

test('memory approval and private-store isolation survive full access and off', async ({ runtime }) => {
  const { symlink } = await import('node:fs/promises')
  const { randomUUID } = await import('node:crypto')
  const { prompt } = await import('./sdk.js')
  const client = await runtime.connect('web')
  const cwd = await realpath(runtime.workspace)
  const owner = await runtime.connect()
  const state = await owner.request('_agnes/v1/admin.memory', { cwd, settings: { mode: 'ask' } })
  const path = `${state.inspection!.root}/MEMORY.md`
  const alias = `${cwd}/memory-alias`
  await symlink(state.inspection!.root, alias)
  const session = await client.session.new({ sessionKey: randomUUID(), cwd, preset: 'full-access' })
  let reviews = 0
  const verdict: 'rejected' | 'allowed-once' = 'rejected'
  session.onPermissionRequest(async (request) => {
    reviews++
    expect(request.options.map((option) => option.kind)).toEqual(['allow_once', 'reject_once'])
    expect(request.toolCall.rawInput).toMatchObject({
      path,
      baseHash: expect.any(String),
      newHash: expect.any(String),
      diff: expect.stringContaining('+Prefer concise synthetic summaries.'),
      source: { turn: 1 },
    })
    return { verdict }
  })
  await session.attach()
  let requestedTool = ''
  let lastResultSeq = 0
  const send = async (name: string, args: Record<string, unknown>) => {
    requestedTool = name
    await prompt(session, `call ${name} ${JSON.stringify(args)}`)
  }
  const last = async () => {
    const view = await session.projectUI(undefined, { surface: 'web' })
    const node = view.nodes.findLast((node) => node.kind === 'tool')
    if (node?.kind !== 'tool' || node.resultSeq === undefined) throw new Error('missing tool result')
    expect(node.name).toBe(requestedTool)
    expect(node.resultSeq).toBeGreaterThan(lastResultSeq)
    lastResultSeq = node.resultSeq
    return (await session.readToolDetail(node.seq, node.resultSeq)).result
  }
  await send('write', { path, content: 'Prefer concise synthetic summaries.' })
  expect(await last()).toMatchObject({ isError: true })
  expect(reviews).toBe(1)
  expect((await owner.request('_agnes/v1/admin.memory', { cwd, file: 'MEMORY.md' })).file?.content).toBe('')
  // Human editing uses the supported SDK owner path; no candidate enters context before approval.
  const empty = await owner.request('_agnes/v1/admin.memory', { cwd, file: 'MEMORY.md' })
  await owner.request('_agnes/v1/admin.memory', {
    cwd,
    file: 'MEMORY.md',
    content: 'PRIVATE_MEMORY_E2E',
    baseHash: empty.file!.hash,
  })
  await send('skill_read', { name: 'remembering' })
  expect(JSON.stringify(await last())).toContain('Consolidate')
  for (const mode of ['ask', 'off'] as const) {
    await owner.request('_agnes/v1/admin.memory', { cwd, settings: { mode } })
    for (const target of [path, `${alias}/MEMORY.md`]) {
      await send('shell', { command: `cat '${target}'` })
      const denied = await last()
      expect(denied).toMatchObject({ isError: true })
      expect(JSON.stringify(denied)).not.toContain('PRIVATE_MEMORY_E2E')
      // bubblewrap hides the entire tree; its absent descendant is an ENOENT refusal.
      expect(JSON.stringify(denied)).toMatch(
        /Operation not permitted|Permission denied|No such file or directory|Directory nonexistent|unconfined.*refused|denied|EACCES|EPERM/,
      )
      await send('shell', { command: `printf bypass > '${target}'` })
      const writeDenied = await last()
      expect(writeDenied).toMatchObject({ isError: true })
      expect(JSON.stringify(writeDenied)).toMatch(
        /Operation not permitted|Permission denied|No such file or directory|Directory nonexistent|unconfined.*refused|denied|EACCES|EPERM/,
      )
      expect((await owner.request('_agnes/v1/admin.memory', { cwd, file: 'MEMORY.md' })).file?.content).toBe(
        'PRIVATE_MEMORY_E2E',
      )
    }
    await send('read', { path: `${alias}/MEMORY.md` })
    expect(await last()).toMatchObject({ isError: true })
  }
  // Includes an active-memory turn and any later echo, even after settings are off.
  expect(await runtime.diagnostics()).not.toContain('PRIVATE_MEMORY_E2E')
})
