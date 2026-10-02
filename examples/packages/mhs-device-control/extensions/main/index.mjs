import { ACTIONS_BY_DEVICE, resolveAction } from './actions.mjs'

const Kind = Symbol.for('TypeBox.Kind')

const stringSchema = (options = {}) => ({ [Kind]: 'String', type: 'string', ...options })
const numberSchema = (options = {}) => ({ [Kind]: 'Number', type: 'number', ...options })
const integerSchema = (options = {}) => ({ [Kind]: 'Integer', type: 'integer', ...options })
const objectSchema = (properties, required = []) => ({
  [Kind]: 'Object',
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const noParameters = objectSchema({}, [])
const deviceParameters = objectSchema({ deviceId: stringSchema({ minLength: 1, maxLength: 64 }) }, [
  'deviceId',
])
const controlParameters = objectSchema(
  {
    deviceId: stringSchema({ minLength: 1, maxLength: 64 }),
    action: stringSchema({ minLength: 1, maxLength: 64 }),
    distanceMeters: numberSchema({ minimum: 0.1, maximum: 20 }),
    speedMetersPerSecond: numberSchema({ minimum: 0.1, maximum: 3 }),
    angleDegrees: numberSchema({ minimum: 1, maximum: 360 }),
    durationMs: integerSchema({ minimum: 200, maximum: 10000 }),
  },
  ['deviceId', 'action'],
)

const readMeta = Object.freeze({
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe',
  costHint: undefined,
  deferLoading: false,
  requiresApproval: 'never',
})

const controlMeta = Object.freeze({
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  isOpenWorld: false,
  replay: 'never',
  costHint: { wallMs: 12000 },
  deferLoading: false,
  requiresApproval: 'never',
})

const DEVICE_TEMPLATES = Object.freeze([
  Object.freeze({
    deviceId: 'robot-dog-01',
    deviceType: 'robot_dog',
    displayName: 'Agnes Robot Dog',
    model: 'Unitree Go2 action profile',
    capabilities: Object.freeze(ACTIONS_BY_DEVICE.robot_dog.map((action) => action.id)),
    actions: ACTIONS_BY_DEVICE.robot_dog.map(({ id, label, aliases, durationMs }) => ({
      id,
      label,
      aliases,
      durationMs,
    })),
    batteryPercent: 86,
    posture: 'standing',
  }),
  Object.freeze({
    deviceId: 'robot-car-01',
    deviceType: 'robot_car',
    displayName: 'Agnes Robot Car',
    model: 'Rover C1',
    capabilities: Object.freeze(ACTIONS_BY_DEVICE.robot_car.map((action) => action.id)),
    actions: ACTIONS_BY_DEVICE.robot_car.map(({ id, label, aliases, durationMs }) => ({
      id,
      label,
      aliases,
      durationMs,
    })),
    batteryPercent: 92,
    posture: 'parked',
  }),
])

const clone = (value) => JSON.parse(JSON.stringify(value))
const now = () => new Date().toISOString()
const shortId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function createSessionState(sessionId) {
  return {
    sessionId,
    revision: 0,
    devices: DEVICE_TEMPLATES.map((device) => ({
      ...clone(device),
      online: true,
      controlState: 'ready',
      lastCommandId: null,
      updatedAt: now(),
    })),
    currentOperationId: null,
    operations: [],
  }
}

function result(structured) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structured,
  }
}

function wait(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(new Error('device command cancelled'))
  return new Promise((resolve, reject) => {
    const complete = () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(complete, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      reject(new Error('device command cancelled'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function eventLine(event) {
  return `[MHS][${event.type}] ${JSON.stringify(event)}`
}

function publicOperation(operation) {
  return clone(operation)
}

export function createMhsRuntime() {
  const sessions = new Map()
  const ensureSession = (sessionId) => {
    let state = sessions.get(sessionId)
    if (!state) {
      state = createSessionState(sessionId)
      sessions.set(sessionId, state)
    }
    return state
  }

  const emit = (state, operation, type, details, context) => {
    const event = {
      eventId: shortId('evt'),
      sequence: operation.events.length + 1,
      type,
      timestamp: now(),
      sessionId: state.sessionId,
      taskId: operation.taskId,
      planId: operation.planId,
      operationId: operation.operationId,
      commandId: operation.commandId,
      deviceId: operation.deviceId,
      ...details,
    }
    operation.events.push(event)
    if (operation.events.length > 80) operation.events.shift()
    operation.updatedAt = event.timestamp
    state.revision += 1
    const line = eventLine(event)
    context?.progress?.(line)
    context?.log?.info?.(line, event)
    return event
  }

  const startTodo = (state, operation, index, context) => {
    const todo = operation.todos[index]
    todo.status = 'running'
    todo.startedAt = now()
    emit(
      state,
      operation,
      'TODO_STARTED',
      { todoId: todo.id, step: index + 1, message: todo.title, status: 'running' },
      context,
    )
  }

  const finishTodo = (state, operation, index, context) => {
    const todo = operation.todos[index]
    todo.status = 'completed'
    todo.completedAt = now()
    emit(
      state,
      operation,
      'TODO_COMPLETED',
      { todoId: todo.id, step: index + 1, message: todo.title, status: 'completed' },
      context,
    )
  }

  const snapshot = (sessionId) => {
    const state = ensureSession(sessionId)
    const current = state.operations.find((item) => item.operationId === state.currentOperationId) ?? null
    return {
      sessionId,
      revision: state.revision,
      connected: true,
      devices: clone(state.devices),
      currentOperation: current ? publicOperation(current) : null,
      recentOperations: state.operations.slice(0, 8).map(publicOperation),
      updatedAt: now(),
    }
  }

  const listDevices = async (_args, context) => {
    const state = ensureSession(context.session.key)
    return result({
      status: 'ok',
      devices: clone(state.devices),
      count: state.devices.length,
    })
  }

  const getDeviceState = async ({ deviceId }, context) => {
    const state = ensureSession(context.session.key)
    const device = state.devices.find((item) => item.deviceId === deviceId)
    if (!device) throw new Error(`unknown device: ${deviceId}`)
    return result({ status: 'ok', device: clone(device) })
  }

  const controlDevice = async (args, context) => {
    const state = ensureSession(context.session.key)
    const device = state.devices.find((item) => item.deviceId === args.deviceId)
    if (!device) throw new Error(`unknown device: ${args.deviceId}`)
    const action = resolveAction(device.deviceType, args.action)
    if (!action) throw new Error(`action ${args.action} is not supported by ${args.deviceId}`)
    if (device.controlState !== 'ready') throw new Error(`device is busy: ${args.deviceId}`)

    const startedAt = now()
    const durationMs = args.durationMs ?? action.durationMs
    const operation = {
      taskId: shortId('task'),
      planId: shortId('plan'),
      operationId: shortId('op'),
      commandId: shortId('cmd'),
      receiptId: null,
      sessionId: state.sessionId,
      toolUseId: context.session.toolUseId,
      deviceId: device.deviceId,
      deviceType: device.deviceType,
      deviceName: device.displayName,
      action: action.id,
      actionLabel: action.label,
      parameters: {
        ...(args.distanceMeters === undefined ? {} : { distanceMeters: args.distanceMeters }),
        ...(args.speedMetersPerSecond === undefined
          ? {}
          : { speedMetersPerSecond: args.speedMetersPerSecond }),
        ...(args.angleDegrees === undefined ? {} : { angleDegrees: args.angleDegrees }),
        durationMs,
      },
      status: 'planning',
      progress: 0,
      startedAt,
      motionStartedAt: null,
      motionCompletedAt: null,
      completedAt: null,
      updatedAt: startedAt,
      todos: [
        { id: 'bind', title: '建立控制会话', status: 'pending' },
        { id: 'validate', title: '校验动作与参数', status: 'pending' },
        { id: 'dispatch', title: '下发设备指令', status: 'pending' },
        { id: 'execute', title: `执行${action.label}`, status: 'pending' },
        { id: 'receipt', title: '同步状态与生成回执', status: 'pending' },
      ],
      events: [],
    }
    state.operations.unshift(operation)
    state.operations.splice(20)
    state.currentOperationId = operation.operationId
    device.controlState = 'planning'
    device.lastCommandId = operation.commandId
    device.updatedAt = now()

    try {
      emit(
        state,
        operation,
        'TASK_RECEIVED',
        {
          input: clone(args),
          message: `收到 ${device.displayName} 的${action.label}任务`,
          status: 'received',
        },
        context,
      )
      emit(
        state,
        operation,
        'DEVICE_RESOLVED',
        {
          status: 'online',
          device: {
            deviceId: device.deviceId,
            deviceType: device.deviceType,
            displayName: device.displayName,
            model: device.model,
            batteryPercent: device.batteryPercent,
          },
          message: `目标设备 ${device.deviceId} 已就绪，匹配动作 ${action.id}`,
        },
        context,
      )
      await wait(160, context.signal)
      emit(
        state,
        operation,
        'CONTROL_PLAN_CREATED',
        {
          status: 'planned',
          steps: operation.todos.map((todo, index) => ({
            step: index + 1,
            todoId: todo.id,
            title: todo.title,
          })),
          message: `控制计划已生成：共 ${operation.todos.length} 个步骤`,
        },
        context,
      )
      startTodo(state, operation, 0, context)
      await wait(220, context.signal)
      emit(
        state,
        operation,
        'CONTROL_CHANNEL_READY',
        { status: 'ready', message: '控制会话与设备目标已绑定' },
        context,
      )
      finishTodo(state, operation, 0, context)

      startTodo(state, operation, 1, context)
      await wait(220, context.signal)
      emit(
        state,
        operation,
        'COMMAND_PARAMETERS_VALIDATED',
        {
          status: 'passed',
          checks: {
            deviceOnline: true,
            commandSupported: true,
            motionRangeValid: true,
            speedWithinLimit: true,
            commandTimeoutConfigured: true,
          },
          message: `动作 ${action.id}、时长 ${durationMs} ms 与目标参数已校验`,
        },
        context,
      )
      finishTodo(state, operation, 1, context)

      startTodo(state, operation, 2, context)
      operation.status = 'queued'
      emit(
        state,
        operation,
        'COMMAND_QUEUED',
        { status: 'queued', queuePosition: 1, message: '指令已进入执行队列' },
        context,
      )
      await wait(240, context.signal)
      operation.status = 'dispatched'
      emit(
        state,
        operation,
        'COMMAND_DISPATCHED',
        {
          status: 'dispatched',
          action: action.id,
          parameters: clone(operation.parameters),
          message: `已下发 ${action.label} 指令`,
        },
        context,
      )
      await wait(240, context.signal)
      emit(
        state,
        operation,
        'DEVICE_COMMAND_ACCEPTED',
        { status: 'accepted', message: '动作指令已进入执行阶段' },
        context,
      )
      finishTodo(state, operation, 2, context)

      startTodo(state, operation, 3, context)
      operation.status = 'executing'
      operation.motionStartedAt = now()
      device.controlState = 'executing'
      device.posture = action.id.includes('forward') || action.id === 'reverse' ? 'moving' : device.posture
      emit(
        state,
        operation,
        'DEVICE_MOTION_STARTED',
        { status: 'executing', action: action.id, progress: 0, message: `${action.label}动作开始` },
        context,
      )

      const interval = Math.max(40, Math.round(durationMs / 5))
      for (const [index, progress] of [20, 40, 60, 80].entries()) {
        await wait(interval, context.signal)
        operation.progress = progress
        emit(
          state,
          operation,
          'DEVICE_MOTION_PROGRESS',
          {
            status: 'executing',
            progress,
            elapsedMs: Math.round((durationMs * progress) / 100),
            estimatedRemainingMs: Math.round((durationMs * (100 - progress)) / 100),
            message: action.stages[index],
          },
          context,
        )
      }
      await wait(interval, context.signal)

      operation.progress = 100
      operation.status = 'settling'
      operation.motionCompletedAt = now()
      const motionElapsedMs =
        new Date(operation.motionCompletedAt).getTime() - new Date(operation.motionStartedAt).getTime()
      operation.receiptId = shortId('receipt')
      device.controlState = 'ready'
      device.posture =
        action.id === 'sit'
          ? 'sitting'
          : action.id === 'lie_down'
            ? 'lying'
            : action.id === 'park'
              ? 'parked'
              : 'standing'
      device.batteryPercent = Math.max(1, device.batteryPercent - 1)
      device.updatedAt = operation.motionCompletedAt
      emit(
        state,
        operation,
        'DEVICE_MOTION_COMPLETED',
        {
          status: 'succeeded',
          progress: 100,
          result: {
            action: action.id,
            requestedMotionMs: durationMs,
            motionElapsedMs,
            ...clone(operation.parameters),
          },
          message: `${action.label}动作完成`,
        },
        context,
      )
      finishTodo(state, operation, 3, context)

      startTodo(state, operation, 4, context)
      await wait(160, context.signal)
      operation.completedAt = now()
      const elapsedMs = new Date(operation.completedAt).getTime() - new Date(operation.startedAt).getTime()
      emit(
        state,
        operation,
        'DEVICE_STATE_UPDATED',
        {
          status: 'ready',
          state: {
            controlState: device.controlState,
            posture: device.posture,
            batteryPercent: device.batteryPercent,
            lastCommandId: device.lastCommandId,
          },
          message: `设备状态已更新为 ${device.controlState} / ${device.posture}`,
        },
        context,
      )
      emit(
        state,
        operation,
        'EXECUTION_RECEIPT_CREATED',
        {
          status: 'succeeded',
          receiptId: operation.receiptId,
          startedAt: operation.startedAt,
          completedAt: operation.completedAt,
          elapsedMs,
          requestedMotionMs: durationMs,
          motionElapsedMs,
          receiptSource: 'event-loopback',
          message: `执行回执 ${operation.receiptId} 已生成`,
        },
        context,
      )
      finishTodo(state, operation, 4, context)
      operation.status = 'succeeded'
      emit(
        state,
        operation,
        'TASK_COMPLETED',
        {
          status: 'succeeded',
          summary: `${device.displayName} 已完成${action.label}。`,
          receiptId: operation.receiptId,
          message: `${action.label}任务执行成功`,
        },
        context,
      )

      return result({
        operationId: operation.operationId,
        commandId: operation.commandId,
        receiptId: operation.receiptId,
        deviceId: device.deviceId,
        deviceType: device.deviceType,
        action: action.id,
        actionLabel: action.label,
        status: 'succeeded',
        progress: 100,
        startedAt: operation.startedAt,
        completedAt: operation.completedAt,
        elapsedMs,
        requestedMotionMs: durationMs,
        motionElapsedMs,
        receiptSource: 'event-loopback',
        summary: `${device.displayName} 已完成${action.label}。`,
      })
    } catch (error) {
      operation.status = 'failed'
      operation.completedAt = now()
      device.controlState = 'ready'
      device.updatedAt = operation.completedAt
      for (const todo of operation.todos) if (todo.status === 'running') todo.status = 'failed'
      emit(
        state,
        operation,
        context.signal?.aborted ? 'MOTION_INTERRUPTED' : 'TASK_FAILED',
        {
          status: 'failed',
          reason: error instanceof Error ? error.message : 'device operation failed',
          message: context.signal?.aborted ? '控制任务已中断' : '控制任务执行失败',
        },
        context,
      )
      throw error
    }
  }

  const runtime = {
    inject: ['extension'],
    apply(ctx) {
      const agnes = ctx.extension()
      agnes.registerTool({
        name: 'mhs_list_devices',
        description:
          'List the robot dogs and robot cars available to the MHS device-control system, including their current state and supported actions.',
        parameters: noParameters,
        meta: readMeta,
        execute: listDevices,
      })
      agnes.registerTool({
        name: 'mhs_get_device_state',
        description: 'Read the current state of one MHS robot dog or robot car.',
        parameters: deviceParameters,
        meta: readMeta,
        execute: getDeviceState,
      })
      agnes.registerTool({
        name: 'mhs_control_device',
        description:
          'Control an MHS robot dog or robot car. Dog actions include stand (站立), lie_down (卧倒/趴下), sit (坐下), heart (比心), new_year_greeting (拜年), dance (舞蹈), stretch (伸懒腰), front_pounce (扑人/前扑), front_flip or back_flip (翻跟斗), left_flip (侧翻), front_jump (跳跃), hello (打招呼), move_forward, move_backward, turn_left, turn_right, stop. Car actions: drive_forward, reverse, turn_left, turn_right, park, stop. Call mhs_list_devices when uncertain. Every call emits detailed control steps and returns a receipt.',
        parameters: controlParameters,
        meta: controlMeta,
        execute: controlDevice,
      })
      ctx.services.register({
        name: 'mhs.operation.snapshot',
        kind: 'query',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            revision: { type: 'number' },
            connected: { type: 'boolean' },
            devices: { type: 'array', items: { type: 'object', additionalProperties: true } },
            currentOperation: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
            recentOperations: { type: 'array', items: { type: 'object', additionalProperties: true } },
            updatedAt: { type: 'string' },
          },
          required: [
            'sessionId',
            'revision',
            'connected',
            'devices',
            'currentOperation',
            'recentOperations',
            'updatedAt',
          ],
          additionalProperties: false,
        },
        timeoutMs: 1000,
        maxResultBytes: 262144,
        async handler(_input, context) {
          return snapshot(context.sessionId)
        },
      })
      ctx.effect(() => () => sessions.clear())
    },
  }

  return { runtime, snapshot }
}

export const { runtime } = createMhsRuntime()
