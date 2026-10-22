const object = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const text = (maxLength = 4096) => ({ type: 'string', minLength: 1, maxLength })
export const empty = object()
export const pageInput = object(
  {
    pageId: text(100),
    mode: { enum: ['human', 'agent'] },
  },
  ['pageId'],
)
export const controlInput = { ...pageInput, required: ['pageId', 'mode'] }
export const viewportInput = object(
  {
    width: { type: 'integer', minimum: 240, maximum: 2560 },
    height: { type: 'integer', minimum: 160, maximum: 1600 },
  },
  ['width', 'height'],
)
const viewInput = object(
  {
    ...pageInput.properties,
    viewId: text(100),
    displayVersion: { type: 'integer', enum: [2] },
    viewport: viewportInput,
  },
  ['pageId'],
)
const outputSchema = { type: 'object', additionalProperties: true }
const effectPolicy = {
  isDestructive: false,
  isOpenWorld: false,
  replay: 'never',
  requiresApproval: 'never',
  approvalScopes: [],
}
const service = (name, kind, scope, inputSchema, extras = {}) => ({
  name,
  kind,
  scope,
  inputSchema,
  outputSchema,
  timeoutMs: 30_000,
  maxResultBytes: 65536,
  ...(kind === 'effect' ? { effectPolicy } : {}),
  ...extras,
})
export const services = [
  service('browser.status', 'query', 'profile', empty),
  service('browser.pages', 'query', 'session', empty),
  service(
    'browser.events',
    'query',
    'session',
    object(
      {
        pageId: text(100),
        cursor: { type: 'integer', minimum: 0 },
      },
      ['pageId'],
    ),
  ),
  service('browser.stream', 'query', 'session', viewInput),
  // Admission prepares a bounded session channel; it does not take control of a page.
  service('browser.connect', 'effect', 'session', empty, {
    controlLeaseMs: 30_000,
    controlSessionMs: 300_000,
  }),
  service('browser.close', 'effect', 'session', object({ pageId: text(100) }, ['pageId'])),
  service(
    'browser.view',
    'effect',
    'session',
    object(
      {
        viewId: text(100),
        pageId: text(100),
        sequence: { type: 'integer', minimum: 1 },
        viewport: viewportInput,
      },
      ['viewId', 'pageId', 'sequence'],
    ),
  ),
  service(
    'browser.open',
    'effect',
    'session',
    object({ url: text(8192), previewRoot: text(4096) }, ['url']),
    {
      effectPolicy: { ...effectPolicy, isOpenWorld: true },
    },
  ),
  service('browser.control', 'effect', 'session', controlInput, {
    controlLeaseMs: 30_000,
    controlSessionMs: 300_000,
  }),
]
export const streams = [
  {
    name: 'browser.interaction',
    scope: 'session',
    inputSchema: empty,
    directions: ['inbound', 'outbound'],
    lane: 'control',
    maxFrameBytes: 4096,
    maxBufferedBytes: 32768,
    maxBytesPerSecond: 122880,
    controlService: 'browser.connect',
    readService: 'browser.pages',
  },
  {
    name: 'browser.state',
    scope: 'profile',
    inputSchema: empty,
    directions: ['outbound'],
    lane: 'events',
    maxFrameBytes: 4096,
    maxBufferedBytes: 32768,
    maxBytesPerSecond: 65536,
  },
  {
    name: 'browser.pages',
    scope: 'session',
    inputSchema: empty,
    directions: ['outbound'],
    lane: 'events',
    maxFrameBytes: 4096,
    maxBufferedBytes: 32768,
    maxBytesPerSecond: 65536,
    readService: 'browser.pages',
  },
  {
    name: 'browser.frames',
    scope: 'session',
    inputSchema: viewInput,
    directions: ['outbound'],
    lane: 'media',
    maxFrameBytes: 1_048_000,
    maxBufferedBytes: 2_097_152,
    maxBytesPerSecond: 4_194_304,
    readService: 'browser.stream',
  },
  {
    name: 'browser.input',
    scope: 'session',
    inputSchema: controlInput,
    directions: ['inbound', 'outbound'],
    lane: 'control',
    maxFrameBytes: 4096,
    maxBufferedBytes: 32768,
    maxBytesPerSecond: 122880,
    controlService: 'browser.control',
    readService: 'browser.stream',
  },
]
export const managed = {
  id: 'browserruntime',
  scope: 'profile',
  artifact: { kind: 'in-process' },
  apiVersion: '1.0.0',
  healthPath: '/health',
  listeners: [],
  requires: [],
  startupTimeoutMs: 5000,
  shutdownTimeoutMs: 5000,
}
// Tool validation consumes TypeBox schemas; service manifests consume plain JSON schemas.
// Mirror the existing bundled document-reader's symbols without adding a runtime dependency.
const Kind = Symbol.for('TypeBox.Kind'),
  Optional = Symbol.for('TypeBox.Optional')
function toolSchema(schema) {
  if (schema.enum)
    return {
      [Kind]: 'Union',
      anyOf: schema.enum.map((value) => ({ [Kind]: 'Literal', type: typeof value, const: value })),
    }
  if (schema.type === 'object')
    return {
      ...schema,
      [Kind]: 'Object',
      properties: Object.fromEntries(
        Object.entries(schema.properties).map(([name, value]) => [
          name,
          { ...toolSchema(value), ...(!schema.required.includes(name) ? { [Optional]: 'Optional' } : {}) },
        ]),
      ),
    }
  return { ...schema, [Kind]: { string: 'String', number: 'Number', integer: 'Integer' }[schema.type] }
}
export const parameters = toolSchema(
  object(
    {
      action: {
        enum: [
          'status',
          'open',
          'tabs',
          'inspect',
          'screenshot',
          'events',
          'click',
          'fill',
          'key',
          'scroll',
          'wait',
          'back',
          'forward',
          'reload',
          'close',
        ],
      },
      pageId: text(100),
      pageEpoch: { type: 'integer', minimum: 0 },
      ref: text(100),
      url: text(8192),
      previewRoot: text(4096),
      text: { type: 'string', maxLength: 10_000 },
      key: text(80),
      x: { type: 'number', minimum: -4000, maximum: 4000 },
      y: { type: 'number', minimum: -4000, maximum: 4000 },
      cursor: { type: 'integer', minimum: 0 },
    },
    ['action'],
  ),
)
export const readActions = new Set(['status', 'tabs', 'inspect', 'screenshot', 'events'])
