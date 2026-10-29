/** @vitest-environment happy-dom */

import './terminal-fixture.js'
import type { Session } from '@agnes/sdk/browser'
import { factChainLinks, fileViewerActions } from '@agnes/web-client'
import { createCatalogTranslator, renderRegion, unmountRegion } from '@agnes/web-ui'
import { within } from '@testing-library/dom'
import { flushSync } from 'react-dom'
import { expect, it, vi } from 'vitest'
import { ChangesPanel, ReviewFileAction } from '../src/workbench/changes-panel.js'
import { FilesPanel } from '../src/workbench/files-panel.js'
import { workbenchLocaleCatalog } from '../src/workbench/locales.js'
import { TerminalPanel } from '../src/workbench/terminal-panel.js'

it('loads directories lazily, previews text and mentions a relative path without submitting', async () => {
  const list = vi.fn(async (path: string) => ({
    path,
    truncated: false,
    entries:
      path === ''
        ? [
            { name: 'src', kind: 'directory' },
            { name: 'report.md', kind: 'file' },
          ]
        : [{ name: 'main.ts', kind: 'file' }],
  }))
  const session = {
    id: 's',
    workspaceList: list,
    workspaceRead: vi.fn(async (path) => ({
      path,
      revision: 'source-hash',
      observedAt: '2026-10-08T00:00:00Z',
      text: 'export const answer = 42',
      size: 24,
      binary: false,
      truncated: false,
    })),
  } as unknown as Session
  const removeAction = fileViewerActions.register({
    id: 'test.review',
    order: 1,
    component: ({ path, revision }) => <output>{`${path}:${revision}`}</output>,
  })
  const mention = vi.fn()
  const host = document.createElement('div')
  const header = document.createElement('div')
  header.id = 'test-header'
  document.body.append(header, host)
  try {
    renderRegion(
      host,
      <FilesPanel
        headerId="test-header"
        context={{
          t: createCatalogTranslator(workbenchLocaleCatalog, 'en'),
          data: { session, disabled: false, mention },
        }}
      />,
    )
    await vi.waitFor(() => expect(host.querySelector('[data-path="src"]')).not.toBeNull())
    expect(host.querySelector('[data-path="src/main.ts"]')).toBeNull()
    flushSync(() => (host.querySelector('[data-path="src"]') as HTMLButtonElement).click())
    await vi.waitFor(() => expect(host.querySelector('[data-path="src/main.ts"]')).not.toBeNull())
    flushSync(() => (host.querySelector('[data-path="src/main.ts"]') as HTMLButtonElement).click())
    await vi.waitFor(() => expect(host.querySelector('pre')?.textContent).toBe('export const answer = 42'))
    expect(host.querySelector('pre')?.tabIndex).toBe(0)
    expect(host.querySelector('pre')?.getAttribute('role')).toBe('region')
    flushSync(() => (host.querySelector('[data-testid="file-mention"]') as HTMLButtonElement).click())
    expect(mention).toHaveBeenCalledWith('src/main.ts')
    expect(host.querySelector('output')?.textContent).toBe('src/main.ts:source-hash')
    flushSync(removeAction)
    expect(host.querySelector('output')).toBeNull()
    expect(host.querySelector('textarea')).toBeNull()
    expect(header.querySelector('button')?.getAttribute('aria-label')).toBe('Refresh workspace files')
    expect(header.querySelector('button')?.textContent).toBe('')
    expect(host.querySelector('.workbench-files-footer button, .workbench-files-footer a')).toBeNull()
    expect(host.querySelector('[data-testid="file-meta"]')?.textContent).not.toContain('2026-10-08T')
    expect(host.querySelector('time')?.dateTime).toBe('2026-10-08T00:00:00Z')
    expect(host.querySelector('time')?.title).toBe('source-hash')
  } finally {
    removeAction()
    unmountRegion(host)
    host.remove()
    header.remove()
  }
})

it('orders rapid terminal input, drops unsent input on detach and restores read-only agent tabs', async () => {
  localStorage.clear()
  const human = {
    id: 'human',
    owner: 'human',
    ownerSessionId: 's',
    kind: 'pty',
    command: 'bash',
    shell: 'bash',
    cwd: '/workspace',
    status: 'running',
    code: null,
    truncated: false,
    stdout: 'human output',
    stderr: '',
  }
  const agent = { ...human, id: 'agent', owner: 'agent', stdout: 'agent output' }
  let evicted = false,
    releaseInput: (() => void) | undefined,
    holdInput = false,
    failInput = false
  const releaseHeldInput = () => {
    if (!releaseInput) throw new Error('No input is pending')
    releaseInput()
  }
  const session = {
    id: 's',
    jobsRead: async (id?: string) => {
      if (evicted && id === human.id) throw new Error('Job was evicted')
      return {
        jobs: evicted ? [agent] : [human, agent],
        completions: [],
        ...(id ? { job: id === human.id ? human : agent } : {}),
      }
    },
    jobsControl: async (input: { operation: string; jobId: string; text?: string }) => {
      if (input.operation !== 'send' || input.jobId !== human.id)
        throw new Error('Agent controls must not dispatch')
      if (holdInput) {
        holdInput = false
        await new Promise<void>((resolve) => {
          releaseInput = resolve
        })
      }
      if (failInput) {
        failInput = false
        throw new Error('Input refused')
      }
      human.stdout += input.text ?? ''
      return { output: { ...human } }
    },
  } as unknown as Session
  const host = document.createElement('div')
  document.body.append(host)
  const context = {
    t: createCatalogTranslator(workbenchLocaleCatalog, 'en'),
    data: { session, disabled: false, mention() {}, command() {} },
  }
  try {
    renderRegion(host, <TerminalPanel context={context} />)
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid=terminal-fixture-raw]')?.textContent).toBe('human output'),
    )

    const type = (keys: string[]) => {
      flushSync(() => {
        for (const key of keys)
          host.querySelector('input')?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      })
    }
    holdInput = true
    type(['a', 'b', 'c', 'Enter'])
    await vi.waitFor(() => expect(releaseInput).toBeTypeOf('function'))
    expect(human.stdout).toBe('human output')
    expect(host.querySelector('input')?.disabled).toBe(false)
    releaseHeldInput()
    await vi.waitFor(() => expect(human.stdout).toBe('human outputabc\r'))
    holdInput = true
    failInput = true
    releaseInput = undefined
    type(['d'])
    await vi.waitFor(() => expect(releaseInput).toBeTypeOf('function'))
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'A'.repeat(65536) } })
    flushSync(() => host.querySelector('input')?.dispatchEvent(paste))
    type(['e'])
    expect(host.textContent).toContain(context.t('workbench.terminal.inputFull'))
    releaseHeldInput()
    await vi.waitFor(() => expect(host.textContent).toContain(context.t('workbench.error')))
    expect(human.stdout).toBe('human outputabc\r')
    holdInput = true
    releaseInput = undefined
    type(['x', 'y'])
    await vi.waitFor(() => expect(releaseInput).toBeTypeOf('function'))
    unmountRegion(host)
    releaseHeldInput()
    await vi.waitFor(() => expect(human.stdout).toBe('human outputabc\rx'))
    expect(human.status).toBe('running')
    expect(agent.status).toBe('running')
    renderRegion(host, <TerminalPanel context={context} />)
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid=terminal-fixture-raw]')?.textContent).toBe(
        'human outputabc\rx',
      ),
    )
    flushSync(() =>
      within(host)
        .getByRole('button', { name: /Agent job · Read-only bash/ })
        .click(),
    )
    expect(
      within(host)
        .getByRole('button', { name: /Agent job · Read-only bash/ })
        .getAttribute('aria-pressed'),
    ).toBe('true')
    expect(host.querySelector('input')).toBeNull()
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid=terminal-fixture-raw]')?.textContent).toBe('agent output'),
    )
    expect(host.querySelector('[data-testid="terminal-kill"]')).toBeNull()
    expect(host.querySelector('[data-testid="terminal-interrupt"]')).toBeNull()
    flushSync(() =>
      (
        host.querySelector('[data-active=true] [data-testid="terminal-tab-close"]') as HTMLButtonElement
      ).click(),
    )
    expect(agent.status).toBe('running')
    flushSync(() =>
      within(host)
        .getByRole('button', { name: /^Terminal bash/ })
        .click(),
    )
    expect(
      within(host)
        .getByRole('button', { name: /^Terminal bash/ })
        .getAttribute('aria-pressed'),
    ).toBe('true')
    evicted = true
    await vi.waitFor(
      () => expect(within(host).queryByRole('button', { name: /^Terminal bash/ })).toBeNull(),
      { timeout: 2500 },
    )
    expect(host.textContent).not.toContain('Job was evicted')
  } finally {
    unmountRegion(host)
    host.remove()
    localStorage.clear()
  }
})

it('renders kill receipts immediately, confirms close and selects the remaining terminal', async () => {
  localStorage.clear()
  const jobs = ['first', 'second'].map((id) => ({
    id,
    owner: 'human' as const,
    ownerSessionId: 's',
    kind: 'pty' as const,
    command: id,
    cwd: '/workspace',
    status: 'running' as 'running' | 'killed',
    code: null as number | null,
    truncated: false,
    stdout: `${id} output`,
    stderr: '',
  }))
  let holdPolling = false
  const jobsControl = vi.fn(async (input: { jobId: string }) => {
    const row = jobs.find((row) => row.id === input.jobId)
    if (!row) throw new Error('Missing job')
    row.status = 'killed'
    row.code = -1
    holdPolling = true
    return { output: { ...row } }
  })
  const session = {
    id: 's',
    jobsRead: async (id?: string) => {
      if (holdPolling) await new Promise<void>(() => {})
      return { jobs, completions: [], job: jobs.find((row) => row.id === id) }
    },
    jobsControl,
  } as unknown as Session
  const host = document.createElement('div')
  document.body.append(host)
  try {
    renderRegion(
      host,
      <TerminalPanel
        context={{
          t: createCatalogTranslator(workbenchLocaleCatalog, 'en'),
          data: { session, disabled: false },
        }}
      />,
    )
    await vi.waitFor(() => expect(host.textContent).toContain('first output'))
    flushSync(() =>
      within(host)
        .getByRole('button', { name: /^Terminal first/ })
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })),
    )
    await vi.waitFor(() => expect(document.querySelector('[data-testid=terminal-kill]')).not.toBeNull())
    flushSync(() => (document.querySelector('[data-testid=terminal-kill]') as HTMLElement).click())
    expect(jobsControl).not.toHaveBeenCalled()
    flushSync(() => within(document.body).getByRole('button', { name: 'Kill process' }).click())
    await vi.waitFor(() => expect(host.textContent).toContain('Process exited (-1)'))
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLButtonElement>('[data-testid=terminal-tab-close]')?.disabled).toBe(false),
    )
    flushSync(() => (host.querySelector('[data-testid=terminal-tab-close]') as HTMLButtonElement).click())
    await vi.waitFor(() =>
      expect(within(host).getAllByRole('button', { name: /^Terminal (first|second)/ })).toHaveLength(1),
    )
    await vi.waitFor(() => expect(host.textContent).toContain('second output'))
    expect(within(host).queryByRole('button', { name: /^Terminal first/ })).toBeNull()
    expect(
      within(host)
        .getByRole('button', { name: /^Terminal second/ })
        .getAttribute('aria-pressed'),
    ).toBe('true')
    expect(jobsControl).toHaveBeenCalledWith({ operation: 'kill', jobId: 'first' })
  } finally {
    unmountRegion(host)
    host.remove()
    localStorage.clear()
  }
})

it('navigates from file review, renders a read-only diff and ignores results detached by session switching', async () => {
  const revision = 'a'.repeat(64),
    path = '设计 review.ts',
    mention = vi.fn(),
    openPanel = vi.fn(),
    openRecord = vi.fn(() => false)
  const openFacts = vi.fn(() => false),
    disposeFacts = factChainLinks.register(openFacts)
  const file = {
    path,
    kind: 'added',
    basis: 'session',
    added: 1,
    removed: 0,
    diffStatus: 'available',
    freshness: 'changed',
    afterRevision: revision,
    currentRevision: 'b'.repeat(64),
    effects: [
      {
        callSeq: 4,
        resultSeq: 7,
        receiptSeq: 6,
        toolUseId: 'actual-use',
        laneId: 'main' as string | undefined,
        tool: 'write',
        turn: 1,
        observedAt: '2026-10-09T00:00:00Z',
        decisionId: 'actual-decision',
        enforcement: 'full',
      },
    ],
  }
  const result = {
    scope: 'session',
    revision,
    observedAt: '2026-10-09T00:00:00Z',
    fromSeq: 1,
    toSeq: 7,
    turn: 1,
    truncated: false,
    unrecorded: false,
    files: [file, { ...file, path: 'b.ts' }],
    selected: {
      ...file,
      beforeRevision: revision,
      diff: '--- a\n+++ b\n+<script>plain text</script>\n',
      viewerChanged: true,
    },
  }
  let finishOld: ((value: unknown) => void) | undefined
  const read = vi.fn(async (input: { path?: string }) =>
    input.path === 'b.ts'
      ? new Promise((resolve) => {
          finishOld = resolve
        })
      : result,
  )
  const session = { id: 's', workspaceChanges: read } as unknown as Session
  const context = {
    t: createCatalogTranslator(workbenchLocaleCatalog, 'en'),
    openPanel,
    openRecord,
    selection: { sessionId: 's', path, revision },
    data: {
      session,
      disabled: false,
      mention,
      command: () => {
        throw new Error('Review must never submit')
      },
    },
  }
  const host = document.createElement('div'),
    action = document.createElement('div')
  document.body.append(host, action)
  try {
    renderRegion(action, <ReviewFileAction context={context} path={path} revision={revision} />)
    flushSync(() => (action.querySelector('button') as HTMLButtonElement).click())
    expect(openPanel).toHaveBeenCalledWith('changed-files', { sessionId: 's', path, revision })
    renderRegion(host, <ChangesPanel context={context} />)
    await vi.waitFor(() =>
      expect(host.querySelector('pre')?.textContent).toContain('+<script>plain text</script>'),
    )
    expect(read).toHaveBeenCalledWith({ scope: 'session', path, expectedRevision: revision })
    expect(host.querySelector('[data-testid=changed-file] .workbench-changes-path')?.textContent).toBe(path)
    expect(host.querySelector('.workbench-change-head .workbench-change-name')?.getAttribute('title')).toBe(
      path,
    )
    expect(host.querySelector('script')).toBeNull()
    expect(host.textContent).toContain('changed after the recorded agent edit')
    expect(host.textContent).toContain('changed since the preview was read')
    flushSync(() => (host.querySelector('[data-testid=changes-mention]') as HTMLButtonElement).click())
    expect(mention).toHaveBeenCalledWith(path)
    flushSync(() => (host.querySelector('[data-testid=changes-provenance]') as HTMLButtonElement).click())
    expect(openFacts).toHaveBeenCalledWith(
      {
        sessionId: 's',
        laneId: 'main',
        anchor: { kind: 'tool', toolUseId: 'actual-use' },
      },
      undefined,
    )
    expect(openRecord).not.toHaveBeenCalled()
    expect(host.textContent).toContain('could not be linked')
    openFacts.mockReturnValue(true)
    flushSync(() => (host.querySelector('[data-testid=changes-provenance]') as HTMLButtonElement).click())
    expect(host.textContent).not.toContain('could not be linked')
    file.effects[0]!.laneId = undefined
    openFacts.mockClear()
    flushSync(() => (host.querySelector('[data-testid=changes-provenance]') as HTMLButtonElement).click())
    expect(openFacts).not.toHaveBeenCalled()
    expect(host.textContent).toContain('could not be linked')
    const fileButton = host.querySelector('[data-path="b.ts"]') as HTMLButtonElement
    fileButton.focus()
    flushSync(() => fileButton.click())
    await vi.waitFor(() => expect(finishOld).toBeDefined())
    expect(document.activeElement).toBe(fileButton)
    expect(host.querySelector('pre')).toBeNull()
    const next = {
      id: 'next',
      workspaceChanges: async () => ({
        ...result,
        selected: undefined,
        files: [{ ...file, path: 'owned-next.ts' }],
      }),
    } as unknown as Session
    renderRegion(host, <ChangesPanel context={{ ...context, data: { ...context.data, session: next } }} />)
    await vi.waitFor(() => expect(host.textContent).toContain('owned-next.ts'))
    finishOld?.({ ...result, selected: { ...result.selected, diff: 'STALE_OLD_SESSION' } })
    await vi.waitFor(() => expect(host.textContent).not.toContain('STALE_OLD_SESSION'))
    expect(host.querySelector('textarea')).toBeNull()
  } finally {
    disposeFacts()
    unmountRegion(host)
    unmountRegion(action)
    host.remove()
    action.remove()
  }
})
