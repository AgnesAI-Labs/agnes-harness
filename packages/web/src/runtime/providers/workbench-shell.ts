// The Web app's built-in workbench as a ShellProvider: the sidebar and the main area with its top bar,
// session tabs, conversation, trace, extension panel, approval and composer. Mounting lays that layout
// out in the container the shell is given, with element ids minted for that mount, and hands the
// regions to the host, which mounts its client-module regions into them. Until the session behavior
// moves behind ShellServices it stays with the host; the shell owns its layout and the view state it
// can carry, the composer draft.
//
// The page notices live outside any shell, so they can still report a shell that failed to mount. While
// mounted, the workbench shows them under its top bar; when it goes, any it still holds go just before
// its container, outside every shell, unless the shell replacing it has taken them already.
import type {
  Outcome,
  RuntimeError,
  SchemaRef,
  ShellProvider,
  ShellViewState,
} from '@agnes/extension-api/client'
import { applyLocaleText } from '../../locale-preference.js'

/** The workbench elements a host mounts its regions into. */
export interface WorkbenchRegions {
  readonly sidebar: HTMLElement
  readonly main: HTMLElement
  readonly topbar: HTMLElement
  readonly chatTab: HTMLButtonElement
  readonly traceTab: HTMLButtonElement
  readonly reportProblem: HTMLButtonElement
  readonly conversation: HTMLElement
  readonly trace: HTMLElement
  readonly rightbar: HTMLElement
  readonly approval: HTMLElement
  readonly composer: HTMLElement
}

/** What a host set up in a mounted workbench. */
export interface WorkbenchMount {
  /** Looks up the workbench's own static text, marked with `data-i18n` attributes. */
  translate(key: string): string
  draft(): string
  setDraft(draft: string): void
  dispose(): Promise<void>
}

export interface WorkbenchHost {
  /** Page notices the workbench shows under its top bar while it is mounted. */
  readonly notices: readonly HTMLElement[]
  mount(regions: WorkbenchRegions): Promise<WorkbenchMount>
}

// Revision 1 of the view state. The digest is canonicalJsonDigest of {"draft":"string"}; a new data
// shape takes a new revision and digest.
const STATE_SCHEMA: SchemaRef = {
  typeId: 'agnes.web/workbench-shell-state@1',
  revision: 1,
  digest: 'dcaff3db4a6ac73ffd10813f13065d440227a7959bbbaaa6eba4ca7e0be0c72d',
}

// `{name}` marks an id; each mount replaces it with one of its own.
const MARKUP = `<a class="skip-link" href="#{main}" data-i18n="index-shell.skip">Skip to main content</a>
<button class="sidebar-backdrop" type="button" aria-label="Close navigation" data-i18n-aria="index-shell.closeNav"></button>

<aside class="sidebar" data-agnes-region="sidebar" aria-label="Session navigation" data-i18n-aria="index-shell.sessionsNav"></aside>

<main id="{main}" tabindex="-1">
  <header class="topbar" data-agnes-region="topbar">
  </header>

  <div class="workbench-split">
  <div class="session-tabs-bar">
  <div class="session-tabs" role="tablist" aria-label="Session views" data-i18n-aria="index-shell.tabsView">
    <button type="button" id="{chat}" class="session-tab-chat" role="tab" aria-selected="true" aria-controls="{conversation}" tabindex="0" data-i18n="index-shell.tabChat">Conversation</button>
    <button type="button" id="{traceTab}" class="session-tab-trace" role="tab" aria-selected="false" aria-controls="{trace}" tabindex="-1" data-i18n="index-shell.tabTrace">Trace</button>
  </div>
  <button type="button" class="report-problem icon-button" aria-label="Report a problem" title="Report a problem" data-i18n-aria="index-shell.reportProblem"><svg class="icon icon-fill" data-agnes-region="icon" viewBox="0 0 20 20" aria-hidden="true"><g transform="translate(1.8 2.25) scale(0.965)"><path d="M16.2496 8.24975C16.4584 8.24975 16.6354 8.32294 16.7809 8.46886C16.9273 8.61431 17 8.79139 17 9.00011C17 9.20789 16.9268 9.38545 16.7809 9.53136C16.712 9.60215 16.6293 9.65807 16.5379 9.69568C16.4465 9.73328 16.3484 9.75177 16.2496 9.75H14.2498V10.4999C14.2498 11.3957 14.0208 12.2292 13.5622 12.9998L15.2811 14.7187C15.427 14.8647 15.4998 15.0417 15.4998 15.25C15.4998 15.4582 15.427 15.6353 15.2811 15.7812C15.2122 15.852 15.1295 15.908 15.0381 15.9456C14.9468 15.9832 14.8487 16.0017 14.7499 15.9999C14.5416 15.9999 14.3645 15.9272 14.2186 15.7812L12.6249 14.1875C11.6663 15.0625 10.5415 15.5003 9.24994 15.5003H7.75017C6.45818 15.5003 5.33336 15.0625 4.37475 14.1875L2.78101 15.7812C2.71209 15.852 2.62939 15.908 2.53802 15.9456C2.44666 15.9832 2.34855 16.0017 2.24977 15.9999C2.04199 15.9999 1.86444 15.9272 1.71852 15.7812C1.64773 15.7123 1.59181 15.6296 1.55421 15.5383C1.51661 15.4469 1.49812 15.3488 1.49988 15.25C1.49988 15.0417 1.57308 14.8647 1.71852 14.7187L3.4374 12.9998C2.98351 12.2453 2.74567 11.3805 2.74985 10.4999V9.75H0.749999C0.541751 9.75 0.364669 9.67681 0.218753 9.53136C0.147964 9.46244 0.0920443 9.37974 0.0544416 9.28837C0.0168389 9.197 -0.00164984 9.0989 0.000115494 9.00011C0.000115494 8.79139 0.0728372 8.61431 0.218753 8.46886C0.287639 8.39799 0.370318 8.34198 0.461687 8.30429C0.553056 8.26661 0.651178 8.24804 0.749999 8.24975H2.74985V5.31252L1.46919 4.03137C1.3984 3.96245 1.34248 3.87975 1.30488 3.78838C1.26727 3.69701 1.24879 3.59891 1.25055 3.50012C1.25055 3.2914 1.32327 3.11432 1.46919 2.96887C1.53808 2.898 1.62075 2.84199 1.71212 2.8043C1.80349 2.76662 1.90161 2.74805 2.00044 2.74976C2.20868 2.74976 2.38577 2.82295 2.53168 2.96887L3.81281 4.25001H4.28173C4.28173 3.08362 4.69822 2.08345 5.53169 1.24998C6.36516 0.416501 7.36484 0 8.5317 0C9.69808 0 10.6982 0.416501 11.5317 1.24998C12.3652 2.08345 12.7817 3.08315 12.7817 4.25001H13.1878L14.4689 2.96887C14.5378 2.898 14.6205 2.84199 14.7118 2.8043C14.8032 2.76662 14.9013 2.74805 15.0002 2.74976C15.2089 2.74976 15.386 2.82295 15.5314 2.96887C15.6778 3.11432 15.7505 3.2914 15.7505 3.50012C15.7505 3.7079 15.6773 3.88546 15.5314 4.03137L14.2503 5.31252V8.24975H16.2496ZM10.4687 2.31248C9.9271 1.77084 9.28111 1.50025 8.53122 1.50025C7.78134 1.50025 7.13534 1.77084 6.59371 2.31248C6.05207 2.85412 5.78149 3.50012 5.78149 4.25001H11.281C11.281 3.50012 11.0104 2.85412 10.4687 2.31248ZM9.24994 14C10.2085 14 11.0312 13.6562 11.7187 12.9687C12.4063 12.2811 12.75 11.458 12.75 10.4999V5.7498H4.25009V10.5004C4.25009 11.458 4.59386 12.2811 5.28141 12.9687C5.96849 13.6562 6.79157 14 7.75017 14V8.12508C7.75017 7.8748 7.87484 7.75014 8.12512 7.75014H8.875C9.12528 7.75014 9.24994 7.8748 9.24994 8.12508V14Z"/></g></svg></button>
  </div>
  <div id="{conversation}" class="conversation-shell" role="tabpanel" aria-labelledby="{chat}" data-agnes-region="conversation">
  </div>
  <aside id="{trace}" class="trace-panel" role="tabpanel" aria-labelledby="{traceTab}" data-agnes-region="trace" hidden aria-label="Run trace" data-i18n-aria="index-shell.tracePanel"></aside>
  <aside class="rightbar-panel" data-agnes-region="rightbar" hidden aria-label="Extension panels" data-i18n-aria="index-shell.rightbarPanel"></aside>
  </div>

  <section class="approval-panel" data-agnes-region="approval" hidden aria-live="polite"></section>
  <div class="composer-mount"></div>
</main>`

const OK: Outcome<void> = { ok: true, value: undefined }
const refuse = (
  code: RuntimeError['code'],
  detailCode: string,
  message: string,
): { ok: false; error: RuntimeError } => ({
  ok: false,
  error: { code, detailCode, message, retryAdvice: { kind: 'never' }, diagnosticId: 'web-workbench-shell' },
})

let mounts = 0

export function createWorkbenchShell(host: WorkbenchHost): ShellProvider {
  let used = false
  let disposed = false
  let mounted: { container: HTMLElement; session: WorkbenchMount } | undefined

  function release(container: HTMLElement): void {
    for (const notice of host.notices) if (container.contains(notice)) container.before(notice)
    container.replaceChildren()
    delete container.dataset.agnesWorkbench
  }

  return {
    descriptor: {
      id: 'agnes.web.workbench',
      apiMajor: 1,
      stateSchema: STATE_SCHEMA,
      requiredRegions: ['conversation', 'composer', 'interactions'],
    },

    async mount({ container, signal }) {
      if (disposed) return refuse('conflict', 'shell_disposed', 'the shell was disposed')
      if (used) return refuse('conflict', 'shell_mounted', 'the workbench mounts once')
      if (signal.aborted) return refuse('cancelled', 'shell_mount_cancelled', 'the mount was cancelled')
      used = true
      const prefix = `workbench-${++mounts}`
      const template = container.ownerDocument.createElement('template')
      template.innerHTML = MARKUP.replace(/\{(\w+)\}/g, (_, name: string) => `${prefix}-${name}`)
      container.dataset.agnesWorkbench = ''
      container.append(template.content)
      const find = <T extends HTMLElement>(selector: string) => container.querySelector(selector) as T
      const regions: WorkbenchRegions = {
        sidebar: find('aside.sidebar'),
        main: find('main'),
        topbar: find('header.topbar'),
        chatTab: find('.session-tab-chat'),
        traceTab: find('.session-tab-trace'),
        reportProblem: find('.report-problem'),
        conversation: find('.conversation-shell'),
        trace: find('.trace-panel'),
        rightbar: find('.rightbar-panel'),
        approval: find('.approval-panel'),
        composer: find('.composer-mount'),
      }
      regions.topbar.after(...host.notices)
      let session: WorkbenchMount
      try {
        session = await host.mount(regions)
      } catch (error) {
        release(container)
        const reason = error instanceof Error ? error.message : String(error)
        return refuse(
          'internal',
          'workbench_mount_failed',
          `the workbench regions failed to mount: ${reason}`,
        )
      }
      applyLocaleText(container, (key) => session.translate(key))
      mounted = { container, session }
      return OK
    },

    async update() {
      // The host still renders the session itself, so a snapshot changes nothing here yet.
      return mounted ? OK : refuse('conflict', 'shell_not_mounted', 'the workbench is not mounted')
    },

    async exportState(): Promise<Outcome<ShellViewState>> {
      if (!mounted) return refuse('conflict', 'shell_not_mounted', 'the workbench is not mounted')
      return { ok: true, value: { schema: { ...STATE_SCHEMA }, data: { draft: mounted.session.draft() } } }
    },

    async importState(state) {
      if (!mounted) return refuse('conflict', 'shell_not_mounted', 'the workbench is not mounted')
      const schema = state?.schema
      if (
        schema?.typeId !== STATE_SCHEMA.typeId ||
        schema.revision !== STATE_SCHEMA.revision ||
        schema.digest !== STATE_SCHEMA.digest
      )
        return refuse('incompatible', 'shell_state_incompatible', 'the workbench cannot read this view state')
      const draft = (state.data as { draft?: unknown } | null)?.draft
      if (typeof draft !== 'string')
        return refuse('invalid_input', 'shell_state_malformed', 'the view state data is malformed')
      mounted.session.setDraft(draft)
      return OK
    },

    stopAdmission() {
      if (mounted) mounted.container.inert = true
    },

    async dispose() {
      disposed = true
      const last = mounted
      mounted = undefined
      if (last) {
        await last.session.dispose()
        release(last.container)
      }
      return OK
    },
  }
}
