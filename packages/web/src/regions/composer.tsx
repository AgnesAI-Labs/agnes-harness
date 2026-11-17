import { resolvePluginMetadata } from '@agnes/protocol'
import {
  type ComposerPresentationControls,
  type LocaleService,
  SlotOutlet,
  type SlotRegistry,
  SlotsProvider,
  type VoiceComposer,
} from '@agnes/web-client'
import { RegisteredConversationCard } from '@agnes/web-conversation/conversation-registry'
import { createRegionRenderer, useDocumentLanguage } from '@agnes/web-ui'
import { ConversationUsage } from '@agnes/web-ui/conversation'
import {
  Composer,
  type ComposerDependencies,
  type ComposerDraftReferences,
  type ComposerHandle,
  type ComposerRegionOptions,
  type ComposerView,
} from '@agnes/web-units/shell'
import { type ReactElement, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { loadHeadsUp } from '../heads-up.js'
import { HeadsUpNote } from '../heads-up-view.js'
import { ModelPickerControl } from '../model-picker.js'
import { loadReplySuggestion } from '../reply-suggestion.js'
import { VoiceComposerButtons } from '../voice/composer-buttons.js'
import { ApplicationComposerContext, ApplicationWorkActions } from '../workbench/application-actions.js'
import { WorkspacePickerControl } from '../workspace-picker-control.js'
import {
  COMPOSER_BAR_DSH_CHILDREN,
  COMPOSER_DEPENDENCIES,
  COMPOSER_SLOT,
  type EmptyStateRegionMount,
  rootStableRegistry,
} from './contracts.js'
import { mountDshShellRegion } from './shell.js'

const EMPTY_SUGGESTIONS = { featured: [], total: 0 } as const

/** Mount the component-owned composer form behind a session-scoped replacement boundary. */
export interface ComposerRegionMount extends EmptyStateRegionMount, ComposerHandle {}

export function ComposerDshFrame({
  registry,
  setHandle,
  options,
  dependencies,
  controls,
  voiceComposer,
}: {
  registry: SlotRegistry
  setHandle: (value: ComposerHandle | null) => void
  options: ComposerRegionOptions
  dependencies: ComposerDependencies
  controls?: ComposerPresentationControls
  /** The composer as the voice function fills it; needed only when `controls.voice` is present. */
  voiceComposer?: VoiceComposer
}): ReactElement {
  const agents = useSyncExternalStore(
    controls?.suggestions.subscribe ?? (() => () => {}),
    controls?.suggestions.getSnapshot ?? (() => EMPTY_SUGGESTIONS),
  )
  const sessionId = useSyncExternalStore(registry.subscribeSession.bind(registry), () => registry.sessionId)
  const language = useDocumentLanguage() === 'zh-CN' ? 'zh-CN' : 'en'
  const examplePrompts = agents.featured.flatMap((row) => {
    const prompt = resolvePluginMetadata(row.metadata, language)?.samplePrompt
    return prompt ? [prompt] : []
  })
  const outlet = (name: string) => <SlotOutlet name={name as never} hideWhenEmpty={true} />
  return (
    <SlotsProvider registry={registry}>
      <div data-agnes-composer-dsh={true}>
        <SlotOutlet
          name="conversation.composer"
          props={{ owner: { composerId: 'composer' } }}
          owner={{ composerId: 'composer' }}
          hideWhenEmpty={true}
        />
        <RegisteredConversationCard
          card={{ kind: 'composer.before-input', data: {} }}
          context={{ t: (key) => key }}
        />
        <ApplicationWorkActions />
        <HeadsUpNote sessionId={sessionId} t={dependencies.translate} />
        <Composer
          ref={setHandle}
          dependencies={dependencies}
          {...options}
          examplePrompts={examplePrompts}
          slots={{
            attachments: (
              <>
                <ApplicationComposerContext sessionId={sessionId} />
                {outlet('conversation.input.attachments')}
              </>
            ),
            dock: (
              <span className="composer-dsh-control" data-agnes-composer-dock={true}>
                <SlotOutlet
                  name="conversation.composer.dock"
                  props={{ owner: { composerId: 'composer' } }}
                  hideWhenEmpty={true}
                />
                {outlet('conversation.input.dock')}
              </span>
            ),
            left: (
              <span className="composer-dsh-control">
                {controls && <controls.LoopPicker />}
                {outlet('conversation.input.left')}
              </span>
            ),
            model: outlet('conversation.input.model'),
            overlay: outlet('conversation.input.overlay'),
            permission: outlet('conversation.input.permission'),
            plan: outlet('conversation.input.plan'),
            right: outlet('conversation.input.right'),
            beforeSend:
              controls?.voice && voiceComposer ? (
                <VoiceComposerButtons voice={controls.voice} composer={voiceComposer} />
              ) : undefined,
          }}
        />
      </div>
    </SlotsProvider>
  )
}

export function mountComposerRegion(
  registry: SlotRegistry,
  container: HTMLElement,
  options: ComposerRegionOptions,
  locale: LocaleService,
  controls?: ComposerPresentationControls,
): ComposerRegionMount {
  // Render-time lookup: the injected translate reads whatever locale is current on each render.
  const composerDependencies: ComposerDependencies = {
    ...COMPOSER_DEPENDENCIES,
    ModelPicker: function ComposerModelPicker(props) {
      useSyncExternalStore(locale.subscribe, locale.getSnapshot)
      return <ModelPickerControl {...props} t={(key, vars) => locale.t(key, vars)} />
    },
    loadHint: (scope, signal) => {
      // The same finished-turn edge that asks for a reply suggestion also asks for the heads-up.
      void loadHeadsUp(scope, signal)
      return loadReplySuggestion(scope, signal)
    },
    subscribeHintInvalidation: (listener) => {
      const events = ['agnes:packages-changed', 'agnes:session-configuration-changed', 'agnes:settings-route']
      for (const event of events) window.addEventListener(event, listener, true)
      return () => {
        for (const event of events) window.removeEventListener(event, listener, true)
      }
    },
    translate: (key, vars) => locale.t(key, vars),
    WorkspacePicker: function ComposerWorkspacePicker(props) {
      useSyncExternalStore(locale.subscribe, locale.getSnapshot)
      return <WorkspacePickerControl {...props} t={(key, vars) => locale.t(key, vars)} />
    },
    // Wrap the usage panel so the shared React component renders with the current locale.
    UsagePanel: (props) => <ConversationUsage {...props} t={(key, vars) => locale.t(key, vars)} />,
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
  let draftReferences: ComposerDraftReferences = options.initialDraftReferences ?? { files: [], skills: [] }
  const setHandle = (value: ComposerHandle | null): void => {
    handle.current = value
    if (!value) return
    value.setDraft(draft)
    value.restoreDraftReferences(draftReferences)
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
      draftReferences = handle.current?.getDraftReferences() ?? draftReferences
      options.onDraftChange(value)
    },
  }
  // One stable object for the whole mount: the voice function keeps it across composer remounts.
  const voiceComposer: VoiceComposer = Object.freeze({
    insertText(text: string) {
      const current = handle.current
      if (current?.insertText) return current.insertText(text)
      // Replaced or remounting: the text joins the draft the next composer is given.
      composerOptions.onDraftChange(draft + text)
      current?.setDraft(draft)
    },
    submit: () => handle.current?.submit?.() ?? false,
    focus: () => handle.current?.focus(),
    async ensureSession() {
      if (registry.sessionId) return registry.sessionId
      if (!options.prepareUploadSession) throw new Error('no session to transcribe into')
      return options.prepareUploadSession()
    },
  })
  if (!registry.spec(COMPOSER_SLOT))
    registry.declare(COMPOSER_SLOT as string, { kind: 'single', scope: 'session-maybe' }, 'web-shell')
  const removeDshBarBuiltin = registry.register(
    {
      name: 'conversation.composer.bar',
      id: 'builtin-conversation-composer-bar',
      owner: '@agnes/web-composer',
      priority: 1,
      children: COMPOSER_BAR_DSH_CHILDREN,
    },
    () => (
      <ComposerDshFrame
        registry={registry}
        setHandle={setHandle}
        options={composerOptions}
        dependencies={composerDependencies}
        {...(controls ? { controls } : {})}
        voiceComposer={voiceComposer}
      />
    ),
  )
  const removeBuiltin = registry.register(
    {
      name: COMPOSER_SLOT as string,
      id: 'builtin-composer',
      owner: '@agnes/web-composer',
      priority: 0,
    },
    () => <SlotOutlet name="conversation.composer.bar" />,
  )
  let sessionId = registry.sessionId
  const removeSessionListener = registry.subscribeSession(() => {
    const next = registry.sessionId
    if (next === sessionId) return
    sessionId = next
    handle.current?.clearImageBlocks()
  })
  const root = createRegionRenderer(container)
  flushSync(() => {
    root.render(
      <SlotsProvider registry={rootStableRegistry(registry)}>
        <SlotOutlet name={COMPOSER_SLOT} />
      </SlotsProvider>,
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
    getDraftReferences() {
      return handle.current?.getDraftReferences() ?? draftReferences
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
    restoreDraftReferences(references) {
      draftReferences = references
      handle.current?.restoreDraftReferences(references)
    },
    restoreAttachmentBlocks(attachments) {
      handle.current?.restoreAttachmentBlocks(attachments)
    },
    setDraft(value) {
      draft = value
      handle.current?.setDraft(value)
    },
    mention(mention) {
      handle.current?.mention(mention)
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
