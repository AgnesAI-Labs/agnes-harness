import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ComposerRegionOptions } from '@agnes/web-conversation/composer'
import { vi } from 'vitest'
import { mountAppShell } from '../src/app-shell.js'
import {
  type AgnesClient,
  type ClaimResolver,
  type ClientModulesRuntime,
  startClientModules,
} from '../src/client-modules/boot.js'
import { mountNewSessionDialog } from '../src/new-session-dialog.js'
import type { SettingsRegionOptions } from '../src/region-slots.js'
import type { SidebarActions, SidebarState } from '../src/sidebar.js'
import type { VoiceController } from '../src/voice/controller.js'
import { mountReleasePresentations } from './release-presentations-fixture.js'

export type WebPageName = 'index.html' | 'admin.html' | 'resources.html'
export type WebDomFixtureOptions = {
  clientProfileCaller?: Parameters<typeof startClientModules>[0]['clientProfileCaller']
  agnes?: AgnesClient
  composer?: Partial<ComposerRegionOptions>
  sidebar?: { state?: SidebarState; actions?: Partial<SidebarActions> }
  claim?: ClaimResolver
  settings?: SettingsRegionOptions
  /** Without one the page has no voice: the fixture's client has no daemon to ask. */
  voice?: VoiceController
}

const packageRoot = process.cwd().endsWith('/packages/web')
  ? process.cwd()
  : resolve(process.cwd(), 'packages/web')

function publicPath(page: WebPageName): string {
  return resolve(packageRoot, 'public', page)
}

/** The alias pages are parsed without running the script that forwards to the workbench. */
export function readStaticPage(page: Exclude<WebPageName, 'index.html'>): Document {
  const markup = readFileSync(publicPath(page), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<link\b[^>]*>/g, '')
  const parsed = new DOMParser().parseFromString(markup, 'text/html')
  if (!parsed) throw new Error(`unable to parse ${page}`)
  return parsed
}

/**
 * Install the workbench skeleton and run the same built-in region bootstrap used by the Web entry.
 * The fixture deliberately does not import app.ts: its production module also binds the daemon and
 * session lifecycle, while this contract only needs the DOM ownership boundary.
 */
export async function mountRenderedIndex(options: WebDomFixtureOptions = {}): Promise<ClientModulesRuntime> {
  const markup = readFileSync(publicPath('index.html'), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<link\b[^>]*>/g, '')
  document.documentElement.innerHTML = markup
  const { hosts, dispose: unmountShell } = mountAppShell()

  const runtime = await startClientModules({
    // Tests may supply a synthetic client for shell operations such as profile approvals.
    // The separate roster source keeps this fixture independent of the daemon.
    agnes: options.agnes ?? ({} as AgnesClient),
    ...(options.clientProfileCaller ? { clientProfileCaller: options.clientProfileCaller } : {}),
    rosterSource: { list: async () => ({ revision: '', modules: [], statuses: [] }) },
    panelContainer: hosts.panels,
    sidebarContainer: hosts.sidebar,
    ...(options.sidebar ? { sidebar: options.sidebar } : {}),
    ...(options.claim ? { claim: options.claim } : {}),
    conversationContainer: hosts.conversation,
    topbarContainer: hosts.topbar,
    approvalContainer: hosts.approval,
    composerContainer: hosts.composer,
    composer: {
      initialDraft: '',
      onCancel: () => undefined,
      onDraftChange: () => undefined,
      onError: () => undefined,
      onModelSelect: async () => false,
      onPermissionSelect: async () => false,
      onSubmit: () => undefined,
      onWorkspace: () => undefined,
      ...options.composer,
    },
    traceContainer: hosts.trace,
    trace: { toggle: hosts.viewTrace, chatToggle: hosts.viewChat, conversation: hosts.conversation },
    rightbarContainer: hosts.rightbar,
    settingsPaneContainer: hosts.settings,
    ...(options.settings ? { settings: options.settings } : {}),
    voice: options.voice ?? false,
  })

  await mountReleasePresentations(runtime)

  const workspaceDialog = mountNewSessionDialog(hosts.newSession, {
    translate: (key, vars) => runtime.locale.t(key, vars),
    submit() {},
    pick() {},
    select() {},
    remove() {},
    restoreFocus() {},
  })
  const dispose = runtime.dispose.bind(runtime)
  runtime.dispose = async () => {
    workspaceDialog.dispose()
    await dispose()
    unmountShell()
  }

  // React roots that are not flushed by a region mount (the panel outlet, and the empty state the
  // conversation mounts as a child) commit on a later scheduler task, which a loaded runner can
  // reach well after one timer tick. The empty-state heading is the visible output of those roots,
  // so waiting for it makes every consumer observe one complete rendered sample.
  await vi.waitFor(
    () => {
      if (!document.querySelector('[data-slot="ui:empty-state"] #empty-state-title'))
        throw new Error('the empty-state region has not committed yet')
    },
    { timeout: 5_000 },
  )
  return runtime
}

export function resetWebDom(): void {
  document.documentElement.replaceChildren()
}
