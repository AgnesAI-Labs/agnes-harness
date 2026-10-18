import { browserViews } from '@agnes/web-client'

// This adapter has no panel, DOM or stream subscriptions until a viewer requests one.
export function apply(ctx) {
  return ctx.presentationRoles.register({
    role: 'browser-transport',
    priority: 100,
    mount: (mounted) =>
      browserViews.register({
        id: 'agh-browser',
        order: 100,
        observe: (sessionId) =>
          mounted.profile.services.query('browser.observe', { sessionId }, { sessionReads: [sessionId] }),
        watch: (ticket, signal) => mounted.profile.streams.open('browser.frames', { ticket }, { signal }),
      }),
  })
}
