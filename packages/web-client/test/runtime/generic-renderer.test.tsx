/** @vitest-environment happy-dom */
import type {
  CommandHandle,
  DomainView,
  Outcome,
  RendererContext,
  RuntimeError,
} from '@agnes/extension-api/client'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GenericDomainView } from '../../src/runtime/renderers/generic.js'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const schema = { typeId: 'acme.notes/publish@1', revision: 1, digest: 'a'.repeat(64) }

function view(phase: DomainView['phase'], revision = 1, extra: Partial<DomainView> = {}): DomainView {
  const value: DomainView = {
    kind: 'domain',
    viewId: 'note-1',
    revision,
    domainType: 'acme.notes',
    viewSchema: { typeId: 'acme.notes/view@1', revision: 1, digest: 'b'.repeat(64) },
    renderKey: 'acme.notes/card',
    scope: {
      kind: 'session',
      installationId: 'install-1',
      runtimeId: 'runtime-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
    },
    source: { eventIds: ['event-1'], projectionRevision: 5 },
    phase,
    fallbackText: 'Draft note',
    data: { html: '<b>x</b>' },
    resources: [],
    actions: [
      {
        kind: 'command',
        actionKey: 'publish',
        label: 'Publish',
        requiredFeatures: [],
        availability: 'enabled',
        disabledReason: null,
        command: 'publish',
        inputSchema: schema,
      },
    ],
    ...extra,
  }
  expect(validateRuntime('DomainView', value).ok).toBe(true)
  return value
}

const refusal = (code: RuntimeError['code'], retry = false): Outcome<CommandHandle> => ({
  ok: false,
  error: {
    code,
    detailCode: code,
    message: `${code} happened`,
    retryAdvice: { kind: retry ? 'retry_same_action' : 'never' },
    diagnosticId: 'generic-test',
  },
})

function contextWith(outcomes: Outcome<CommandHandle>[], locale = 'en') {
  const submit = vi.fn(async () => outcomes.shift() ?? refusal('internal'))
  const commandStatus = vi.fn(async () => outcomes.shift() ?? refusal('internal'))
  return {
    submit,
    commandStatus,
    context: {
      commands: { submit, commandStatus },
      locale: { locale, text: (key: string) => key, formatNumber: () => '', formatDate: () => '' },
    } as unknown as RendererContext,
  }
}

async function show(value: DomainView, context: RendererContext) {
  await act(async () => root.render(<GenericDomainView view={value} context={context} />))
}

const card = () => host.querySelector<HTMLElement>('.generic-domain-view')
const buttons = () => Array.from(host.querySelectorAll('button'))
const status = () => host.querySelector('[role="status"]')?.textContent
async function click(label: string) {
  const button = buttons().find((candidate) => candidate.textContent === label)
  if (!button) throw new Error(`no ${label} button in ${buttons().map((b) => b.textContent)}`)
  await act(async () => button.click())
}

describe('generic domain view', () => {
  it.each(['en', 'zh-CN'])('shows inert fallback text, phase and resources in %s', async (locale) => {
    const { context } = contextWith([], locale)
    const markup = '<b>bold</b><script>alert(1)</script>'
    await show(
      view('finalized', 1, {
        fallbackText: markup,
        resources: [
          {
            artifactId: 'file-1',
            version: 1,
            title: 'report.pdf',
            mime: 'application/pdf',
            size: 1,
            status: 'ready',
          },
          { artifactId: 'file-2', version: 1, title: null, mime: null, size: null, status: 'reserved' },
        ],
      }),
      context,
    )
    expect(host.querySelector('.generic-domain-text')?.textContent).toBe(markup)
    expect(host.querySelector('b, script')).toBeNull()
    expect(Array.from(host.querySelectorAll('li')).map((item) => item.textContent)).toEqual([
      'report.pdf',
      'file-2',
    ])
    const phases: string[] = []
    for (const phase of ['provisional', 'finalized', 'interrupted'] as const) {
      await show(view(phase), context)
      expect(card()?.dataset.phase).toBe(phase)
      phases.push(host.querySelector('.state-light')?.textContent ?? '')
    }
    expect(new Set(phases).size).toBe(3)
    expect(phases[2]).toMatch(locale === 'en' ? /interrupted/i : /已中断/)
    expect(phases).toEqual(
      locale === 'en'
        ? ['StatusIn progress', 'StatusFinal', 'StatusInterrupted, may be incomplete']
        : ['状态进行中', '状态最终结果', '状态已中断，可能不完整'],
    )
    expect(host.querySelector('.state-light')?.getAttribute('data-tone')).toBe('bad')
  })

  it('keeps one request id per click across rerenders and retries, and shows each outcome', async () => {
    const { submit, commandStatus, context } = contextWith([
      refusal('retryable'),
      refusal('unknown_effect'),
      refusal('denied'),
    ])
    await show(view('provisional', 1), context)
    await click('Publish')
    expect(status()).toBe('Refused: retryable happened')
    expect(submit).toHaveBeenCalledTimes(1)
    const [[first]] = submit.mock.calls as unknown as [[{ requestId: string }]]
    expect(first).toEqual({
      action: { viewId: 'note-1', actionKey: 'publish', viewRevision: 1 },
      commandSchema: schema,
      input: { kind: 'inline', schema, value: {}, digest: canonicalJsonDigest({}), bytes: 2 },
      requestId: first.requestId,
      expectedRevision: 5,
    })

    // A newer revision of the view rerenders the card; the pending retry keeps its request id.
    await show(view('provisional', 2), context)
    expect(submit).toHaveBeenCalledTimes(1)
    await click('Retry Publish')
    const second = submit.mock.calls[1] as unknown as [
      { requestId: string; action: { viewRevision: number } },
    ]
    expect(second[0].requestId).toBe(first.requestId)
    expect(second[0].action.viewRevision).toBe(2)

    // Unknown effect is not a failure: the card offers a status read, never a resubmit.
    expect(card()?.querySelector('[data-state]')?.getAttribute('data-state')).toBe('unknown')
    expect(status()).toMatch(/unknown/i)
    expect(buttons().find((button) => button.textContent === 'Publish')?.disabled).toBe(true)
    await click('Check status')
    expect(commandStatus).toHaveBeenCalledWith(first.requestId)
    expect(submit).toHaveBeenCalledTimes(2)
    expect(status()).toBe('Refused: denied happened')
    await show(view('provisional', 2), { ...context, locale: { ...context.locale, locale: 'zh-CN' } })
    expect(status()).toBe('已拒绝：denied happened')
    expect(submit).toHaveBeenCalledTimes(2)
    expect(commandStatus).toHaveBeenCalledWith(first.requestId)
  })

  /** The fixture's enabled command action. */
  function publishAction() {
    const [publish] = view('finalized').actions
    if (publish?.kind !== 'command') throw new Error('the fixture has no command action')
    return publish
  }

  // Unknown action (case 4): an enabled action of a kind this client does not know, forged past
  // validation, is shown by its label and never becomes a control that submits.
  it('shows an action of an unknown kind but never submits it', async () => {
    const { submit, commandStatus, context } = contextWith([])
    const forged = { ...publishAction(), kind: 'script', actionKey: 'run', label: 'Run' }
    const actions = [forged as unknown as DomainView['actions'][number]]
    await show({ ...view('finalized'), actions }, context)
    expect(host.querySelector('.generic-domain-text')?.textContent).toBe('Draft note')
    const [run] = buttons()
    expect(buttons()).toHaveLength(1)
    expect(run?.textContent).toBe('Run')
    expect(run?.disabled).toBe(true)
    await act(async () => run?.click())
    expect(submit).not.toHaveBeenCalled()
    expect(commandStatus).not.toHaveBeenCalled()
  })

  it('offers a command only once every feature it needs was negotiated', async () => {
    const batch = {
      ...publishAction(),
      actionKey: 'batch',
      label: 'Send to all',
      requiredFeatures: ['acme.batch'],
    }
    const shown = { ...view('finalized'), actions: [batch] }
    const { submit, context } = contextWith([])
    await show(shown, context)
    const [unnegotiated] = buttons()
    expect(unnegotiated?.disabled).toBe(true)
    expect(host.querySelector('.generic-domain-action')?.textContent).toBe('Send to allNot available here.')
    await act(async () => unnegotiated?.click())
    expect(submit).not.toHaveBeenCalled()

    const negotiated = {
      ...context,
      capabilities: { features: ['acme.batch'] },
    } as unknown as RendererContext
    await show(shown, negotiated)
    expect(buttons()[0]?.disabled).toBe(false)
  })

  // HTML in server strings (case 5): markup in the fallback text, resource titles, labels, disabled
  // reasons and action keys stays text; no element, event attribute or link is built from it.
  it('shows markup in every view string as text', async () => {
    const { context } = contextWith([])
    const markup = '<img src=x onerror=alert(1)><a href="javascript:alert(1)">go</a>'
    const publish = publishAction()
    const injected = 'x" onclick="alert(1)'
    await show(
      view('finalized', 1, {
        fallbackText: markup,
        resources: [
          { artifactId: 'file-1', version: 1, title: markup, mime: 'text/html', size: 1, status: 'ready' },
        ],
        actions: [
          { ...publish, actionKey: injected, label: markup },
          { ...publish, actionKey: 'lock', label: 'Lock', availability: 'disabled', disabledReason: markup },
        ],
      }),
      context,
    )
    expect(host.querySelector('.generic-domain-text')?.textContent).toBe(markup)
    expect(host.querySelector('li')?.textContent).toBe(markup)
    expect(buttons().map((button) => button.textContent)).toEqual([markup, 'Lock'])
    expect(host.querySelector('.generic-domain-action span:not([role])')?.textContent).toBe(markup)
    expect(host.querySelector('[data-action-key]')?.getAttribute('data-action-key')).toBe(injected)
    expect(host.querySelector('img, a, script, [onerror], [onclick], [href]')).toBeNull()
  })

  it('shows pending and done handles and starts a new request after a settled one', async () => {
    const handle = (status: 'accepted' | 'succeeded', requestId: string): Outcome<CommandHandle> => ({
      ok: true,
      value: {
        commandId: 'command-1',
        requestId,
        revision: 1,
        completion: 'domain-commit',
        status,
        result: null,
        error: null,
      },
    })
    const { submit, commandStatus, context } = contextWith([
      handle('accepted', 'x'),
      handle('succeeded', 'x'),
    ])
    await show(view('finalized'), context)
    await click('Publish')
    expect(status()).toBe('Pending.')
    await click('Check status')
    expect(status()).toBe('Done.')
    await click('Publish')
    const ids = submit.mock.calls.map((call) => (call as unknown as [{ requestId: string }])[0].requestId)
    expect(commandStatus).toHaveBeenCalledWith(ids[0])
    expect(ids).toHaveLength(2)
    expect(ids[1]).not.toBe(ids[0])
  })
})
