import { readdirSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { Page } from '@playwright/test'
import { installDeveloperExample } from './developer-example.js'
import { expect, test } from './fixtures.js'
import { readSessionEvents } from './ledger.js'
import { chooseWorkspace, expand, expandActivityGroups, homePage, preferences, send } from './ui.js'

type Launch = { title?: { en: string }; prompt?: { text: { en: string } }; pages?: string[] }
type Manifest = {
  name: string
  agnes?: {
    bundles?: Record<string, { launch?: Launch; profile?: { tools?: string[] } }>
    application?: { workbench?: unknown; defaultAgent?: string }
  }
}
/** The package's application, when it ships one: its roles start from its card or its workbench. */
type Application = { id: string; workbench: boolean }
const real = process.env.AGH_REAL_AGENT_SWEEP === '1'
const filter = process.env.AGH_AGENT_FILTER?.split(',')

// Enumerate declarations, including additions outside examples/fde; fixture-only packages have no launch.
function agents(
  directory = 'examples',
): { directory: string; ref: string; launch: Launch; tools?: string[]; application?: Application }[] {
  const found: ReturnType<typeof agents> = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !['node_modules', 'dist'].includes(entry.name))
      found.push(...agents(join(directory, entry.name)))
    else if (entry.name === 'package.json') {
      const manifest: Manifest = JSON.parse(readFileSync(join(directory, entry.name), 'utf8'))
      const declared = manifest.agnes?.application
      const application = declared && { id: manifest.name, workbench: declared.workbench !== undefined }
      // A role without a sample draft (DevBoard's delegates) is started by its coordinator, never
      // from the gallery, so the sweep has no task to give it.
      for (const [id, bundle] of Object.entries(manifest.agnes?.bundles ?? {}))
        if (bundle.launch?.prompt)
          found.push({
            directory,
            ref: `${manifest.name}#${id}`,
            launch: bundle.launch,
            ...(bundle.profile?.tools ? { tools: bundle.profile.tools } : {}),
            ...(application ? { application } : {}),
          })
    }
  }
  return found.sort((a, b) => a.ref.localeCompare(b.ref))
}

async function answerControls(page: Page) {
  const allow = page.getByTestId('approval-action').filter({ hasText: /^Allow once$/ })
  if (await allow.first().isVisible()) {
    await allow.first().click()
    return
  }
  const question = page.getByTestId('question-card')
  if (await question.isVisible()) {
    const choices = question.getByRole('radio')
    if (await choices.count()) await choices.first().check()
    const next = question.getByTestId('question-next')
    if (await next.isVisible()) await next.click()
    else if (await question.getByTestId('question-submit').isEnabled())
      await question.getByTestId('question-submit').click()
    return
  }
  // Finance's declared interactive review has its own ordinary, permission-checked action.
  const inline = page
    .getByTestId('intelligent-ui-inline')
    .filter({ hasText: 'Finance reconciliation' })
    .last()
  const expand = inline.getByTestId('ui-expand').last()
  if (await expand.isVisible()) await expand.click()
  // The caller polls: a control that the previous click has already disabled or replaced is
  // answered, so hand back to the loop instead of waiting on it.
  const settledClick = (control: import('@playwright/test').Locator) =>
    control.click({ timeout: 2_000 }).catch(async (error: unknown) => {
      if ((await control.isVisible()) && (await control.isEnabled())) throw error
    })
  const action = page.getByTestId('intelligent-ui-panel').getByTestId('ui-action-approve').first()
  if ((await action.isVisible()) && (await action.isEnabled())) await settledClick(action)
  const confirm = page.getByTestId('ui-confirm').first()
  if ((await confirm.isVisible()) && (await confirm.isEnabled())) await settledClick(confirm)
}

/** Adopts an application from its gallery card; adoption reloads the shell with its identity. */
async function adopt(page: Page, packageId: string) {
  await homePage(page, 'agents')
  await page
    .locator(`[data-application="${packageId}"]`)
    .getByRole('button', { name: /^(Install and adopt|Adopt)$/ })
    .click()
  const install = page.getByRole('button', { name: 'Install, trust and enable', exact: true })
  const consent = page.getByRole('region', { name: 'Application consent preview', exact: true })
  await expect(install.or(consent)).toBeVisible({ timeout: 90_000 })
  if (await install.isVisible()) await install.click()
  const confirm = consent.getByRole('button', { name: 'Adopt', exact: true })
  await expect(confirm).toBeEnabled({ timeout: 90_000 })
  const reload = page.waitForEvent('load')
  await confirm.click()
  await reload
}

const catalog = agents()
catalog.push({
  directory: '',
  ref: 'builtin:general',
  launch: { prompt: { text: { en: 'call read {"path":"report.md"}' } } },
})
// One worker owns this file even in the parallel browser gate; each case owns a fresh daemon home.
test.describe('shipped agent acceptance', () => {
  // Playwright's SW-block init script reads navigator.serviceWorker in opaque frames.
  // Those frames already forbid service workers; leave their sandbox intact.
  test.use({ serviceWorkers: 'allow' })
  test.describe.configure({ mode: 'default' })
  for (const agent of catalog.filter((agent) => !filter || filter.some((id) => agent.ref.includes(id))))
    test(`agent launch sweep: ${agent.ref}`, async ({ page, runtime }, info) => {
      test.setTimeout(9 * 60_000)
      const client = await runtime.connect()
      if (real) {
        if (!process.env.AGH_DEMO_API_KEY) throw new Error('Explicit real sweep requires AGH_DEMO_API_KEY')
        await client.config.save({
          providerId: 'deepseek',
          model: 'deepseek-flash',
          apiKey: process.env.AGH_DEMO_API_KEY,
          accountId: 'sweep',
          label: 'Isolated agent sweep',
          makeDefault: true,
          expectedRevision: (await client.config.get()).revision,
        })
      }
      await preferences(page)
      await page.goto(runtime.url)
      if (real) await chooseWorkspace(page, runtime)
      else {
        const guide = page.getByTestId('first-run-guide')
        await page.getByTestId('first-run-demo').click()
        await page.getByTestId('first-run-next').click()
        await guide
          .getByRole('button', { name: 'Enter a folder if the picker is unavailable', exact: true })
          .click()
        await guide.getByRole('textbox', { name: 'Folder path', exact: true }).fill(runtime.workspace)
        await guide.getByRole('button', { name: 'Use folder', exact: true }).click()
        await page.getByTestId('first-run-next').click()
        await page.getByTestId('first-run-next').click()
        await expect(guide).toBeHidden()
      }
      console.log(`Sweep ${agent.ref}: ${runtime.home}; ${runtime.url}`)
      const browserErrors: string[] = []
      page.on('pageerror', (error) => browserErrors.push(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error') browserErrors.push(message.text())
      })
      const budgetFile = join(info.project.outputDir, 'agent-sweep-budget.json')
      let totalUsd = Number(process.env.AGH_AGENT_PRIOR_USD ?? 0)
      if (real) {
        try {
          totalUsd = JSON.parse(await readFile(budgetFile, 'utf8')).totalUsd
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      if (!Number.isFinite(totalUsd) || totalUsd < 0) throw new Error('Invalid recorded sweep budget')
      const started = Date.now()
      const errorOffset = browserErrors.length
      const row: Record<string, unknown> = {
        ref: agent.ref,
        home: runtime.home,
        url: runtime.url,
        nodeVersion: process.version,
        status: 'fail',
      }
      let session: Awaited<ReturnType<typeof client.session.load>> | undefined
      let runTimer: ReturnType<typeof setTimeout> | undefined
      try {
        if (totalUsd > 5) throw new Error('AGH-recorded $5 budget exhausted')
        if (agent.ref.startsWith('@acme/')) {
          await homePage(page, 'plugins')
          await page.getByTestId('plugin-install-source').click()
          const source = page.getByRole('dialog', { name: 'Check a plugin source', exact: true })
          await source.getByRole('combobox', { name: 'Source type', exact: true }).selectOption('file')
          await source
            .getByRole('textbox', { name: 'Source reference', exact: true })
            .fill(`file:${resolve(agent.directory).split(sep).join('/')}`)
          await source.getByRole('button', { name: 'Check source', exact: true }).click()
          await page
            .getByTestId('install-review')
            .getByRole('button', { name: 'Install and enable', exact: true })
            .click()
          await expect(page.getByTestId('install-review')).toBeHidden({ timeout: 90_000 })
          await expect
            .poll(
              async () =>
                (await client.packages.list({ profile: 'local-dev' })).packages.find(
                  (row) => row.id === '@acme/operations',
                )?.actual,
              { timeout: 90_000 },
            )
            .toBe('running')
        }
        if (agent.directory.startsWith(join('examples', 'fde') + sep))
          await installDeveloperExample(page, agent.directory)
        const general = agent.ref === 'builtin:general'
        const draft = agent.launch.prompt?.text.en
        if (!draft) throw new Error('Every swept agent must provide its own sample draft')
        const workbench = agent.application?.workbench === true
        if (workbench && agent.application) {
          // A workbench application's roles start inside it: adopt it, then pick the role from the
          // composer's agent menu.
          await adopt(page, agent.application.id)
          // The adopted shell opens on the application's home page; the composer belongs to a draft.
          await page.getByRole('button', { name: 'New conversation', exact: true }).click()
          await page.getByTestId('composer-agent').click()
          await page.getByTestId('new-session-agent').click()
          // antd keeps a hidden accessible copy of the options; click the visible item.
          await page
            .locator('.ant-select-item-option')
            .getByText(agent.launch.title?.en ?? agent.ref, { exact: true })
            .click()
        } else if (agent.application) {
          // An application without a workbench lists its roles on its own gallery card.
          await homePage(page, 'agents')
          const card = page.locator(`[data-application="${agent.application.id}"]`)
          await card.getByRole('button', { name: / role agents?$/ }).click()
          await card
            .getByRole('listitem')
            .filter({ hasText: agent.launch.title?.en ?? agent.ref })
            .getByRole('button', { name: 'Start now', exact: true })
            .click()
        } else {
          await homePage(page, 'agents')
          const card = general
            ? page.getByTestId('general-agent')
            : page.locator(`[data-agent-ref="${agent.ref}"]`)
          await card
            .getByRole('button', { name: general ? 'Start conversation' : 'Start now', exact: true })
            .click()
        }
        const review = page.getByTestId('agent-launch-review')
        const composer = page.getByRole('textbox', { name: 'Task content', exact: true })
        if (!general) {
          const install = page.getByTestId('agent-start-confirm')
          const gate = install.or(review).or(page.getByTestId('agent-launch-retry'))
          await expect
            .poll(
              async () =>
                (await gate.isVisible()) ||
                (workbench && (await composer.isVisible()) && (await composer.inputValue()) === draft),
              { timeout: 90_000 },
            )
            .toBe(true)
          if (await page.getByTestId('agent-launch-retry').isVisible())
            throw new Error(await page.locator('[data-testid=home-page-agents]').innerText())
          if (await install.isVisible()) await install.click()
        }
        // Adopting a workbench application already reviewed and consented to its roles' launch.
        if (workbench && !(await review.isVisible())) {
          await expect(review).toHaveCount(0)
          row.review = 'Covered by the application adoption consent.'
        } else if (!general) {
          await expect(review).toBeVisible({ timeout: 90_000 })
          await expect(review).toContainText(draft)
          for (const label of ['Agent', 'Task', 'Access', 'Next']) await expect(review).toContainText(label)
          await expand(review.getByTestId('launch-technical'))
          const plan = JSON.parse(await review.getByTestId('launch-technical').locator('pre').innerText())
          expect(plan).toMatchObject({
            ref: agent.ref,
            model: { model: real ? 'deepseek-flash' : 'demo-model' },
            // A role that declares its tools is granted exactly those; otherwise the base tools.
            permission: {
              readOnly: expect.any(Boolean),
              tools: expect.arrayContaining(agent.tools ?? ['read']),
            },
            sources: expect.arrayContaining([expect.objectContaining({ id: agent.ref.split('#')[0] })]),
          })
          row.review = await review.innerText()
          await page.screenshot({
            path: info.outputPath(`${agent.ref.split('/').at(-1)?.split('#')[0]}-review.png`),
          })
          await page.getByTestId('agent-launch-confirm').click()
        } else
          row.review =
            'Built-in direct Loop selection; no Bundle launch or launch.prompt. Synthetic read-only smoke prompt.'
        if (general) await chooseWorkspace(page, runtime)
        await expect(composer).toHaveValue(general ? '' : draft, { timeout: 90_000 })
        if (general) await send(page, draft)
        const id = new URL(page.url()).searchParams.get('session')
        if (!id) throw new Error('Launch did not select a session')
        row.sessionId = id
        session = await client.session.load(id, { cwd: runtime.workspace })
        if (!general) expect((await session.projectUI()).turns).toHaveLength(0)
        row.capabilities = await session.capabilities()
        runTimer = setTimeout(() => {
          void session?.cancel()
        }, 6 * 60_000)
        if (!general) await send(page, draft)
        const deadline = Date.now() + 6 * 60_000
        while (Date.now() < deadline) {
          await answerControls(page)
          const timeline = await session.projectUI(undefined, { surface: 'web' })
          if (totalUsd + (timeline.usage?.cost?.usdMicros ?? 0) / 1e6 > 5) {
            await session.cancel()
            throw new Error('AGH-recorded $5 budget exhausted')
          }
          const last = timeline.turns.at(-1)
          if (last?.status === 'failed' || last?.status === 'cancelled')
            throw new Error(`Turn ${last.status}`)
          if (last?.status === 'completed' && !(await page.getByTestId('question-card').isVisible())) break
          await page.waitForTimeout(500)
        }
        const timeline = await session.projectUI(undefined, { surface: 'web' })
        row.timeline = timeline
        expect(timeline.turns.at(-1)?.status, 'Six-minute completion cap').toBe('completed')
        // The session runs the launched role, not the general assistant.
        if (!general) expect((await client.session.runtime(id)).preset?.bundles).toContain(agent.ref)
        // A showcase role's draft is a natural-language business task. The offline teaching model
        // performs no reasoning, so it cannot choose that role's tools: here the sweep proves adoption,
        // launch and completion, and the real-model sweep (AGH_REAL_AGENT_SWEEP=1) proves the tool work.
        const planned = real || !workbench
        if (!planned)
          info.annotations.push({
            type: 'offline-demo',
            description: `${agent.ref}: tool use is checked only by the real-model sweep`,
          })
        const tools = timeline.nodes.filter((node) => node.kind === 'tool')
        row.tools = []
        for (const node of tools) {
          if (node.kind !== 'tool' || node.resultSeq === undefined) continue
          const detail = await session.readToolDetail(node.seq, node.resultSeq)
          ;(row.tools as unknown[]).push({ name: node.name, result: detail.result })
          // read-before-write may legitimately observe a missing new report.
          if (node.name === 'read' && detail.result?.isError)
            expect(detail.result.content).toEqual([
              expect.objectContaining({ type: 'text', text: expect.stringContaining('ENOENT') }),
            ])
          else if (planned)
            expect(detail.result?.isError, `${node.name}: ${JSON.stringify(detail.result)}`).not.toBe(true)
        }
        if (agent.ref.startsWith('@agnes-fde/')) {
          expect(tools.some((node) => node.kind === 'tool' && node.name === 'present')).toBe(true)
          await expect(
            page.getByTestId('conversation-turn').getByText('report.md', { exact: true }).first(),
          ).toBeVisible()
        } else if (agent.ref.startsWith('@acme/'))
          expect(tools.some((node) => node.kind === 'tool' && node.name === 'acme_status')).toBe(true)
        else if (!general) {
          if (planned) expect(tools.length).toBeGreaterThan(0)
        } else expect(tools.some((node) => node.kind === 'tool' && node.name === 'read')).toBe(true)
        if (agent.ref.includes('support-triage')) {
          for (const process of await page.getByTestId('turn-process-toggle').all())
            if (await process.isVisible()) await expand(process.locator('..'))
          for (const turn of await page.getByTestId('conversation-turn').all())
            if (await turn.getByTestId('turn-process-toggle').isVisible()) await expandActivityGroups(turn)
          const label = 'Support triage'
          await expect(page.getByRole('region', { name: label, exact: true }).first()).toBeVisible()
          row.panel = label
        }
        if (agent.ref.includes('finance-reconcile')) {
          // Each turn keeps its own render of the surface; the latest one carries the reviewed data.
          const frame = page.getByTestId('ui-custom-frame-diff-view').last()
          await expect(frame).toBeVisible({ timeout: 20_000 })
          await expect(frame.contentFrame().getByRole('table')).toContainText('TX-2')
          row.panel =
            'Finance reconciliation: reviewed custom renderer, ledger table, chart, form and revision'
        }
        expect(browserErrors.slice(errorOffset)).toEqual([])
        row.status = 'pass'
      } catch (error) {
        row.error = error instanceof Error ? error.message : String(error)
      } finally {
        clearTimeout(runTimer)
        if (row.status !== 'pass' && session) await session.cancel()
        row.browserErrors = browserErrors.slice(errorOffset)
        await page.screenshot({
          path: info.outputPath(`${agent.ref.split('/').at(-1)?.split('#')[0]}-result.png`),
        })
        const close = page.getByTestId('agent-launch-close')
        if (await close.isVisible()) await close.click()
        if (session) {
          row.timeline ??= await session.projectUI(undefined, { surface: 'web' })
          const events = await readSessionEvents(session)
          const costs = events.filter((event) => event.type === 'cost/ledger')
          row.costs = costs.map((event) => event.data)
          if (
            real &&
            (!costs.length || costs.some((event) => !(event.data as { billing?: unknown }).billing))
          ) {
            row.status = 'fail'
            row.error ??= 'Real inference requires complete AGH billing evidence'
          }
          row.usd = costs.reduce(
            (sum, event) =>
              sum +
              (Number((event.data as { billing?: { usdMicros: number } }).billing?.usdMicros) || 0) / 1e6,
            0,
          )
          totalUsd += Number(row.usd)
          row.ends = events.filter((event) => event.type === 'turn/end').map((event) => event.data)
        }
        row.wallSeconds = Math.round((Date.now() - started) / 1000)
        await writeFile(
          info.outputPath('agent-sweep.json'),
          JSON.stringify(
            { real, totalUsd, catalog: catalog.map((agent) => agent.ref), rows: [row] },
            null,
            2,
          ),
        )
        if (real) await writeFile(budgetFile, JSON.stringify({ totalUsd }))
        console.log(
          `${row.status}: ${agent.ref}; ${row.wallSeconds}s; USD ${row.usd ?? 0}; ${row.error ?? ''}`,
        )
      }

      expect(row.error ?? '', `${agent.ref}: ${row.error ?? ''}`).toBe('')
      expect(totalUsd).toBeLessThanOrEqual(5)
    })
})
