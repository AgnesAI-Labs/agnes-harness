import { empty, managed, parameters, readActions, services } from './src/contracts.mjs'
import { interact } from './src/interaction.mjs'
import { createLauncher } from './src/launcher.mjs'
import { browserInstructions } from './src/policy.mjs'
import { BrowserRuntime } from './src/runtime.mjs'
import { acceptInput, selectView, showPages, showView } from './src/streams.mjs'

async function browserEffect(runtime, work) {
  try {
    return await work()
  } catch (error) {
    // Known refusals did not submit to a website. Complete the native journal
    // with that result; cancellation after dispatch and engine failures stay uncertain.
    if (runtime.isRefusal(error) && error.code !== 'UNCERTAIN') return { status: 'refused', code: error.code }
    throw error
  }
}

export const main = {
  inject: ['tools', 'hooks', 'services', 'profileRuntime'],
  apply(ctx) {
    const launcher = createLauncher()
    const resource = ctx.profileRuntime.register({
      id: managed.id,
      configSchema: empty,
      defaultConfig: {},
      async start(init) {
        const runtime = new BrowserRuntime({
          launch: () => launcher.launch(),
          assertCurrent: init.assertCurrent,
          protectedOrigins: process.env.AGNES_WEB_ORIGIN ? [process.env.AGNES_WEB_ORIGIN] : [],
        })
        init.onShutdown(async () => {
          // Preparation keeps its install lock until cancellation cleanup has finished.
          await Promise.all([launcher.cancel(), runtime.close()])
          return { state: 'settled' }
        })
        await launcher.check(runtime)
        init.assertCurrent()
        if (runtime.state === 'stopped') launcher.prepare(runtime)
        init.ready()
        return runtime
      },
    })
    for (const definition of services)
      ctx.services.register({
        ...definition,
        async handler(input, context) {
          const runtime = await resource.get()
          switch (definition.name) {
            case 'browser.status':
              return runtime.status()
            case 'browser.pages':
              // A status poll admitted before switch-off can finish after page cleanup.
              return { pages: runtime.enabled ? runtime.list(context.session) : [] }
            case 'browser.events':
              if (!runtime.enabled)
                return { events: [], cursor: input.cursor ?? 0, hasMore: false, gap: false }
              return runtime.act(context.session, { action: 'events', ...input }, context.signal)
            case 'browser.stream':
              return runtime.describe(runtime.get(context.session, input.pageId))
            case 'browser.view':
              return selectView(runtime, input, context)
            case 'browser.connect':
              if (!context.controlGrant) throw new Error('Native control admission missing.')
              return { status: 'ok' }
            case 'browser.close':
              return browserEffect(runtime, () =>
                runtime.closePage(context.session, input.pageId, context.signal),
              )
            case 'browser.open':
              return browserEffect(runtime, () =>
                runtime.act(context.session, { action: 'open', ...input }, context.signal, {
                  files: context.sessionFiles,
                  root: context.session.workspaceRoot,
                }),
              )
            case 'browser.control': {
              if (input.mode === 'human' && !context.controlGrant)
                throw new Error('Native control admission missing.')
              return browserEffect(runtime, () =>
                runtime.control(context.session, input, context.actor, context.controlGrant, context.signal),
              )
            }
            default:
              throw new Error('Unknown browser service')
          }
        },
      })
    ctx.profileRuntime.streams.register('browser.state', async (_input, context) => {
      const runtime = await resource.get()
      if (context.origin) runtime.protectedOrigins.add(new URL(context.origin).origin)
      const notify = () => {
        try {
          context.stream.send(runtime.status())
        } catch {
          context.stream.close('runtime-unavailable')
        }
      }
      const close = () => runtime.listeners.delete(notify)
      runtime.listeners.add(notify)
      context.signal.addEventListener('abort', close, { once: true })
      context.stream.onDisconnect(close)
      notify()
    })
    ctx.profileRuntime.streams.register('browser.pages', async (input, context) =>
      showPages(await resource.get(), input, context),
    )
    ctx.profileRuntime.streams.register('browser.frames', async (input, context) =>
      showView(await resource.get(), input, context),
    )
    ctx.profileRuntime.streams.register('browser.input', async (input, context) =>
      acceptInput(await resource.get(), input, context),
    )
    ctx.profileRuntime.streams.register('browser.interaction', async (input, context) =>
      interact(await resource.get(), input, context),
    )
    ctx.hooks.register('context', async (_payload, context) => {
      let state = { enabled: false }
      try {
        state = (await resource.get()).status()
      } catch {}
      const text = browserInstructions(state, { unattended: context.unattended === true })
      return text ? { additionalContext: text, refreshOnRequest: true } : { refreshOnRequest: true }
    })
    ctx.hooks.register('shutdown', async (_input, context) => {
      try {
        await (await resource.get()).closeSession(context.session.key)
      } catch {}
    })
    ctx.tools.register({
      name: 'browser',
      description:
        "An optional background browser, sharing the SAME page with the workbench. Choose suitable tools for the task; always respect the user's specified browser or tool. It does not open a desktop window or expand the panel. Start local projects with shell/Jobs and open the actual URL. open also accepts workspace paths or file URLs; previewRoot optionally selects the permitted asset directory within the workspace. Browser-native files use their content types; unsupported formats are reported. status/tabs list pages; inspect returns current refs and pageEpoch for mutations; screenshot returns an image; events reads console/network errors. Use another tab when the user is working. Never silently switch a specified browser or replay uncertain actions.",
      parameters,
      meta: {
        isReadOnly: false,
        isDestructive: true,
        isConcurrencySafe: false,
        isOpenWorld: true,
        replay: 'never',
        requiresApproval: 'destructive',
        deferLoading: 'auto',
      },
      policyVersion: 'browser.v1',
      classify(input) {
        const read = readActions.has(input.action)
        return {
          isReadOnly: read,
          isDestructive: !read,
          replay: read ? 'safe' : 'never',
          requiresApproval: read ? 'never' : 'destructive',
          approvalScopes: [],
        }
      },
      async execute(input, context) {
        try {
          const runtime = await resource.get()
          if (input.action === 'status')
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ...runtime.status(),
                    pages: runtime.enabled ? runtime.list(context.session) : [],
                    fallback: 'Use computer_use only when available and authorized.',
                  }),
                },
              ],
            }
          const result = await runtime.act(context.session, input, context.signal, {
            files: context.sessionFiles,
            root: context.session.workspaceRoot,
          })
          const content = []
          if (result.bytes) {
            const ref = await context.artifacts.put(result.bytes, { mime: 'image/png', name: 'browser-page' })
            content.push({ type: 'image', ref, mime: 'image/png' })
            delete result.bytes
          }
          content.unshift({ type: 'text', text: JSON.stringify(result) })
          return { content }
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  code: error.code ?? 'UNAVAILABLE',
                  message: String(error.message).slice(0, 600),
                }),
              },
            ],
          }
        }
      },
    })
  },
}
