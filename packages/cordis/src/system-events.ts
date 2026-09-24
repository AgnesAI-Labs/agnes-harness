import type { Context } from './context.js'
import type { DispatchMode } from './events.js'
import { symbols } from './utils.js'

type Dispatcher = (source: Context, mode: DispatchMode, args: any[]) => Array<(...args: any[]) => any>

const dispatchers = new WeakMap<object, Dispatcher>()

/** Register the private core dispatcher without placing a discoverable token on the service. */
export function registerSystemDispatcher(service: object, dispatch: Dispatcher): void {
  dispatchers.set(service, dispatch)
}

function callbacks(context: Context, mode: DispatchMode, args: any[]) {
  const events = context.events as Context['events'] & { [symbols.original]?: object }
  const service = events[symbols.original] ?? events
  const dispatch = dispatchers.get(service)
  if (!dispatch) throw new Error('system event dispatcher is unavailable')
  return dispatch(context, mode, args)
}

export function systemCallbacks(context: Context, mode: DispatchMode, args: any[]) {
  return callbacks(context, mode, args)
}

export function systemEmit(context: Context, ...args: any[]) {
  for (const callback of callbacks(context, 'emit', args)) {
    callback(...args)
  }
}

export function systemWaterfall(context: Context, ...args: any[]) {
  const cbs = callbacks(context, 'waterfall', args)
  const inner = args.pop()
  const next = () => {
    const callback = cbs.shift() ?? inner
    return callback(...args)
  }
  args.push(next)
  return next()
}
