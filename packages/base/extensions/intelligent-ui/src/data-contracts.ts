import { X_AGNES_UI_LIMITS as limits } from '@agnes/protocol/gen/intelligent-ui'

/** Model guidance, also used to explain pre-effect data rejections. */
export const UI_DATA_CONTRACTS = {
  'artifact-file':
    '{name,description,artifact:{sha256,size,mime}} from artifacts.put in this session/lane; exact ref, size in bytes. No invented refs, paths or URLs. present creates file cards (preview/download).',
  text: 'string, e.g. "Summary".',
  status: 'string, e.g. "Ready".',
  table: `<=${limits.tableRows} rows, e.g. [{"id":"r1","amount":12}]. rowKey values: unique strings 1..128 chars; include every columns[].key.`,
  chart: `<=${limits.chartPoints} points, e.g. [{"label":"A","amount":12}]; categoryKey values: strings; series[].key values: finite numbers. Pie: one nonnegative series.`,
  form: 'Draft/default JSON per component.schema (local synchronous JSON Schema); incomplete drafts allowed; date/date-time: real ISO calendar values or empty drafts. Input binds component.id, not dataKey; argsTemplate keys match tool (ui_submit: answers, not values). E.g. component {id:"f",kind:"form",dataKey:"d",schema:{type:"object"},actionIds:["submit"]}; data {d:{}}; ui_submit argsTemplate {surfaceId:{literal:"contact"},answers:{from:"input",key:"f"}}.',
  'detail-card': `every fields[].key (<=${limits.detailFields} distinct), e.g. {"amount":12}. Optional statusKey/secondaryKey values: nonempty strings <=256/1024 chars.`,
  steps: `1..${limits.steps} objects {id,label,state,description?}, e.g. [{"id":"review","label":"Review","state":"active"}]. Unique id: [A-Za-z][A-Za-z0-9_.-]{0,63}; label: 1..256 chars; description: 1..1024; state: done|active|pending|error.`,
  progress:
    '{label,value,total}, e.g. {"label":"Checks","value":2,"total":5}. label: 1..256 chars; finite 0<=value<=total, total>0.',
  image: `exact {source}; source exactly: existing {kind:"artifact",sha256:"64 lower hex",size:1..${limits.imageArtifactBytes},mime:"image/png"|"image/jpeg"}, {kind:"attachment",uri:"existing agnes-upload:// URI"}, or {kind:"data-url",dataUrl:"png/jpeg base64 data URL"} <=${limits.imageDataUrlBytes} UTF-8 bytes. No remote URLs.`,
  'button-group':
    'no dataKey/data; declared actionIds, e.g. {id:"buttons",kind:"button-group",actionIds:["confirm"]}.',
  tabs: `no dataKey/data; 1..${limits.tabs} distinct tabs, each 1..${limits.tabItems} existing non-tab componentIds, each component in one tab only. E.g. {id:"pages",kind:"tabs",tabs:[{id:"overview",label:"Overview",componentIds:["summary"]}]}.`,
} as const

export const UI_DATA_DESCRIPTION =
  'Data: surface.data[component.dataKey], never inside components.\n' +
  Object.entries(UI_DATA_CONTRACTS)
    .map(([kind, contract]) => `${kind}: ${contract}`)
    .join('\n') +
  '\nPinned custom kinds: declared propsSchema and exact fallback. Data-source binding: {"$source":"vendor/source","params":{}} instead of literal data; no actor/session/permission fields in params.'
