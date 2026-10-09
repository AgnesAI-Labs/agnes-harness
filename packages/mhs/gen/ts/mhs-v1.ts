// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'

export const ParamSchema = Type.Recursive((This) => Type.Object({ "type": Type.Optional(Type.Union([Type.Literal('object'), Type.Literal('number'), Type.Literal('integer'), Type.Literal('string'), Type.Literal('boolean'), Type.Literal('array')])), "properties": Type.Optional(Type.Record(Type.String(), This)), "required": Type.Optional(Type.Array(Type.String())), "default": Type.Optional(Type.Unknown()), "minimum": Type.Optional(Type.Number()), "maximum": Type.Optional(Type.Number()), "maxLength": Type.Optional(Type.Integer({ minimum: 0 })), "items": Type.Optional(This), "minItems": Type.Optional(Type.Integer({ minimum: 0 })), "maxItems": Type.Optional(Type.Integer({ minimum: 0 })), "enum": Type.Optional(Type.Array(Type.Unknown(), { minItems: 1 })), "description": Type.Optional(Type.String()), "ui": Type.Optional(Type.Ref('ParamUi')) }, { additionalProperties: false }))
export type ParamSchema = Static<typeof ParamSchema>

export const MhsV1 = Type.Module({
  "DeviceId": Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,31}$" }),
  "Name": Type.String({ pattern: "^[a-z][a-z0-9_]{0,31}$" }),
  "MapId": Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }),
  "ToolName": Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" }),
  "CustomName": Type.String({ pattern: "^x_[a-z][a-z0-9_]{0,31}$" }),
  "Time": Type.Number(),
  "Text": Type.String(),
  "Short": Type.String({ maxLength: 40 }),
  "Vec2": Type.Array(Type.Number(), { minItems: 2, maxItems: 2 }),
  "Vec3": Type.Array(Type.Number(), { minItems: 3, maxItems: 3 }),
  "Size": Type.Array(Type.Integer({ minimum: 1 }), { minItems: 2, maxItems: 2 }),
  "Range": Type.Array(Type.Number({ minimum: 0 }), { minItems: 2, maxItems: 2 }),
  "Kind": Type.Union([Type.Union([Type.Literal('image'), Type.Literal('video'), Type.Literal('scan'), Type.Literal('points'), Type.Literal('audio'), Type.Literal('imu'), Type.Literal('odometry'), Type.Literal('gnss'), Type.Literal('values'), Type.Literal('switch'), Type.Literal('text'), Type.Literal('detections'), Type.Literal('pose'), Type.Literal('grid'), Type.Literal('transcript'), Type.Literal('world')]), Type.Ref('CustomName')]),
  "AxisRole": Type.Union([Type.Union([Type.Literal('forward'), Type.Literal('turn'), Type.Literal('strafe'), Type.Literal('up'), Type.Literal('roll'), Type.Literal('pitch'), Type.Literal('yaw'), Type.Literal('zoom'), Type.Literal('grip'), Type.Literal('joint')]), Type.Ref('CustomName')]),
  "FieldRole": Type.Union([Type.Union([Type.Literal('battery'), Type.Literal('voltage'), Type.Literal('current'), Type.Literal('power'), Type.Literal('charging'), Type.Literal('temperature'), Type.Literal('cpu'), Type.Literal('memory'), Type.Literal('storage'), Type.Literal('signal'), Type.Literal('consumable'), Type.Literal('heart_rate'), Type.Literal('body_temperature'), Type.Literal('spo2')]), Type.Ref('CustomName')]),
  "Status": Type.Union([Type.Literal('done'), Type.Literal('rejected'), Type.Literal('interrupted'), Type.Literal('error')]),
  "Reason": Type.Union([Type.Union([Type.Literal('invalid'), Type.Literal('busy'), Type.Literal('unsafe'), Type.Literal('offline'), Type.Literal('denied'), Type.Literal('stop'), Type.Literal('cancel'), Type.Literal('manual'), Type.Literal('estop'), Type.Literal('preempted'), Type.Literal('pause_timeout'), Type.Literal('disconnect'), Type.Literal('dependency'), Type.Literal('timeout'), Type.Literal('stuck'), Type.Literal('unreachable'), Type.Literal('failed')]), Type.Ref('CustomName')]),
  "RejectReason": Type.Union([Type.Union([Type.Literal('invalid'), Type.Literal('unsafe')]), Type.Ref('CustomName')]),
  "InterruptReason": Type.Union([Type.Union([Type.Literal('stop'), Type.Literal('cancel'), Type.Literal('manual'), Type.Literal('estop'), Type.Literal('pause_timeout')]), Type.Ref('CustomName')]),
  "ErrorReason": Type.Union([Type.Union([Type.Literal('dependency'), Type.Literal('timeout'), Type.Literal('stuck'), Type.Literal('unreachable'), Type.Literal('failed')]), Type.Ref('CustomName')]),
  "Unit": Type.Union([Type.Union([Type.Literal('m'), Type.Literal('mm'), Type.Literal('m/s'), Type.Literal('m/s²'), Type.Literal('deg'), Type.Literal('deg/s'), Type.Literal('rad'), Type.Literal('rad/s'), Type.Literal('s'), Type.Literal('ms'), Type.Literal('min'), Type.Literal('Hz'), Type.Literal('bpm'), Type.Literal('V'), Type.Literal('A'), Type.Literal('W'), Type.Literal('Wh'), Type.Literal('%'), Type.Literal('°C'), Type.Literal('Pa'), Type.Literal('kPa'), Type.Literal('lux'), Type.Literal('ppm'), Type.Literal('dB'), Type.Literal('dBm'), Type.Literal('kg'), Type.Literal('N'), Type.Literal('N·m'), Type.Literal('kbit/s')]), Type.Ref('CustomName')]),
  "Encoding": Type.Union([Type.Literal('rgb'), Type.Literal('mono'), Type.Literal('depth'), Type.Literal('thermal'), Type.Literal('ir')]),
  "Localization": Type.Union([Type.Literal('none'), Type.Literal('fixed'), Type.Literal('self'), Type.Literal('external')]),
  "Placement": Type.Object({ "map": Type.Ref('MapId'), "x": Type.Number(), "y": Type.Number(), "yaw": Type.Number() }),
  "Place": Type.Union([Type.Ref('Landmark'), Type.Ref('Zone')]),
  "Landmark": Type.Object({ "id": Type.Ref('MapId'), "name": Type.String(), "at": Type.Ref('Vec2'), "yaw": Type.Optional(Type.Number()), "description": Type.Optional(Type.Ref('Text')) }, { additionalProperties: false }),
  "Zone": Type.Object({ "id": Type.Ref('MapId'), "name": Type.String(), "points": Type.Array(Type.Ref('Vec2'), { minItems: 3 }), "description": Type.Optional(Type.Ref('Text')) }, { additionalProperties: false }),
  "MapAnchor": Type.Union([Type.Object({ "map": Type.Ref('MapId'), "x": Type.Number(), "y": Type.Number(), "yaw": Type.Number() }), Type.Object({ "lat": Type.Number({ minimum: -90, maximum: 90 }), "lon": Type.Number({ minimum: -180, maximum: 180 }), "heading": Type.Number() })]),
  "MapDecl": Type.Object({ "id": Type.Ref('MapId'), "name": Type.Optional(Type.String()), "bounds": Type.Optional(Type.Array(Type.Number(), { minItems: 4, maxItems: 4 })), "anchor": Type.Optional(Type.Ref('MapAnchor')), "places": Type.Optional(Type.Array(Type.Ref('Place'))) }),
  "ConflictPolicy": Type.Union([Type.Literal('reject'), Type.Literal('queue')]),
  "ErrorCode": Type.Union([Type.Literal(-32700), Type.Literal(-32600), Type.Literal(-32601), Type.Literal(-32602), Type.Literal(-32001), Type.Literal(-32003)]),
  "Request": Type.Object({ "jsonrpc": Type.Literal('2.0'), "id": Type.String({ minLength: 1 }), "method": Type.String(), "params": Type.Optional(Type.Object({  })) }),
  "Notification": Type.Object({ "jsonrpc": Type.Literal('2.0'), "method": Type.String(), "params": Type.Optional(Type.Object({  })) }),
  "Response": Type.Union([Type.Object({ "jsonrpc": Type.Literal('2.0'), "id": Type.String({ minLength: 1 }), "result": Type.Object({  }) }), Type.Object({ "jsonrpc": Type.Literal('2.0'), "id": Type.Union([Type.String(), Type.Null()]), "error": Type.Ref('Error') })]),
  "Error": Type.Object({ "code": Type.Integer(), "message": Type.String(), "data": Type.Optional(Type.Unknown()) }),
  "RegisterParams": Type.Object({ "protocol": Type.Literal('mhs/v1'), "device": Type.Ref('Device'), "profile": Type.Optional(Type.Ref('Profile')), "localization": Type.Optional(Type.Ref('Localization')), "placement": Type.Optional(Type.Ref('Placement')), "maps": Type.Optional(Type.Array(Type.Ref('MapDecl'))), "resources": Type.Optional(Type.Ref('Resources')), "state": Type.Optional(Type.Ref('StateFields')), "sources": Type.Optional(Type.Array(Type.Ref('Source'))), "tools": Type.Optional(Type.Array(Type.Ref('Tool'))), "manual": Type.Optional(Type.Ref('Manual')), "ui": Type.Optional(Type.Ref('DeviceUi')) }),
  "RegisterResult": Type.Object({ "session": Type.String(), "hub": Type.Object({ "name": Type.String(), "version": Type.String() }), "time": Type.Ref('Time') }),
  "CallParams": Type.Object({ "name": Type.Ref('ToolName'), "arguments": Type.Object({  }), "meta": Type.Optional(Type.Object({  })) }),
  "CallReply": Type.Union([Type.Ref('CallAccepted'), Type.Ref('CallRejectedBusy'), Type.Ref('CallRejected')]),
  "CallAccepted": Type.Object({ "accepted": Type.Literal(true) }),
  "CallRejectedBusy": Type.Object({ "accepted": Type.Literal(false), "status": Type.Literal('rejected'), "reason": Type.Literal('busy'), "detail": Type.Optional(Type.Ref('Text')), "holder": Type.Ref('Holder') }),
  "CallRejected": Type.Object({ "accepted": Type.Literal(false), "status": Type.Literal('rejected'), "reason": Type.Ref('RejectReason'), "detail": Type.Optional(Type.Ref('Text')) }),
  "Holder": Type.Union([Type.Object({ "call": Type.String(), "tool": Type.Ref('ToolName') }), Type.Object({ "manual": Type.Literal(true) })]),
  "ProgressParams": Type.Object({ "call": Type.String(), "done": Type.Optional(Type.Number()), "total": Type.Optional(Type.Number()), "text": Type.Optional(Type.Ref('Text')), "data": Type.Optional(Type.Object({  })), "state": Type.Optional(Type.Union([Type.Literal('paused'), Type.Literal('running')])) }),
  "ResultParams": Type.Union([Type.Ref('ResultDone'), Type.Ref('ResultInterrupted'), Type.Ref('ResultError')]),
  "ResultCommon": Type.Object({ "call": Type.String(), "detail": Type.Optional(Type.Ref('Text')), "notes": Type.Optional(Type.Array(Type.Ref('Text'))), "data": Type.Optional(Type.Object({  })), "after": Type.Optional(Type.Ref('After')) }),
  "ResultDone": Type.Intersect([Type.Ref('ResultCommon'), Type.Object({ "status": Type.Literal('done') })]),
  "ResultInterrupted": Type.Intersect([Type.Ref('ResultCommon'), Type.Object({ "status": Type.Literal('interrupted'), "reason": Type.Ref('InterruptReason') })]),
  "ResultError": Type.Intersect([Type.Ref('ResultCommon'), Type.Object({ "status": Type.Literal('error'), "reason": Type.Ref('ErrorReason') })]),
  "After": Type.Object({ "odometry": Type.Optional(Type.Ref('OdometryData')), "pose": Type.Optional(Type.Ref('PoseData')) }),
  "CallRef": Type.Object({ "call": Type.String() }),
  "Empty": Type.Object({  }),
  "CancelResult": Type.Object({ "cancelled": Type.Boolean() }),
  "StopResult": Type.Object({ "stopped": Type.Array(Type.String()) }),
  "PauseResult": Type.Object({ "paused": Type.Boolean() }),
  "ResumeResult": Type.Object({ "resumed": Type.Boolean() }),
  "ConfigureParams": Type.Object({ "sources": Type.Ref('SourceSettings') }),
  "ConfigureResult": Type.Object({ "sources": Type.Ref('SourceSettings') }),
  "SourceSettings": Type.Record(Type.String({ pattern: '^[a-z][a-z0-9_]{0,31}$' }), Type.Ref('SourceSetting'), { additionalProperties: false }),
  "SourceSetting": Type.Object({ "on": Type.Optional(Type.Boolean()), "hz": Type.Optional(Type.Number({ minimum: 0 })), "bitrate_kbps": Type.Optional(Type.Number({ minimum: 0 })), "size": Type.Optional(Type.Ref('Size')) }),
  "KeyframeParams": Type.Object({ "sources": Type.Array(Type.Ref('Name')) }),
  "KeyframeResult": Type.Object({ "sources": Type.Array(Type.Ref('Name')) }),
  "StateParams": Type.Object({ "t": Type.Ref('Time'), "values": Type.Ref('StateValues') }),
  "StateValues": Type.Record(Type.String({ pattern: '^[a-z][a-z0-9_]{0,31}$' }), Type.Union([Type.Number(), Type.Boolean(), Type.String(), Type.Null(), Type.Array(Type.String())]), { additionalProperties: false }),
  "SetParams": Type.Object({ "values": Type.Ref('StateValues') }),
  "SetResult": Type.Object({ "values": Type.Ref('StateValues'), "notes": Type.Optional(Type.Array(Type.Ref('Text'))), "refused": Type.Optional(Type.Record(Type.String({ pattern: '^[a-z][a-z0-9_]{0,31}$' }), Type.Ref('Text'), { additionalProperties: false })) }),
  "TimeResult": Type.Object({ "t": Type.Ref('Time') }),
  "NerveHello": Type.Object({ "type": Type.Literal('hello'), "device": Type.Ref('DeviceId') }),
  "NerveData": Type.Object({ "type": Type.Literal('data'), "source": Type.Ref('Name'), "seq": Type.Integer({ minimum: 0 }), "t": Type.Ref('Time'), "data": Type.Object({  }), "bin": Type.Optional(Type.Boolean()), "of_seq": Type.Optional(Type.Integer({ minimum: 0 })), "lag": Type.Optional(Type.Number({ minimum: 0 })) }),
  "NerveManual": Type.Object({ "type": Type.Literal('manual'), "axes": Type.Record(Type.String({ pattern: '^[a-z][a-z0-9_]{0,31}$' }), Type.Number(), { additionalProperties: false }) }),
  "NerveClip": Type.Object({ "type": Type.Literal('clip'), "id": Type.String({ minLength: 1 }), "rate": Type.Integer({ minimum: 1 }), "channels": Type.Integer({ minimum: 1 }) }),
  "Device": Type.Object({ "id": Type.Ref('DeviceId'), "kind": Type.Ref('Short'), "model": Type.Optional(Type.Ref('Short')), "name": Type.Optional(Type.Ref('Short')), "vendor": Type.Optional(Type.Ref('Short')), "firmware": Type.Optional(Type.Ref('Short')), "mobile": Type.Optional(Type.Boolean()), "radius": Type.Optional(Type.Number({ minimum: 0 })) }),
  "Profile": Type.Object({ "size_m": Type.Optional(Type.Ref('Vec3')), "weight_kg": Type.Optional(Type.Number({ minimum: 0 })), "max_speed": Type.Optional(Type.Number({ minimum: 0 })), "reach_m": Type.Optional(Type.Number({ minimum: 0 })), "payload_kg": Type.Optional(Type.Number({ minimum: 0 })), "runtime_min": Type.Optional(Type.Number({ minimum: 0 })), "notes": Type.Optional(Type.Ref('Text')) }),
  "Resources": Type.Record(Type.String({ pattern: '^[a-z][a-z0-9_]{0,31}$' }), Type.Ref('ConflictPolicy'), { additionalProperties: false }),
  "Tool": Type.Object({ "name": Type.Ref('ToolName'), "description": Type.Ref('Text'), "inputSchema": Type.Ref('InputSchema'), "uses": Type.Optional(Type.Array(Type.Ref('Name'))), "motion": Type.Optional(Type.Boolean()), "readOnly": Type.Optional(Type.Boolean()), "pausable": Type.Optional(Type.Boolean()), "needs": Type.Optional(Type.Array(Type.String())), "timeout": Type.Number({ minimum: 0 }), "ui": Type.Optional(Type.Ref('ToolUi')) }),
  "InputSchema": Type.Object({ "type": Type.Literal('object'), "properties": Type.Optional(Type.Record(Type.String(), ParamSchema)), "required": Type.Optional(Type.Array(Type.String())), "description": Type.Optional(Type.String()) }, { additionalProperties: false }),
  "Mount": Type.Object({ "xyz": Type.Ref('Vec3'), "rpy": Type.Ref('Vec3') }),
  "Model": Type.Object({ "name": Type.String(), "version": Type.String() }),
  "Field": Type.Object({ "type": Type.Union([Type.Literal('number'), Type.Literal('integer'), Type.Literal('boolean'), Type.Literal('string')]), "enum": Type.Optional(Type.Array(Type.String(), { minItems: 1 })), "unit": Type.Optional(Type.Ref('Unit')), "min": Type.Optional(Type.Number()), "max": Type.Optional(Type.Number()), "alert": Type.Optional(Type.Object({ "warn": Type.Optional(Type.Number()), "bad": Type.Optional(Type.Number()), "below": Type.Optional(Type.Boolean()) })), "role": Type.Optional(Type.Ref('FieldRole')), "of": Type.Optional(Type.Ref('Name')), "description": Type.Optional(Type.Ref('Text')), "ui": Type.Optional(Type.Ref('FieldUi')) }),
  "StateField": Type.Intersect([Type.Ref('Field'), Type.Object({ "writable": Type.Optional(Type.Boolean()) })]),
  "StateFields": Type.Record(Type.String({ pattern: '^[a-z][a-z0-9_]{0,31}$' }), Type.Ref('StateField'), { additionalProperties: false }),
  "Fields": Type.Record(Type.String({ pattern: '^[a-z][a-z0-9_]{0,31}$' }), Type.Ref('Field'), { additionalProperties: false }),
  "Manual": Type.Object({ "axes": Type.Array(Type.Ref('Axis'), { minItems: 1 }), "rate_hz": Type.Number({ minimum: 0 }), "deadman_s": Type.Number({ minimum: 0 }), "speeds": Type.Optional(Type.Array(Type.Object({ "label": Type.String(), "scale": Type.Number({ minimum: 0, maximum: 1 }) }))) }),
  "Axis": Type.Object({ "id": Type.Ref('Name'), "role": Type.Ref('AxisRole'), "unit": Type.Ref('Unit'), "min": Type.Number(), "max": Type.Number(), "keys": Type.Optional(Type.Array(Type.String(), { minItems: 2, maxItems: 2 })), "joint": Type.Optional(Type.Integer({ minimum: 0 })) }),
  "DeviceUi": Type.Object({ "icon": Type.Optional(Type.String()), "primary": Type.Optional(Type.Ref('Name')), "order": Type.Optional(Type.Number()) }),
  "SourceUi": Type.Object({ "group": Type.Optional(Type.String()), "order": Type.Optional(Type.Number()), "label": Type.Optional(Type.String()), "hidden": Type.Optional(Type.Boolean()), "widget": Type.Optional(Type.String()) }),
  "FieldUi": Type.Object({ "label": Type.Optional(Type.String()), "tile": Type.Optional(Type.Boolean()), "widget": Type.Optional(Type.String()), "hidden": Type.Optional(Type.Boolean()) }),
  "ToolUi": Type.Object({ "group": Type.Optional(Type.String()), "label": Type.Optional(Type.String()), "confirm": Type.Optional(Type.Union([Type.Boolean(), Type.String()])), "hidden": Type.Optional(Type.Boolean()), "widget": Type.Optional(Type.String()) }),
  "ParamUi": Type.Object({ "pick": Type.Optional(Type.Union([Type.Literal('map-point'), Type.Literal('map-pose'), Type.Literal('map-polygon')])), "limit": Type.Optional(Type.Number()), "label": Type.Optional(Type.String()) }),
  "Source": Type.Union([Type.Ref('ImageSource'), Type.Ref('VideoSource'), Type.Ref('ScanSource'), Type.Ref('PointsSource'), Type.Ref('AudioSource'), Type.Ref('PlainSource'), Type.Ref('ValuesSource'), Type.Ref('DetectionsSource'), Type.Ref('PoseSource'), Type.Ref('GridSource'), Type.Ref('TranscriptSource'), Type.Ref('CustomSource')]),
  "SourceCommon": Type.Object({ "id": Type.Ref('Name'), "kind": Type.Ref('Kind'), "description": Type.Ref('Text'), "hz": Type.Optional(Type.Number({ minimum: 0 })), "mount": Type.Optional(Type.Ref('Mount')), "switchable": Type.Optional(Type.Boolean()), "default": Type.Optional(Type.Boolean()), "ui": Type.Optional(Type.Ref('SourceUi')) }),
  "ImageSource": Type.Intersect([Type.Ref('SourceCommon'), Type.Object({ "kind": Type.Optional(Type.Literal('image')), "encoding": Type.Optional(Type.Ref('Encoding')), "mime": Type.Optional(Type.Union([Type.Literal('image/jpeg'), Type.Literal('image/png')])), "size": Type.Optional(Type.Ref('Size')), "sizes": Type.Optional(Type.Array(Type.Ref('Size'))), "fov_deg": Type.Optional(Type.Ref('Vec2')), "range_m": Type.Optional(Type.Ref('Range')), "depth_units": Type.Optional(Type.Literal('mm')) })]),
  "VideoSource": Type.Intersect([Type.Ref('SourceCommon'), Type.Object({ "kind": Type.Optional(Type.Literal('video')), "codec": Type.Literal('h264'), "encoding": Type.Optional(Type.Ref('Encoding')), "size": Type.Optional(Type.Ref('Size')), "sizes": Type.Optional(Type.Array(Type.Ref('Size'))), "fov_deg": Type.Optional(Type.Ref('Vec2')), "bitrate_kbps": Type.Optional(Type.Ref('Range')), "gop_s": Type.Number({ minimum: 0, maximum: 2 }), "profile": Type.Optional(Type.Union([Type.Literal('baseline'), Type.Literal('main'), Type.Literal('high')])) })]),
  "ScanSource": Type.Intersect([Type.Ref('SourceCommon'), Type.Object({ "kind": Type.Optional(Type.Literal('scan')), "range_m": Type.Optional(Type.Ref('Range')) })]),
  "PointsSource": Type.Intersect([Type.Ref('SourceCommon'), Type.Object({ "kind": Type.Optional(Type.Literal('points')), "range_m": Type.Optional(Type.Ref('Range')) })]),
  "AudioSource": Type.Intersect([Type.Ref('SourceCommon'), Type.Object({ "kind": Type.Optional(Type.Literal('audio')), "rate": Type.Integer({ minimum: 1 }), "channels": Type.Integer({ minimum: 1 }) })]),
  "PlainSource": Type.Intersect([Type.Ref('SourceCommon'), Type.Object({ "kind": Type.Optional(Type.Union([Type.Literal('imu'), Type.Literal('odometry'), Type.Literal('gnss'), Type.Literal('text')])) })]),
  "ValuesSource": Type.Intersect([Type.Ref('SourceCommon'), Type.Object({ "kind": Type.Optional(Type.Union([Type.Literal('values'), Type.Literal('switch')])), "fields": Type.Ref('Fields') })]),
  "DetectionsSource": Type.Intersect([Type.Ref('SourceCommon'), Type.Object({ "kind": Type.Optional(Type.Literal('detections')), "of": Type.Ref('Name'), "model": Type.Ref('Model'), "labels": Type.Optional(Type.Array(Type.String())) })]),
  "PoseSource": Type.Intersect([Type.Ref('SourceCommon'), Type.Object({ "kind": Type.Optional(Type.Literal('pose')), "of": Type.Optional(Type.Ref('Name')), "model": Type.Ref('Model'), "max_error_m": Type.Optional(Type.Number({ minimum: 0 })) })]),
  "GridSource": Type.Intersect([Type.Ref('SourceCommon'), Type.Object({ "kind": Type.Optional(Type.Literal('grid')), "model": Type.Ref('Model') })]),
  "TranscriptSource": Type.Intersect([Type.Ref('SourceCommon'), Type.Object({ "kind": Type.Optional(Type.Literal('transcript')), "of": Type.Ref('Name'), "model": Type.Ref('Model'), "lang": Type.Optional(Type.String()) })]),
  "CustomSource": Type.Intersect([Type.Ref('SourceCommon'), Type.Object({ "kind": Type.Optional(Type.Ref('CustomName')), "fields": Type.Optional(Type.Ref('Fields')) })]),
  "ImageData": Type.Object({ "w": Type.Integer({ minimum: 1 }), "h": Type.Integer({ minimum: 1 }) }),
  "VideoData": Type.Object({ "key": Type.Boolean(), "w": Type.Integer({ minimum: 1 }), "h": Type.Integer({ minimum: 1 }) }),
  "ScanData": Type.Object({ "angle_min": Type.Number(), "angle_inc": Type.Number(), "ranges": Type.Array(Type.Union([Type.Number(), Type.Null()])) }),
  "PointsData": Type.Object({ "n": Type.Integer({ minimum: 0 }), "fields": Type.Array(Type.String(), { minItems: 1 }) }),
  "AudioData": Type.Object({ "rate": Type.Integer({ minimum: 1 }), "channels": Type.Integer({ minimum: 1 }), "speaking": Type.Optional(Type.Boolean()) }),
  "ImuData": Type.Object({ "accel": Type.Ref('Vec3'), "gyro": Type.Ref('Vec3'), "rpy": Type.Optional(Type.Ref('Vec3')) }),
  "OdometryData": Type.Object({ "x": Type.Number(), "y": Type.Number(), "yaw": Type.Number(), "v": Type.Number(), "w": Type.Number() }),
  "GnssData": Type.Object({ "lat": Type.Number({ minimum: -90, maximum: 90 }), "lon": Type.Number({ minimum: -180, maximum: 180 }), "alt": Type.Optional(Type.Number()), "fix": Type.Union([Type.Literal('none'), Type.Literal('2d'), Type.Literal('3d'), Type.Literal('rtk')]), "acc_m": Type.Number({ minimum: 0 }) }),
  "ValuesData": Type.Record(Type.String({ pattern: '^[a-z][a-z0-9_]{0,31}$' }), Type.Union([Type.Number(), Type.Boolean(), Type.String()]), { additionalProperties: false }),
  "SwitchData": Type.Record(Type.String({ pattern: '^[a-z][a-z0-9_]{0,31}$' }), Type.Union([Type.Boolean(), Type.String()]), { additionalProperties: false }),
  "TextData": Type.Object({ "text": Type.String() }),
  "DetectionsData": Type.Object({ "w": Type.Integer({ minimum: 1 }), "h": Type.Integer({ minimum: 1 }), "items": Type.Array(Type.Ref('Detection')) }),
  "Detection": Type.Object({ "label": Type.String(), "conf": Type.Number({ minimum: 0, maximum: 1 }), "box": Type.Array(Type.Number(), { minItems: 4, maxItems: 4 }), "track": Type.Optional(Type.Integer()), "bearing": Type.Optional(Type.Number()), "dist": Type.Optional(Type.Number({ minimum: 0 })) }),
  "PoseData": Type.Object({ "map": Type.String(), "x": Type.Number(), "y": Type.Number(), "yaw": Type.Number(), "ok": Type.Boolean(), "cov": Type.Optional(Type.Array(Type.Number(), { minItems: 9, maxItems: 9 })) }),
  "GridData": Type.Object({ "id": Type.String(), "resolution": Type.Number({ minimum: 0 }), "origin": Type.Ref('Vec2') }),
  "TranscriptData": Type.Object({ "text": Type.String(), "final": Type.Boolean(), "start": Type.Ref('Time'), "end": Type.Ref('Time'), "lang": Type.Optional(Type.String()), "speaking": Type.Optional(Type.Boolean()) }),
  "WorldData": Type.Object({ "map": Type.String(), "name": Type.Optional(Type.String()), "bounds": Type.Optional(Type.Array(Type.Number(), { minItems: 4, maxItems: 4 })), "entities": Type.Array(Type.Object({ "device": Type.Ref('DeviceId'), "x": Type.Number(), "y": Type.Number(), "yaw": Type.Number(), "ok": Type.Boolean(), "fixed": Type.Optional(Type.Boolean()), "zone": Type.Optional(Type.String()) })), "places": Type.Optional(Type.Array(Type.Ref('Place'))) }),
  "CustomData": Type.Object({  }),
})

export const DeviceId = MhsV1.Import('DeviceId')
export type DeviceId = Static<typeof DeviceId>
export const Name = MhsV1.Import('Name')
export type Name = Static<typeof Name>
export const MapId = MhsV1.Import('MapId')
export type MapId = Static<typeof MapId>
export const ToolName = MhsV1.Import('ToolName')
export type ToolName = Static<typeof ToolName>
export const CustomName = MhsV1.Import('CustomName')
export type CustomName = Static<typeof CustomName>
export const Time = MhsV1.Import('Time')
export type Time = Static<typeof Time>
export const Text = MhsV1.Import('Text')
export type Text = Static<typeof Text>
export const Short = MhsV1.Import('Short')
export type Short = Static<typeof Short>
export const Vec2 = MhsV1.Import('Vec2')
export type Vec2 = Static<typeof Vec2>
export const Vec3 = MhsV1.Import('Vec3')
export type Vec3 = Static<typeof Vec3>
export const Size = MhsV1.Import('Size')
export type Size = Static<typeof Size>
export const Range = MhsV1.Import('Range')
export type Range = Static<typeof Range>
export const Kind = MhsV1.Import('Kind')
export type Kind = Static<typeof Kind>
export const AxisRole = MhsV1.Import('AxisRole')
export type AxisRole = Static<typeof AxisRole>
export const FieldRole = MhsV1.Import('FieldRole')
export type FieldRole = Static<typeof FieldRole>
export const Status = MhsV1.Import('Status')
export type Status = Static<typeof Status>
export const Reason = MhsV1.Import('Reason')
export type Reason = Static<typeof Reason>
export const RejectReason = MhsV1.Import('RejectReason')
export type RejectReason = Static<typeof RejectReason>
export const InterruptReason = MhsV1.Import('InterruptReason')
export type InterruptReason = Static<typeof InterruptReason>
export const ErrorReason = MhsV1.Import('ErrorReason')
export type ErrorReason = Static<typeof ErrorReason>
export const Unit = MhsV1.Import('Unit')
export type Unit = Static<typeof Unit>
export const Encoding = MhsV1.Import('Encoding')
export type Encoding = Static<typeof Encoding>
export const Localization = MhsV1.Import('Localization')
export type Localization = Static<typeof Localization>
export const Placement = MhsV1.Import('Placement')
export type Placement = Static<typeof Placement>
export const Place = MhsV1.Import('Place')
export type Place = Static<typeof Place>
export const Landmark = MhsV1.Import('Landmark')
export type Landmark = Static<typeof Landmark>
export const Zone = MhsV1.Import('Zone')
export type Zone = Static<typeof Zone>
export const MapAnchor = MhsV1.Import('MapAnchor')
export type MapAnchor = Static<typeof MapAnchor>
export const MapDecl = MhsV1.Import('MapDecl')
export type MapDecl = Static<typeof MapDecl>
export const ConflictPolicy = MhsV1.Import('ConflictPolicy')
export type ConflictPolicy = Static<typeof ConflictPolicy>
export const ErrorCode = MhsV1.Import('ErrorCode')
export type ErrorCode = Static<typeof ErrorCode>
export const Request = MhsV1.Import('Request')
export type Request = Static<typeof Request>
export const Notification = MhsV1.Import('Notification')
export type Notification = Static<typeof Notification>
export const Response = MhsV1.Import('Response')
export type Response = Static<typeof Response>
export const Error = MhsV1.Import('Error')
export type Error = Static<typeof Error>
export const RegisterParams = MhsV1.Import('RegisterParams')
export type RegisterParams = Static<typeof RegisterParams>
export const RegisterResult = MhsV1.Import('RegisterResult')
export type RegisterResult = Static<typeof RegisterResult>
export const CallParams = MhsV1.Import('CallParams')
export type CallParams = Static<typeof CallParams>
export const CallReply = MhsV1.Import('CallReply')
export type CallReply = Static<typeof CallReply>
export const CallAccepted = MhsV1.Import('CallAccepted')
export type CallAccepted = Static<typeof CallAccepted>
export const CallRejectedBusy = MhsV1.Import('CallRejectedBusy')
export type CallRejectedBusy = Static<typeof CallRejectedBusy>
export const CallRejected = MhsV1.Import('CallRejected')
export type CallRejected = Static<typeof CallRejected>
export const Holder = MhsV1.Import('Holder')
export type Holder = Static<typeof Holder>
export const ProgressParams = MhsV1.Import('ProgressParams')
export type ProgressParams = Static<typeof ProgressParams>
export const ResultParams = MhsV1.Import('ResultParams')
export type ResultParams = Static<typeof ResultParams>
export const ResultCommon = MhsV1.Import('ResultCommon')
export type ResultCommon = Static<typeof ResultCommon>
export const ResultDone = MhsV1.Import('ResultDone')
export type ResultDone = Static<typeof ResultDone>
export const ResultInterrupted = MhsV1.Import('ResultInterrupted')
export type ResultInterrupted = Static<typeof ResultInterrupted>
export const ResultError = MhsV1.Import('ResultError')
export type ResultError = Static<typeof ResultError>
export const After = MhsV1.Import('After')
export type After = Static<typeof After>
export const CallRef = MhsV1.Import('CallRef')
export type CallRef = Static<typeof CallRef>
export const Empty = MhsV1.Import('Empty')
export type Empty = Static<typeof Empty>
export const CancelResult = MhsV1.Import('CancelResult')
export type CancelResult = Static<typeof CancelResult>
export const StopResult = MhsV1.Import('StopResult')
export type StopResult = Static<typeof StopResult>
export const PauseResult = MhsV1.Import('PauseResult')
export type PauseResult = Static<typeof PauseResult>
export const ResumeResult = MhsV1.Import('ResumeResult')
export type ResumeResult = Static<typeof ResumeResult>
export const ConfigureParams = MhsV1.Import('ConfigureParams')
export type ConfigureParams = Static<typeof ConfigureParams>
export const ConfigureResult = MhsV1.Import('ConfigureResult')
export type ConfigureResult = Static<typeof ConfigureResult>
export const SourceSettings = MhsV1.Import('SourceSettings')
export type SourceSettings = Static<typeof SourceSettings>
export const SourceSetting = MhsV1.Import('SourceSetting')
export type SourceSetting = Static<typeof SourceSetting>
export const KeyframeParams = MhsV1.Import('KeyframeParams')
export type KeyframeParams = Static<typeof KeyframeParams>
export const KeyframeResult = MhsV1.Import('KeyframeResult')
export type KeyframeResult = Static<typeof KeyframeResult>
export const StateParams = MhsV1.Import('StateParams')
export type StateParams = Static<typeof StateParams>
export const StateValues = MhsV1.Import('StateValues')
export type StateValues = Static<typeof StateValues>
export const SetParams = MhsV1.Import('SetParams')
export type SetParams = Static<typeof SetParams>
export const SetResult = MhsV1.Import('SetResult')
export type SetResult = Static<typeof SetResult>
export const TimeResult = MhsV1.Import('TimeResult')
export type TimeResult = Static<typeof TimeResult>
export const NerveHello = MhsV1.Import('NerveHello')
export type NerveHello = Static<typeof NerveHello>
export const NerveData = MhsV1.Import('NerveData')
export type NerveData = Static<typeof NerveData>
export const NerveManual = MhsV1.Import('NerveManual')
export type NerveManual = Static<typeof NerveManual>
export const NerveClip = MhsV1.Import('NerveClip')
export type NerveClip = Static<typeof NerveClip>
export const Device = MhsV1.Import('Device')
export type Device = Static<typeof Device>
export const Profile = MhsV1.Import('Profile')
export type Profile = Static<typeof Profile>
export const Resources = MhsV1.Import('Resources')
export type Resources = Static<typeof Resources>
export const Tool = MhsV1.Import('Tool')
export type Tool = Static<typeof Tool>
export const InputSchema = MhsV1.Import('InputSchema')
export type InputSchema = Static<typeof InputSchema>
export const Mount = MhsV1.Import('Mount')
export type Mount = Static<typeof Mount>
export const Model = MhsV1.Import('Model')
export type Model = Static<typeof Model>
export const Field = MhsV1.Import('Field')
export type Field = Static<typeof Field>
export const StateField = MhsV1.Import('StateField')
export type StateField = Static<typeof StateField>
export const StateFields = MhsV1.Import('StateFields')
export type StateFields = Static<typeof StateFields>
export const Fields = MhsV1.Import('Fields')
export type Fields = Static<typeof Fields>
export const Manual = MhsV1.Import('Manual')
export type Manual = Static<typeof Manual>
export const Axis = MhsV1.Import('Axis')
export type Axis = Static<typeof Axis>
export const DeviceUi = MhsV1.Import('DeviceUi')
export type DeviceUi = Static<typeof DeviceUi>
export const SourceUi = MhsV1.Import('SourceUi')
export type SourceUi = Static<typeof SourceUi>
export const FieldUi = MhsV1.Import('FieldUi')
export type FieldUi = Static<typeof FieldUi>
export const ToolUi = MhsV1.Import('ToolUi')
export type ToolUi = Static<typeof ToolUi>
export const ParamUi = MhsV1.Import('ParamUi')
export type ParamUi = Static<typeof ParamUi>
export const Source = MhsV1.Import('Source')
export type Source = Static<typeof Source>
export const SourceCommon = MhsV1.Import('SourceCommon')
export type SourceCommon = Static<typeof SourceCommon>
export const ImageSource = MhsV1.Import('ImageSource')
export type ImageSource = Static<typeof ImageSource>
export const VideoSource = MhsV1.Import('VideoSource')
export type VideoSource = Static<typeof VideoSource>
export const ScanSource = MhsV1.Import('ScanSource')
export type ScanSource = Static<typeof ScanSource>
export const PointsSource = MhsV1.Import('PointsSource')
export type PointsSource = Static<typeof PointsSource>
export const AudioSource = MhsV1.Import('AudioSource')
export type AudioSource = Static<typeof AudioSource>
export const PlainSource = MhsV1.Import('PlainSource')
export type PlainSource = Static<typeof PlainSource>
export const ValuesSource = MhsV1.Import('ValuesSource')
export type ValuesSource = Static<typeof ValuesSource>
export const DetectionsSource = MhsV1.Import('DetectionsSource')
export type DetectionsSource = Static<typeof DetectionsSource>
export const PoseSource = MhsV1.Import('PoseSource')
export type PoseSource = Static<typeof PoseSource>
export const GridSource = MhsV1.Import('GridSource')
export type GridSource = Static<typeof GridSource>
export const TranscriptSource = MhsV1.Import('TranscriptSource')
export type TranscriptSource = Static<typeof TranscriptSource>
export const CustomSource = MhsV1.Import('CustomSource')
export type CustomSource = Static<typeof CustomSource>
export const ImageData = MhsV1.Import('ImageData')
export type ImageData = Static<typeof ImageData>
export const VideoData = MhsV1.Import('VideoData')
export type VideoData = Static<typeof VideoData>
export const ScanData = MhsV1.Import('ScanData')
export type ScanData = Static<typeof ScanData>
export const PointsData = MhsV1.Import('PointsData')
export type PointsData = Static<typeof PointsData>
export const AudioData = MhsV1.Import('AudioData')
export type AudioData = Static<typeof AudioData>
export const ImuData = MhsV1.Import('ImuData')
export type ImuData = Static<typeof ImuData>
export const OdometryData = MhsV1.Import('OdometryData')
export type OdometryData = Static<typeof OdometryData>
export const GnssData = MhsV1.Import('GnssData')
export type GnssData = Static<typeof GnssData>
export const ValuesData = MhsV1.Import('ValuesData')
export type ValuesData = Static<typeof ValuesData>
export const SwitchData = MhsV1.Import('SwitchData')
export type SwitchData = Static<typeof SwitchData>
export const TextData = MhsV1.Import('TextData')
export type TextData = Static<typeof TextData>
export const DetectionsData = MhsV1.Import('DetectionsData')
export type DetectionsData = Static<typeof DetectionsData>
export const Detection = MhsV1.Import('Detection')
export type Detection = Static<typeof Detection>
export const PoseData = MhsV1.Import('PoseData')
export type PoseData = Static<typeof PoseData>
export const GridData = MhsV1.Import('GridData')
export type GridData = Static<typeof GridData>
export const TranscriptData = MhsV1.Import('TranscriptData')
export type TranscriptData = Static<typeof TranscriptData>
export const WorldData = MhsV1.Import('WorldData')
export type WorldData = Static<typeof WorldData>
export const CustomData = MhsV1.Import('CustomData')
export type CustomData = Static<typeof CustomData>
