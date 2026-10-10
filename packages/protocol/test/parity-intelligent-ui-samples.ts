const placement = { inline: true, workbench: true }
const component = { id: 'form', kind: 'form', dataKey: 'input', schema: { type: 'object' } }
const custom = {
  id: 'custom',
  kind: 'finance/diff@1',
  dataKey: 'rows',
  fallback: 'Review the preset table.',
  actionIds: ['submit'],
}
const surface = {
  id: 'surface',
  revision: 1,
  title: 'Synthetic form',
  placement,
  components: [component],
  data: {},
  actions: [],
}
const params = {
  sessionId: 's',
  surfaceId: 'surface',
  revision: 1,
  actionId: 'submit',
  commandId: 'c',
  input: {},
  selection: {},
}
const receipt = {
  sessionId: 's',
  surfaceId: 'surface',
  revision: 1,
  actionId: 'submit',
  commandId: 'c',
  status: 'succeeded',
  seq: 1,
  duplicate: false,
}
const record = {
  surface,
  status: 'open',
  createdSeq: 1,
  updatedSeq: 1,
  owner: 'plugin',
  lane: 'main',
  taskId: 't',
}
const sample = (valid: unknown, invalid: unknown[]) => ({
  valid,
  invalid,
  note: 'Intelligent UI public wire contract',
})
export const intelligentUiSamples = {
  JsonValue: sample({ value: [true, null] }, [undefined]),
  UiKey: sample('surface', ['', '1invalid', 'a'.repeat(65)]),
  UiRevision: sample(1, [0, 1.5]),
  UiJsonSchema: sample({ type: 'object' }, [null, []]),
  UiPlacement: sample(placement, [{ inline: true }, { ...placement, workbench: false }]),
  UiColumn: sample({ key: 'price', label: 'Price' }, [{ key: 'price' }, { key: 'price', label: '' }]),
  UiChartSeries: sample({ key: 'price', label: 'Price' }, [{ key: 'price' }]),
  UiComponent: sample(component, [
    { ...component, kind: 'html' },
    { ...component, schema: null },
  ]),
  UiCustomComponent: sample(custom, [
    { ...custom, kind: 'html' },
    { ...custom, kind: 'finance/diff@0' },
    { ...custom, fallback: '' },
    { ...custom, fallback: 'x'.repeat(4097) },
    { ...custom, actionIds: ['submit', 'submit'] },
    { ...custom, html: '<script>untrusted</script>' },
  ]),
  UiArgument: sample({ from: 'input', key: 'name', pointer: '/name' }, [
    { from: 'secret', key: 'name' },
    { literal: null, from: 'input' },
  ]),
  UiAction: sample({ id: 'submit', label: 'Submit', tool: 'save', argsTemplate: {}, paramsSchema: true }, [
    { id: 'submit' },
  ]),
  UiSurface: sample(surface, [
    { ...surface, components: [] },
    { ...surface, revision: 0 },
  ]),
  UiRowContext: sample({ tableId: 'table', rowId: 'row' }, [{ tableId: 'table', rowId: '' }]),
  UiActionParams: sample(params, [
    { ...params, input: [] },
    { ...params, selection: { table: ['row', 'row'] } },
  ]),
  UiActionStatus: sample('succeeded', ['cancelled']),
  UiRefusal: sample({ reason: 'unauthorized', code: 'UI_UNAUTHORIZED', message: 'Refused' }, [
    { reason: 'unauthorized', code: 'ALLOW', message: 'Refused' },
  ]),
  UiFailure: sample({ code: 'FAILED', message: 'Failed', retryable: false, outcomeUnknown: true }, [
    { code: 'FAILED' },
  ]),
  UiActionReceipt: sample(receipt, [
    { ...receipt, seq: 0 },
    { ...receipt, duplicate: 'false' },
  ]),
  UiSurfaceRecord: sample(record, [{ ...record, owner: '' }]),
  UiDataBinding: sample({ $source: 'ledger/rows', params: { account: 'cash' } }, [
    { $source: 'Ledger/rows', params: {} },
    { $source: 'ledger/rows' },
  ]),
  UiSourceStatus: sample({ status: 'ready', resultHash: 'a'.repeat(64) }, [
    { status: 'stale' },
    { status: 'error', code: 'NOPE' },
  ]),
  UiRefreshParams: sample({ sessionId: 's', surfaceId: 'surface' }, [
    { sessionId: 's' },
    { sessionId: '', surfaceId: 'surface' },
  ]),
  UiReadParams: sample({ sessionId: 's' }, [{ sessionId: 's', limit: 17 }]),
  UiReadResult: sample({ sessionId: 's', lastSeq: 1, surfaces: [record], actions: [receipt] }, [
    { sessionId: 's', lastSeq: -1, surfaces: [], actions: [] },
  ]),
  UiRenderParams: sample({ surface }, [{}]),
  UiUpdateParams: sample({ surfaceId: 'surface', expectedRevision: 1, surface }, [
    { surfaceId: 'surface', expectedRevision: 0, surface },
  ]),
  UiCloseParams: sample({ surfaceId: 'surface', expectedRevision: 1 }, [{ surfaceId: 'surface' }]),
}
