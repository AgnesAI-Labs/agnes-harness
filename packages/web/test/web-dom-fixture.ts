import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ShellSnapshot } from '@agnes/extension-api/client'
import { vi } from 'vitest'
import {
  type AgnesClient,
  type ClaimResolver,
  type ClientModulesRuntime,
  startClientModules,
} from '../src/client-modules/boot.js'
import type { ComposerRegionOptions } from '../src/composer.js'
import { createWorkbenchShell, type WorkbenchRegions } from '../src/runtime/providers/workbench-shell.js'
import { createLegacyShellServices } from '../src/runtime/services/legacy-shell-services.js'
import { createShellSwitcher, type ShellSwitcher } from '../src/runtime/shell-state.js'
import type { SidebarActions, SidebarState } from '../src/sidebar.js'

export type WebPageName = 'index.html' | 'admin.html' | 'resources.html'
export type WebDomFixtureOptions = {
  composer?: Partial<ComposerRegionOptions>
  sidebar?: { state?: SidebarState; actions?: Partial<SidebarActions> }
  transcript?: { nodeHost: 'react' }
  claim?: ClaimResolver
}

const packageRoot = process.cwd().endsWith('/packages/web')
  ? process.cwd()
  : resolve(process.cwd(), 'packages/web')

function publicPath(page: WebPageName): string {
  return resolve(packageRoot, 'public', page)
}

/** Static pages are intentionally parsed without starting their standalone scripts. */
export function readStaticPage(page: Exclude<WebPageName, 'index.html'>): Document {
  const markup = readFileSync(publicPath(page), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<link\b[^>]*>/g, '')
  const parsed = new DOMParser().parseFromString(markup, 'text/html')
  if (!parsed) throw new Error(`unable to parse ${page}`)
  return parsed
}

/**
 * Load index.html and mount the built-in workbench shell through the shell switch, running the same
 * region bootstrap the Web entry runs in it. The fixture deliberately does not import app.ts: its
 * production module also binds the daemon and session lifecycle, while this contract only needs the
 * DOM ownership boundary.
 */
export async function mountRenderedIndex(options: WebDomFixtureOptions = {}): Promise<ClientModulesRuntime> {
  const markup = readFileSync(publicPath('index.html'), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<link\b[^>]*>/g, '')
  document.documentElement.innerHTML = markup

  const runtime = await mountWorkbench(document.getElementById('agnes-shell') as HTMLElement, options, [
    document.getElementById('notice') as HTMLElement,
  ])

  // React roots that are not flushed by a region mount (the panel outlet, and the empty state the
  // conversation mounts as a child) commit on a later scheduler task, which a loaded runner can
  // reach well after one timer tick. The empty-state heading is the visible output of those roots,
  // so waiting for it makes every consumer observe one complete rendered sample.
  await vi.waitFor(
    () => {
      if (!document.querySelector('[data-slot="ui:empty-state"] .empty-state-heading'))
        throw new Error('the empty-state region has not committed yet')
    },
    { timeout: 5_000 },
  )
  return runtime
}

/**
 * Mount one built-in workbench shell into `surface` through its own shell switch and region bootstrap.
 * Each call is a separate client: its own Cordis root, slot registry and React roots.
 */
export async function mountWorkbench(
  surface: HTMLElement,
  options: WebDomFixtureOptions = {},
  notices: readonly HTMLElement[] = [],
): Promise<ClientModulesRuntime & { shells: ShellSwitcher }> {
  let runtime: ClientModulesRuntime | undefined
  const shells = createShellSwitcher({
    surface,
    services: createLegacyShellServices({ open: async () => undefined }),
    snapshot: () => SNAPSHOT,
  })
  const mounted = await shells.switchTo(() =>
    createWorkbenchShell({
      notices,
      async mount(regions) {
        const started = await startClientModules(regionOptions(regions, options))
        runtime = started
        return {
          translate: (key) => started.locale.t(key),
          draft: () => started.composer?.getDraft() ?? '',
          setDraft: (draft) => started.composer?.setDraft(draft),
          dispose: () => started.dispose(),
        }
      },
    }),
  )
  if (!mounted.ok || !runtime)
    throw new Error(mounted.ok ? 'the workbench did not mount' : mounted.error.message)
  return Object.assign(runtime, { shells })
}

const SNAPSHOT: ShellSnapshot = {
  sessionId: null,
  catalogRevision: 0,
  conversation: null,
  views: [],
  pending: [],
  connection: 'offline',
  cursor: null,
}

function regionOptions(
  regions: WorkbenchRegions,
  options: WebDomFixtureOptions,
): Parameters<typeof startClientModules>[0] {
  return {
    // The region bootstrap only retains this client for the reconciler. No roster read is issued by
    // this fixture, so an empty test double keeps the fixture independent of daemon contracts.
    agnes: {} as AgnesClient,
    rosterSource: { list: async () => ({ revision: '', modules: [], statuses: [] }) },
    panelContainer: regions.main,
    sidebarContainer: regions.sidebar,
    ...(options.sidebar ? { sidebar: options.sidebar } : {}),
    ...(options.transcript ? { transcript: options.transcript } : {}),
    ...(options.claim ? { claim: options.claim } : {}),
    conversationContainer: regions.conversation,
    topbarContainer: regions.topbar,
    approvalContainer: regions.approval,
    composerContainer: regions.composer,
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
    traceContainer: regions.trace,
    trace: { toggle: regions.traceTab, chatToggle: regions.chatTab, conversation: regions.conversation },
    rightbarContainer: regions.rightbar,
    settingsPaneContainer: document.getElementById('config') ?? undefined,
  }
}

export function resetWebDom(): void {
  document.documentElement.replaceChildren()
}
