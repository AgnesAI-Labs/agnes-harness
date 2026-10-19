import {
  mountComposerRegion,
  mountConversationRegion,
  mountTranscriptRegion,
} from '@agnes/web/presentation-renderers'
import type { ClientContext } from '@agnes/web-client'
import type {} from '@agnes/web-units/shell'

/** Frame/transcript and composer are independently selectable presentations of host-owned work. */
export function apply(ctx: ClientContext) {
  const conversation = ctx.presentationRoles.register({
    role: 'conversation',
    priority: 100,
    mount(ctx) {
      const port = ctx.presentation.conversation
      if (!port) return () => {}
      let transcript: (() => void) | undefined
      let generation = 0
      const view = mountConversationRegion(ctx.slots, port.container, {
        session: ctx.session,
        locale: ctx.locale,
        onMount(children) {
          port.onMount(children)
          const epoch = ++generation
          queueMicrotask(() => {
            if (epoch !== generation) return
            transcript?.()
            const mounted = mountTranscriptRegion(ctx.slots, children.transcript, {
              ...port.transcript,
              newContentButton: children.newContentButton,
              session: ctx.session,
              locale: ctx.locale,
              resources: ctx.resources,
            })
            const detach = port.transcript.attach(mounted)
            transcript = () => {
              detach()
              mounted.dispose()
            }
          })
        },
        onUnmount() {
          generation++
          transcript?.()
          transcript = undefined
          port.onUnmount()
        },
      })
      const detach = port.attach(view)
      return () => {
        generation++
        detach()
        transcript?.()
        transcript = undefined
        view.dispose()
      }
    },
  })
  const composer = ctx.presentationRoles.register({
    role: 'composer',
    priority: 100,
    mount(ctx) {
      const port = ctx.presentation.composer
      if (!port) return () => {}
      const view = mountComposerRegion(ctx.slots, port.container, port.options, ctx.locale, port.controls)
      const detach = port.attach(view)
      return () => {
        detach()
        view.dispose()
      }
    },
  })
  return () => {
    composer()
    conversation()
  }
}
