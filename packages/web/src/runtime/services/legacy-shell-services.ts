// The ShellServices the Web app hands its shells before the runtime client wire reaches the browser. A
// transitional adapter: nothing here is exported beyond this package or counted as contract evidence,
// and the runtime transport replaces it once its routes and welcome are served.
//
// It carries navigation, which the page's own session opening serves exactly. The page's wire has none
// of the facts the other services answer with: conversation windows with epochs and signed cursors,
// command handles, session parameter revisions, interaction versions and intent digests. Those refuse
// as unwired, so a shell sees a refusal rather than invented values.
import type { RuntimeError, ShellServices } from '@agnes/extension-api/client'

const refuse = (detailCode: string, message: string): { ok: false; error: RuntimeError } => ({
  ok: false,
  error: {
    code: 'incompatible',
    detailCode,
    message,
    retryAdvice: { kind: 'never' },
    diagnosticId: 'web-shell-services',
  },
})
const unwired = (what: string) =>
  refuse('web_shell_service_unwired', `${what} is not available to shells in this Web client yet`)
const later = (what: string) => async () => unwired(what)
const now = (what: string) => () => unwired(what)

export function createLegacyShellServices(page: {
  /** Opens the session the way the page's own session list does; rejects when it cannot. */
  open(sessionId: string): Promise<void>
}): ShellServices {
  return {
    commands: { submit: later('commands.submit'), commandStatus: later('commands.commandStatus') },
    interactions: {
      pending: later('interactions.pending'),
      read: later('interactions.read'),
      respond: later('interactions.respond'),
      formLink: later('interactions.formLink'),
      responseStatus: later('interactions.responseStatus'),
    },
    control: {
      read: later('control.read'),
      submit: later('control.submit'),
      status: later('control.status'),
    },
    approvals: {
      read: later('approvals.read'),
      respond: later('approvals.respond'),
      formLink: later('approvals.formLink'),
      responseStatus: later('approvals.responseStatus'),
    },
    artifacts: {
      describe: later('artifacts.describe'),
      openDownload: later('artifacts.openDownload'),
      readRange: later('artifacts.readRange'),
      openStream: later('artifacts.openStream'),
      followDownload: now('artifacts.followDownload'),
    },
    registry: { register: now('registry.register'), resolve: now('registry.resolve') },
    presentation: { domain: now('presentation.domain'), legacySlot: now('presentation.legacySlot') },
    conversation: {
      list: later('conversation.list'),
      create: later('conversation.create'),
      open: later('conversation.open'),
      history: later('conversation.history'),
      submit: later('conversation.submit'),
      cancel: later('conversation.cancel'),
      status: later('conversation.status'),
    },
    domains: { query: later('domains.query') },
    async navigate(target) {
      // The page has no domain views to show.
      if (target.viewId !== undefined) return unwired('navigate to a view')
      try {
        await page.open(target.sessionId)
        return { ok: true, value: undefined }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'internal',
            detailCode: 'web_navigate_failed',
            message: error instanceof Error ? error.message : String(error),
            retryAdvice: { kind: 'never' },
            diagnosticId: 'web-shell-services',
          },
        }
      }
    },
  }
}
