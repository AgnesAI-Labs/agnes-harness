import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { vi } from 'vitest'
import {
  type AgnesClient,
  type ClientModulesRuntime,
  startClientModules,
} from '../src/client-modules/boot.js'
import type { ComposerRegionOptions } from '../src/composer.js'
import type { SidebarActions, SidebarState } from '../src/sidebar.js'

export type WebPageName = 'index.html' | 'admin.html' | 'resources.html'
export type WebDomFixtureOptions = {
  composer?: Partial<ComposerRegionOptions>
  sidebar?: { state?: SidebarState; actions?: Partial<SidebarActions> }
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
 * Install the workbench skeleton and run the same built-in region bootstrap used by the Web entry.
 * The fixture deliberately does not import app.ts: its production module also binds the daemon and
 * session lifecycle, while this contract only needs the DOM ownership boundary.
 */
export async function mountRenderedIndex(options: WebDomFixtureOptions = {}): Promise<ClientModulesRuntime> {
  const markup = readFileSync(publicPath('index.html'), 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<link\b[^>]*>/g, '')
  document.documentElement.innerHTML = markup

  const runtime = await startClientModules({
    // The region bootstrap only retains this client for the reconciler. No roster read is issued by
    // this fixture, so an empty test double keeps the fixture independent of daemon contracts.
    agnes: {} as AgnesClient,
    rosterSource: { list: async () => ({ revision: '', modules: [], statuses: [] }) },
    panelContainer: document.getElementById('main-content') ?? undefined,
    sidebarContainer: document.querySelector<HTMLElement>('aside.sidebar') ?? undefined,
    ...(options.sidebar ? { sidebar: options.sidebar } : {}),
    conversationContainer: document.getElementById('conversation-shell') ?? undefined,
    topbarContainer: document.querySelector<HTMLElement>('header.topbar') ?? undefined,
    approvalContainer: document.getElementById('approval') ?? undefined,
    composerContainer: document.getElementById('composer-mount') ?? undefined,
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
    traceContainer: document.getElementById('trace-panel') ?? undefined,
    trace: {
      toggle: document.getElementById('view-trace') as HTMLButtonElement,
      chatToggle: document.getElementById('view-chat') as HTMLButtonElement,
      conversation: document.getElementById('conversation-shell') as HTMLElement,
    },
    rightbarContainer: document.getElementById('rightbar-panel') ?? undefined,
    settingsPaneContainer: document.getElementById('config') ?? undefined,
  })

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
