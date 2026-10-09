import { type LocaleService, SlotOutlet, type SlotRegistry, SlotsProvider } from '@agnes/web-client'
import { createUsagePanel } from '@agnes/web-conversation/usage'
import { createAntdRoot } from '@agnes/web-ui'
import { ConversationUsage } from '@agnes/web-ui/assistant-ui'
import {
  Composer,
  type ComposerDependencies,
  type ComposerHandle,
  type ComposerRegionOptions,
  type ComposerView,
} from '@agnes/web-units'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { LoopPicker } from '../loop-picker.js'
import {
  COMPOSER_BAR_DSH_CHILDREN,
  COMPOSER_DEPENDENCIES,
  COMPOSER_SLOT,
  type EmptyStateRegionMount,
  rootStableRegistry,
} from './contracts.js'
import { mountDshShellRegion } from './shell.js'

/** Mount the component-owned composer form behind a session-scoped replacement boundary. */
export interface ComposerRegionMount extends EmptyStateRegionMount, ComposerHandle {}

export function ComposerDshFrame({
  registry,
  setHandle,
  options,
  dependencies,
}: {
  registry: SlotRegistry
  setHandle: (value: ComposerHandle | null) => void
  options: ComposerRegionOptions
  dependencies: ComposerDependencies
}): ReturnType<typeof createElement> {
  const outlet = (name: string) => createElement(SlotOutlet, { name: name as never, hideWhenEmpty: true })
  return createElement(
    SlotsProvider,
    { registry },
    createElement(
      'div',
      { 'data-agnes-composer-dsh': true },
      createElement(SlotOutlet, {
        name: 'conversation.composer',
        props: { owner: { composerId: 'composer' } },
        owner: { composerId: 'composer' },
        hideWhenEmpty: true,
      }),
      createElement(Composer, {
        ref: setHandle,
        dependencies,
        ...options,
        slots: {
          attachments: outlet('conversation.input.attachments'),
          dock: createElement(
            'span',
            { style: { display: 'contents' }, 'data-agnes-composer-dock': true },
            createElement(SlotOutlet, {
              name: 'conversation.composer.dock',
              props: { owner: { composerId: 'composer' } },
              hideWhenEmpty: true,
            }),
            outlet('conversation.input.dock'),
          ),
          left: createElement(
            'span',
            { style: { display: 'contents' } },
            createElement(LoopPicker),
            outlet('conversation.input.left'),
          ),
          model: outlet('conversation.input.model'),
          overlay: outlet('conversation.input.overlay'),
          permission: outlet('conversation.input.permission'),
          plan: outlet('conversation.input.plan'),
          right: outlet('conversation.input.right'),
        },
      }),
    ),
  )
}

export function mountComposerRegion(
  registry: SlotRegistry,
  container: HTMLElement,
  options: ComposerRegionOptions,
  locale: LocaleService,
): ComposerRegionMount {
  // Render-time lookup: the injected translate reads whatever locale is current on each render.
  const composerDependencies: ComposerDependencies = {
    ...COMPOSER_DEPENDENCIES,
    translate: (key, vars) => locale.t(key, vars),
    // Wrap the usage panel so the shared React component renders with the current locale.
    UsagePanel: (props) =>
      createElement(ConversationUsage, {
        ...props,
        t: (key, vars) => locale.t(key, vars),
      }),
    createUsagePanel: (parent) => createUsagePanel(parent, (key, vars) => locale.t(key, vars)),
  }
  const ownedShell = registry.spec('root') ? undefined : mountDshShellRegion(registry)
  if (!registry.spec('conversation.composer'))
    registry.declare(
      'conversation.composer',
      { kind: 'chain', scope: 'session' },
      'web-shell',
      'main.conversation',
    )
  if (!registry.spec('conversation.composer.bar'))
    registry.declare(
      'conversation.composer.bar',
      { kind: 'single', scope: 'session-maybe' },
      'web-shell',
      'main.conversation',
    )
  const handle = { current: null as ComposerHandle | null }
  let view: ComposerView | undefined
  let draft = options.initialDraft ?? ''
  const setHandle = (value: ComposerHandle | null): void => {
    handle.current = value
    if (!value) return
    value.setDraft(draft)
    const next = view
    if (next)
      queueMicrotask(() => {
        if (handle.current === value) value.render(next)
      })
  }
  const composerOptions: ComposerRegionOptions = {
    ...options,
    onDraftChange: (value) => {
      draft = value
      options.onDraftChange(value)
    },
  }
  registry.declare(COMPOSER_SLOT as string, { kind: 'single', scope: 'session-maybe' }, 'web-shell')
  const removeDshBarBuiltin = registry.register(
    {
      name: 'conversation.composer.bar',
      id: 'builtin-conversation-composer-bar',
      owner: '@agnes/web-composer',
      priority: 1,
      children: COMPOSER_BAR_DSH_CHILDREN,
    },
    () =>
      ComposerDshFrame({
        registry,
        setHandle,
        options: composerOptions,
        dependencies: composerDependencies,
      }),
  )
  const removeBuiltin = registry.register(
    {
      name: COMPOSER_SLOT as string,
      id: 'builtin-composer',
      owner: '@agnes/web-composer',
      priority: 0,
    },
    () => createElement(SlotOutlet, { name: 'conversation.composer.bar' }),
  )
  const removeSessionListener = registry.subscribeSession(() => handle.current?.clearImageBlocks())
  const root = createAntdRoot(container)
  flushSync(() => {
    root.render(
      createElement(
        SlotsProvider,
        { registry: rootStableRegistry(registry) },
        createElement(SlotOutlet, { name: COMPOSER_SLOT }),
      ),
    )
  })
  let disposed = false
  return {
    focus() {
      handle.current?.focus()
    },
    getDraft() {
      return handle.current?.getDraft() ?? draft
    },
    getImageBlocks() {
      return handle.current?.getImageBlocks() ?? []
    },
    getAttachmentBlocks() {
      return handle.current?.getAttachmentBlocks() ?? []
    },
    hasPendingImages() {
      return handle.current?.hasPendingImages() ?? false
    },
    render(next) {
      view = next
      handle.current?.render(next)
    },
    clearImageBlocks() {
      handle.current?.clearImageBlocks()
    },
    restoreImageBlocks(images) {
      handle.current?.restoreImageBlocks(images)
    },
    restoreAttachmentBlocks(attachments) {
      handle.current?.restoreAttachmentBlocks(attachments)
    },
    resize() {
      handle.current?.resize()
    },
    setDraft(value) {
      draft = value
      handle.current?.setDraft(value)
    },
    dispose() {
      if (disposed) return
      disposed = true
      root.unmount()
      removeSessionListener()
      removeBuiltin()
      removeDshBarBuiltin()
      ownedShell?.dispose()
    },
  }
}
