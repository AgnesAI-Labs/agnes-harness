import { X_AGNES_UI_LIMITS as limits } from '@agnes/protocol/gen/intelligent-ui'

/** Deferred model guidance, also used to explain pre-effect data rejections. */
export const UI_DATA_CONTRACTS = {
  'artifact-file':
    'object {name,description,artifact:{sha256,size,mime}}. Use an existing authorized session artifact, never a URL or workspace path. Web offers safe preview and download.',
  text: 'string. Example: "Review summary".',
  status: 'string. Example: "Ready for review".',
  table: `array of <=${limits.tableRows} objects; rowKey values are unique nonempty strings <=128 chars, and every columns[].key is present. Example: [{"id":"r1","amount":12}] with rowKey="id" and columns for id,amount.`,
  chart: `array of <=${limits.chartPoints} objects; categoryKey is a string and every series[].key is a finite number. Pie uses exactly one series with nonnegative values. Example: [{"label":"A","amount":12}] with categoryKey="label" and series key="amount".`,
  form: 'Input bindings use component.id, not dataKey; argsTemplate names match the target tool (ui_submit uses answers, not values). Minimal form: component {id:"fields",kind:"form",dataKey:"draft",schema:{type:"object",properties:{name:{type:"string"}}},actionIds:["submit"]}; data {draft:{}}; ui_submit argsTemplate {surfaceId:{literal:"contact"},answers:{from:"input",key:"fields"}}. Draft/default JSON described by component.schema, a local synchronous JSON Schema; incomplete defaults are allowed. Present date/date-time values must be real ISO calendar values (empty drafts allowed). Example: {"name":"Ada"} for a schema with a string name field.',
  'detail-card': `object containing every fields[].key (<=${limits.detailFields} distinct fields). Optional statusKey points to a nonempty string <=256 chars; secondaryKey to a nonempty string <=1024 chars. Example: {"amount":12,"status":"Ready","note":"Review"} with fields key="amount", statusKey="status", secondaryKey="note".`,
  steps: `array of 1..${limits.steps} objects {id,label,state,description?}; unique id matches [A-Za-z][A-Za-z0-9_.-]{0,63}, label is 1..256 chars, optional description 1..1024 chars, state is done|active|pending|error. Example: [{"id":"collect","label":"Collect evidence","state":"done"},{"id":"review","label":"Review","state":"active"}].`,
  progress:
    'object {label,value,total}; nonempty label <=256 chars; finite numbers with 0<=value<=total and total>0. Example: {"label":"Checks","value":2,"total":5}.',
  image: `exact object {source}; source is exactly {kind:"artifact",sha256:"64 lowercase hex",size:1..${limits.imageArtifactBytes},mime:"image/png"|"image/jpeg"}, {kind:"attachment",uri:"existing agnes-upload:// URI"}, or {kind:"data-url",dataUrl:"png/jpeg base64 data URL"} <=${limits.imageDataUrlBytes} UTF-8 bytes. Use an existing image reference, never a remote URL. Example: {"source":{"kind":"artifact","sha256":"${'a'.repeat(64)}","size":1024,"mime":"image/png"}}.`,
  'button-group':
    'no dataKey or data value; actionIds reference declared actions. Example component: {"id":"buttons","kind":"button-group","actionIds":["confirm"]}.',
  tabs: `no dataKey or data value; 1..${limits.tabs} tabs with distinct ids, each with 1..${limits.tabItems} componentIds referencing existing non-tab components, placed in only one tab. Example component: {"id":"pages","kind":"tabs","tabs":[{"id":"overview","label":"Overview","componentIds":["summary"]}]}.`,
} as const

export const UI_DATA_DESCRIPTION =
  'Component data contracts: put each value in surface.data[component.dataKey], not inside the component. ' +
  Object.entries(UI_DATA_CONTRACTS)
    .map(([kind, contract]) => `${kind}: ${contract}`)
    .join('\n') +
  '\nPinned custom kinds use the declared propsSchema and exact fallback, e.g. {"amount":12} for a declared numeric amount property. Declared data-source bindings may replace literal data: {"$source":"vendor/source","params":{}}. No actor/session/permission fields in source params.'
