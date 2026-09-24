// generated from schema by tools/gen.ts — do not edit
import { Type, type Static } from '@sinclair/typebox'
import { FormatRegistry } from '@sinclair/typebox'

if (!FormatRegistry.Has('uri')) FormatRegistry.Set('uri', (v) => { try { new URL(v); return true } catch { return false } })

export const Acp = Type.Module({
  "AgentRequest": Type.Object({ "id": Type.Intersect([Type.Ref('RequestId')]), "method": Type.String(), "params": Type.Optional(Type.Union([Type.Union([Type.Intersect([Type.Ref('WriteTextFileRequest')]), Type.Intersect([Type.Ref('ReadTextFileRequest')]), Type.Intersect([Type.Ref('RequestPermissionRequest')]), Type.Intersect([Type.Ref('CreateTerminalRequest')]), Type.Intersect([Type.Ref('TerminalOutputRequest')]), Type.Intersect([Type.Ref('ReleaseTerminalRequest')]), Type.Intersect([Type.Ref('WaitForTerminalExitRequest')]), Type.Intersect([Type.Ref('KillTerminalRequest')]), Type.Intersect([Type.Ref('CreateElicitationRequest')]), Type.Intersect([Type.Ref('ExtRequest')])]), Type.Null()])) }),
  "RequestId": Type.Union([Type.Null(), Type.Integer(), Type.String()]),
  "WriteTextFileRequest": Type.Object({ "sessionId": Type.Intersect([Type.Ref('SessionId')]), "path": Type.String(), "content": Type.String(), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "SessionId": Type.String(),
  "ReadTextFileRequest": Type.Object({ "sessionId": Type.Intersect([Type.Ref('SessionId')]), "path": Type.String(), "line": Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])), "limit": Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "RequestPermissionRequest": Type.Object({ "sessionId": Type.Intersect([Type.Ref('SessionId')]), "toolCall": Type.Intersect([Type.Ref('ToolCallUpdate')]), "options": Type.Array(Type.Ref('PermissionOption')), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ToolCallUpdate": Type.Object({ "toolCallId": Type.Intersect([Type.Ref('ToolCallId')]), "kind": Type.Optional(Type.Union([Type.Ref('ToolKind'), Type.Null()])), "status": Type.Optional(Type.Union([Type.Ref('ToolCallStatus'), Type.Null()])), "title": Type.Optional(Type.Union([Type.String(), Type.Null()])), "content": Type.Optional(Type.Union([Type.Array(Type.Ref('ToolCallContent')), Type.Null()])), "locations": Type.Optional(Type.Union([Type.Array(Type.Ref('ToolCallLocation')), Type.Null()])), "rawInput": Type.Optional(Type.Unknown()), "rawOutput": Type.Optional(Type.Unknown()), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ToolCallId": Type.String(),
  "ToolKind": Type.Union([Type.Literal('read'), Type.Literal('edit'), Type.Literal('delete'), Type.Literal('move'), Type.Literal('search'), Type.Literal('execute'), Type.Literal('think'), Type.Literal('fetch'), Type.Literal('switch_mode'), Type.Literal('other')]),
  "ToolCallStatus": Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed'), Type.Literal('failed')]),
  "ToolCallContent": Type.Union([Type.Intersect([Type.Object({ "type": Type.Literal('content') }), Type.Ref('Content')]), Type.Intersect([Type.Object({ "type": Type.Literal('diff') }), Type.Ref('Diff')]), Type.Intersect([Type.Object({ "type": Type.Literal('terminal') }), Type.Ref('Terminal')])]),
  "ContentBlock": Type.Union([Type.Intersect([Type.Object({ "type": Type.Literal('text') }), Type.Ref('TextContent')]), Type.Intersect([Type.Object({ "type": Type.Literal('image') }), Type.Ref('ImageContent')]), Type.Intersect([Type.Object({ "type": Type.Literal('audio') }), Type.Ref('AudioContent')]), Type.Intersect([Type.Object({ "type": Type.Literal('resource_link') }), Type.Ref('ResourceLink')]), Type.Intersect([Type.Object({ "type": Type.Literal('resource') }), Type.Ref('EmbeddedResource')])]),
  "Annotations": Type.Object({ "audience": Type.Optional(Type.Union([Type.Array(Type.Ref('Role')), Type.Null()])), "lastModified": Type.Optional(Type.Union([Type.String(), Type.Null()])), "priority": Type.Optional(Type.Union([Type.Number(), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "Role": Type.Union([Type.Literal('assistant'), Type.Literal('user')]),
  "TextContent": Type.Object({ "annotations": Type.Optional(Type.Union([Type.Ref('Annotations'), Type.Null()])), "text": Type.String(), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ImageContent": Type.Object({ "annotations": Type.Optional(Type.Union([Type.Ref('Annotations'), Type.Null()])), "data": Type.String(), "mimeType": Type.String(), "uri": Type.Optional(Type.Union([Type.String(), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "AudioContent": Type.Object({ "annotations": Type.Optional(Type.Union([Type.Ref('Annotations'), Type.Null()])), "data": Type.String(), "mimeType": Type.String(), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ResourceLink": Type.Object({ "annotations": Type.Optional(Type.Union([Type.Ref('Annotations'), Type.Null()])), "description": Type.Optional(Type.Union([Type.String(), Type.Null()])), "mimeType": Type.Optional(Type.Union([Type.String(), Type.Null()])), "name": Type.String(), "size": Type.Optional(Type.Union([Type.Integer(), Type.Null()])), "title": Type.Optional(Type.Union([Type.String(), Type.Null()])), "uri": Type.String(), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "EmbeddedResourceResource": Type.Union([Type.Intersect([Type.Ref('TextResourceContents')]), Type.Intersect([Type.Ref('BlobResourceContents')])]),
  "TextResourceContents": Type.Object({ "mimeType": Type.Optional(Type.Union([Type.String(), Type.Null()])), "text": Type.String(), "uri": Type.String(), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "BlobResourceContents": Type.Object({ "blob": Type.String(), "mimeType": Type.Optional(Type.Union([Type.String(), Type.Null()])), "uri": Type.String(), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "EmbeddedResource": Type.Object({ "annotations": Type.Optional(Type.Union([Type.Ref('Annotations'), Type.Null()])), "resource": Type.Intersect([Type.Ref('EmbeddedResourceResource')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "Content": Type.Object({ "content": Type.Intersect([Type.Ref('ContentBlock')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "Diff": Type.Object({ "path": Type.String(), "oldText": Type.Optional(Type.Union([Type.String(), Type.Null()])), "newText": Type.String(), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "TerminalId": Type.String(),
  "Terminal": Type.Object({ "terminalId": Type.Intersect([Type.Ref('TerminalId')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ToolCallLocation": Type.Object({ "path": Type.String(), "line": Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "PermissionOption": Type.Object({ "optionId": Type.Intersect([Type.Ref('PermissionOptionId')]), "name": Type.String(), "kind": Type.Intersect([Type.Ref('PermissionOptionKind')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "PermissionOptionId": Type.String(),
  "PermissionOptionKind": Type.Union([Type.Literal('allow_once'), Type.Literal('allow_always'), Type.Literal('reject_once'), Type.Literal('reject_always')]),
  "CreateTerminalRequest": Type.Object({ "sessionId": Type.Intersect([Type.Ref('SessionId')]), "command": Type.String(), "args": Type.Optional(Type.Array(Type.String())), "env": Type.Optional(Type.Array(Type.Ref('EnvVariable'))), "cwd": Type.Optional(Type.Union([Type.String(), Type.Null()])), "outputByteLimit": Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "EnvVariable": Type.Object({ "name": Type.String(), "value": Type.String(), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "TerminalOutputRequest": Type.Object({ "sessionId": Type.Intersect([Type.Ref('SessionId')]), "terminalId": Type.Intersect([Type.Ref('TerminalId')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ReleaseTerminalRequest": Type.Object({ "sessionId": Type.Intersect([Type.Ref('SessionId')]), "terminalId": Type.Intersect([Type.Ref('TerminalId')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "WaitForTerminalExitRequest": Type.Object({ "sessionId": Type.Intersect([Type.Ref('SessionId')]), "terminalId": Type.Intersect([Type.Ref('TerminalId')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "KillTerminalRequest": Type.Object({ "sessionId": Type.Intersect([Type.Ref('SessionId')]), "terminalId": Type.Intersect([Type.Ref('TerminalId')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "CreateElicitationRequest": Type.Unknown(),
  "ElicitationSessionScope": Type.Object({ "sessionId": Type.Intersect([Type.Ref('SessionId')]), "toolCallId": Type.Optional(Type.Union([Type.Ref('ToolCallId'), Type.Null()])) }),
  "ElicitationRequestScope": Type.Object({ "requestId": Type.Intersect([Type.Ref('RequestId')]) }),
  "ElicitationSchema": Type.Object({ "type": Type.Optional(Type.Intersect([Type.Ref('ElicitationSchemaType')])), "title": Type.Optional(Type.Union([Type.String(), Type.Null()])), "properties": Type.Optional(Type.Record(Type.String(), Type.Ref('ElicitationPropertySchema'))), "required": Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])), "description": Type.Optional(Type.Union([Type.String(), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ElicitationSchemaType": Type.Union([Type.Literal('object')]),
  "ElicitationPropertySchema": Type.Unknown(),
  "StringFormat": Type.Union([Type.Literal('email'), Type.Literal('uri'), Type.Literal('date'), Type.Literal('date-time')]),
  "EnumOption": Type.Object({ "const": Type.String(), "title": Type.String(), "description": Type.Optional(Type.Union([Type.String(), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "StringPropertySchema": Type.Object({ "title": Type.Optional(Type.Union([Type.String(), Type.Null()])), "description": Type.Optional(Type.Union([Type.String(), Type.Null()])), "minLength": Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])), "maxLength": Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])), "pattern": Type.Optional(Type.Union([Type.String(), Type.Null()])), "format": Type.Optional(Type.Union([Type.Ref('StringFormat'), Type.Null()])), "default": Type.Optional(Type.Union([Type.String(), Type.Null()])), "enum": Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])), "oneOf": Type.Optional(Type.Union([Type.Array(Type.Ref('EnumOption')), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "NumberPropertySchema": Type.Object({ "title": Type.Optional(Type.Union([Type.String(), Type.Null()])), "description": Type.Optional(Type.Union([Type.String(), Type.Null()])), "minimum": Type.Optional(Type.Union([Type.Number(), Type.Null()])), "maximum": Type.Optional(Type.Union([Type.Number(), Type.Null()])), "default": Type.Optional(Type.Union([Type.Number(), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "IntegerPropertySchema": Type.Object({ "title": Type.Optional(Type.Union([Type.String(), Type.Null()])), "description": Type.Optional(Type.Union([Type.String(), Type.Null()])), "minimum": Type.Optional(Type.Union([Type.Integer(), Type.Null()])), "maximum": Type.Optional(Type.Union([Type.Integer(), Type.Null()])), "default": Type.Optional(Type.Union([Type.Integer(), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "BooleanPropertySchema": Type.Object({ "title": Type.Optional(Type.Union([Type.String(), Type.Null()])), "description": Type.Optional(Type.Union([Type.String(), Type.Null()])), "default": Type.Optional(Type.Union([Type.Boolean(), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "MultiSelectItems": Type.Unknown(),
  "StringMultiSelectItems": Type.Object({ "enum": Type.Array(Type.String()), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "TitledMultiSelectItems": Type.Object({ "anyOf": Type.Array(Type.Ref('EnumOption')), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "MultiSelectPropertySchema": Type.Object({ "title": Type.Optional(Type.Union([Type.String(), Type.Null()])), "description": Type.Optional(Type.Union([Type.String(), Type.Null()])), "minItems": Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])), "maxItems": Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])), "items": Type.Intersect([Type.Ref('MultiSelectItems')]), "default": Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ElicitationFormMode": Type.Union([Type.Intersect([Type.Object({ "requestedSchema": Type.Intersect([Type.Ref('ElicitationSchema')]) }), Type.Intersect([Type.Ref('ElicitationSessionScope')])]), Type.Intersect([Type.Object({ "requestedSchema": Type.Intersect([Type.Ref('ElicitationSchema')]) }), Type.Intersect([Type.Ref('ElicitationRequestScope')])])]),
  "ElicitationId": Type.String(),
  "ElicitationUrlMode": Type.Union([Type.Intersect([Type.Object({ "elicitationId": Type.Intersect([Type.Ref('ElicitationId')]), "url": Type.String({ format: "uri" }) }), Type.Intersect([Type.Ref('ElicitationSessionScope')])]), Type.Intersect([Type.Object({ "elicitationId": Type.Intersect([Type.Ref('ElicitationId')]), "url": Type.String({ format: "uri" }) }), Type.Intersect([Type.Ref('ElicitationRequestScope')])])]),
  "ExtRequest": Type.Unknown(),
  "AgentResponse": Type.Union([Type.Object({ "id": Type.Intersect([Type.Ref('RequestId')]), "result": Type.Union([Type.Intersect([Type.Ref('InitializeResponse')]), Type.Intersect([Type.Ref('AuthenticateResponse')]), Type.Intersect([Type.Ref('LogoutResponse')]), Type.Intersect([Type.Ref('NewSessionResponse')]), Type.Intersect([Type.Ref('LoadSessionResponse')]), Type.Intersect([Type.Ref('ListSessionsResponse')]), Type.Intersect([Type.Ref('DeleteSessionResponse')]), Type.Intersect([Type.Ref('ResumeSessionResponse')]), Type.Intersect([Type.Ref('CloseSessionResponse')]), Type.Intersect([Type.Ref('SetSessionModeResponse')]), Type.Intersect([Type.Ref('SetSessionConfigOptionResponse')]), Type.Intersect([Type.Ref('PromptResponse')]), Type.Intersect([Type.Ref('ExtResponse')])]) }), Type.Object({ "id": Type.Intersect([Type.Ref('RequestId')]), "error": Type.Intersect([Type.Ref('Error')]) })]),
  "InitializeResponse": Type.Object({ "protocolVersion": Type.Intersect([Type.Ref('ProtocolVersion')]), "agentCapabilities": Type.Optional(Type.Intersect([Type.Ref('AgentCapabilities')])), "authMethods": Type.Optional(Type.Array(Type.Ref('AuthMethod'))), "agentInfo": Type.Optional(Type.Union([Type.Ref('Implementation'), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ProtocolVersion": Type.Integer({ minimum: 0, maximum: 65535 }),
  "AgentCapabilities": Type.Object({ "loadSession": Type.Optional(Type.Boolean()), "promptCapabilities": Type.Optional(Type.Intersect([Type.Ref('PromptCapabilities')])), "mcpCapabilities": Type.Optional(Type.Intersect([Type.Ref('McpCapabilities')])), "sessionCapabilities": Type.Optional(Type.Intersect([Type.Ref('SessionCapabilities')])), "auth": Type.Optional(Type.Intersect([Type.Ref('AgentAuthCapabilities')])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "PromptCapabilities": Type.Object({ "image": Type.Optional(Type.Boolean()), "audio": Type.Optional(Type.Boolean()), "embeddedContext": Type.Optional(Type.Boolean()), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "McpCapabilities": Type.Object({ "http": Type.Optional(Type.Boolean()), "sse": Type.Optional(Type.Boolean()), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "SessionCapabilities": Type.Object({ "list": Type.Optional(Type.Union([Type.Ref('SessionListCapabilities'), Type.Null()])), "delete": Type.Optional(Type.Union([Type.Ref('SessionDeleteCapabilities'), Type.Null()])), "additionalDirectories": Type.Optional(Type.Union([Type.Ref('SessionAdditionalDirectoriesCapabilities'), Type.Null()])), "resume": Type.Optional(Type.Union([Type.Ref('SessionResumeCapabilities'), Type.Null()])), "close": Type.Optional(Type.Union([Type.Ref('SessionCloseCapabilities'), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "SessionListCapabilities": Type.Object({ "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "SessionDeleteCapabilities": Type.Object({ "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "SessionAdditionalDirectoriesCapabilities": Type.Object({ "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "SessionResumeCapabilities": Type.Object({ "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "SessionCloseCapabilities": Type.Object({ "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "AgentAuthCapabilities": Type.Object({ "logout": Type.Optional(Type.Union([Type.Ref('LogoutCapabilities'), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "LogoutCapabilities": Type.Object({ "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "AuthMethod": Type.Union([Type.Intersect([Type.Object({ "type": Type.Literal('terminal') }), Type.Ref('AuthMethodTerminal')]), Type.Intersect([Type.Ref('AuthMethodAgent')])]),
  "AuthMethodId": Type.String(),
  "AuthMethodTerminal": Type.Object({ "id": Type.Intersect([Type.Ref('AuthMethodId')]), "name": Type.String(), "description": Type.Optional(Type.Union([Type.String(), Type.Null()])), "args": Type.Optional(Type.Array(Type.String())), "env": Type.Optional(Type.Record(Type.String(), Type.String())), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "AuthMethodAgent": Type.Object({ "id": Type.Intersect([Type.Ref('AuthMethodId')]), "name": Type.String(), "description": Type.Optional(Type.Union([Type.String(), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "Implementation": Type.Object({ "name": Type.String(), "title": Type.Optional(Type.Union([Type.String(), Type.Null()])), "version": Type.String(), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "AuthenticateResponse": Type.Object({ "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "LogoutResponse": Type.Object({ "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "NewSessionResponse": Type.Object({ "sessionId": Type.Intersect([Type.Ref('SessionId')]), "modes": Type.Optional(Type.Union([Type.Ref('SessionModeState'), Type.Null()])), "configOptions": Type.Optional(Type.Union([Type.Array(Type.Ref('SessionConfigOption')), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "SessionModeState": Type.Object({ "currentModeId": Type.Intersect([Type.Ref('SessionModeId')]), "availableModes": Type.Array(Type.Ref('SessionMode')), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "SessionModeId": Type.String(),
  "SessionMode": Type.Object({ "id": Type.Intersect([Type.Ref('SessionModeId')]), "name": Type.String(), "description": Type.Optional(Type.Union([Type.String(), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "SessionConfigOption": Type.Union([Type.Intersect([Type.Object({ "id": Type.Intersect([Type.Ref('SessionConfigId')]), "name": Type.String(), "description": Type.Optional(Type.Union([Type.String(), Type.Null()])), "category": Type.Optional(Type.Union([Type.Ref('SessionConfigOptionCategory'), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }), Type.Intersect([Type.Object({ "type": Type.Literal('select') }), Type.Ref('SessionConfigSelect')])]), Type.Intersect([Type.Object({ "id": Type.Intersect([Type.Ref('SessionConfigId')]), "name": Type.String(), "description": Type.Optional(Type.Union([Type.String(), Type.Null()])), "category": Type.Optional(Type.Union([Type.Ref('SessionConfigOptionCategory'), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }), Type.Intersect([Type.Object({ "type": Type.Literal('boolean') }), Type.Ref('SessionConfigBoolean')])])]),
  "SessionConfigId": Type.String(),
  "SessionConfigOptionCategory": Type.Union([Type.Literal('mode'), Type.Literal('model'), Type.Literal('model_config'), Type.Literal('thought_level'), Type.String()]),
  "SessionConfigValueId": Type.String(),
  "SessionConfigSelectOptions": Type.Union([Type.Array(Type.Ref('SessionConfigSelectOption')), Type.Array(Type.Ref('SessionConfigSelectGroup'))]),
  "SessionConfigSelectOption": Type.Object({ "value": Type.Intersect([Type.Ref('SessionConfigValueId')]), "name": Type.String(), "description": Type.Optional(Type.Union([Type.String(), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "SessionConfigSelectGroup": Type.Object({ "group": Type.Intersect([Type.Ref('SessionConfigGroupId')]), "name": Type.String(), "options": Type.Array(Type.Ref('SessionConfigSelectOption')), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "SessionConfigGroupId": Type.String(),
  "SessionConfigSelect": Type.Object({ "currentValue": Type.Intersect([Type.Ref('SessionConfigValueId')]), "options": Type.Intersect([Type.Ref('SessionConfigSelectOptions')]) }),
  "SessionConfigBoolean": Type.Object({ "currentValue": Type.Boolean() }),
  "LoadSessionResponse": Type.Object({ "modes": Type.Optional(Type.Union([Type.Ref('SessionModeState'), Type.Null()])), "configOptions": Type.Optional(Type.Union([Type.Array(Type.Ref('SessionConfigOption')), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ListSessionsResponse": Type.Object({ "sessions": Type.Array(Type.Ref('SessionInfo')), "nextCursor": Type.Optional(Type.Union([Type.String(), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "SessionInfo": Type.Object({ "sessionId": Type.Intersect([Type.Ref('SessionId')]), "cwd": Type.String(), "additionalDirectories": Type.Optional(Type.Array(Type.String())), "title": Type.Optional(Type.Union([Type.String(), Type.Null()])), "updatedAt": Type.Optional(Type.Union([Type.String(), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "DeleteSessionResponse": Type.Object({ "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ResumeSessionResponse": Type.Object({ "modes": Type.Optional(Type.Union([Type.Ref('SessionModeState'), Type.Null()])), "configOptions": Type.Optional(Type.Union([Type.Array(Type.Ref('SessionConfigOption')), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "CloseSessionResponse": Type.Object({ "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "SetSessionModeResponse": Type.Object({ "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "SetSessionConfigOptionResponse": Type.Object({ "configOptions": Type.Array(Type.Ref('SessionConfigOption')), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "PromptResponse": Type.Object({ "stopReason": Type.Intersect([Type.Ref('StopReason')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "StopReason": Type.Union([Type.Literal('end_turn'), Type.Literal('max_tokens'), Type.Literal('max_turn_requests'), Type.Literal('refusal'), Type.Literal('cancelled')]),
  "ExtResponse": Type.Unknown(),
  "Error": Type.Object({ "code": Type.Intersect([Type.Ref('ErrorCode')]), "message": Type.String(), "data": Type.Optional(Type.Unknown()) }),
  "ErrorCode": Type.Union([Type.Literal(-32700), Type.Literal(-32600), Type.Literal(-32601), Type.Literal(-32602), Type.Literal(-32603), Type.Literal(-32800), Type.Literal(-32000), Type.Literal(-32002), Type.Integer()]),
  "AgentNotification": Type.Object({ "method": Type.String(), "params": Type.Optional(Type.Union([Type.Union([Type.Intersect([Type.Ref('SessionNotification')]), Type.Intersect([Type.Ref('CompleteElicitationNotification')]), Type.Intersect([Type.Ref('ExtNotification')])]), Type.Null()])) }),
  "SessionNotification": Type.Object({ "sessionId": Type.Intersect([Type.Ref('SessionId')]), "update": Type.Intersect([Type.Ref('SessionUpdate')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "SessionUpdate": Type.Union([Type.Intersect([Type.Object({ "sessionUpdate": Type.Literal('user_message_chunk') }), Type.Ref('ContentChunk')]), Type.Intersect([Type.Object({ "sessionUpdate": Type.Literal('agent_message_chunk') }), Type.Ref('ContentChunk')]), Type.Intersect([Type.Object({ "sessionUpdate": Type.Literal('agent_thought_chunk') }), Type.Ref('ContentChunk')]), Type.Intersect([Type.Object({ "sessionUpdate": Type.Literal('tool_call') }), Type.Ref('ToolCall')]), Type.Intersect([Type.Object({ "sessionUpdate": Type.Literal('tool_call_update') }), Type.Ref('ToolCallUpdate')]), Type.Intersect([Type.Object({ "sessionUpdate": Type.Literal('plan') }), Type.Ref('Plan')]), Type.Intersect([Type.Object({ "sessionUpdate": Type.Literal('available_commands_update') }), Type.Ref('AvailableCommandsUpdate')]), Type.Intersect([Type.Object({ "sessionUpdate": Type.Literal('current_mode_update') }), Type.Ref('CurrentModeUpdate')]), Type.Intersect([Type.Object({ "sessionUpdate": Type.Literal('config_option_update') }), Type.Ref('ConfigOptionUpdate')]), Type.Intersect([Type.Object({ "sessionUpdate": Type.Literal('session_info_update') }), Type.Ref('SessionInfoUpdate')]), Type.Intersect([Type.Object({ "sessionUpdate": Type.Literal('usage_update') }), Type.Ref('UsageUpdate')])]),
  "MessageId": Type.String(),
  "ContentChunk": Type.Object({ "content": Type.Intersect([Type.Ref('ContentBlock')]), "messageId": Type.Optional(Type.Union([Type.Ref('MessageId'), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ToolCall": Type.Object({ "toolCallId": Type.Intersect([Type.Ref('ToolCallId')]), "title": Type.String(), "kind": Type.Optional(Type.Intersect([Type.Ref('ToolKind')])), "status": Type.Optional(Type.Intersect([Type.Ref('ToolCallStatus')])), "content": Type.Optional(Type.Array(Type.Ref('ToolCallContent'))), "locations": Type.Optional(Type.Array(Type.Ref('ToolCallLocation'))), "rawInput": Type.Optional(Type.Unknown()), "rawOutput": Type.Optional(Type.Unknown()), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "PlanEntry": Type.Object({ "content": Type.String(), "priority": Type.Intersect([Type.Ref('PlanEntryPriority')]), "status": Type.Intersect([Type.Ref('PlanEntryStatus')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "PlanEntryPriority": Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')]),
  "PlanEntryStatus": Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')]),
  "Plan": Type.Object({ "entries": Type.Array(Type.Ref('PlanEntry')), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "AvailableCommand": Type.Object({ "name": Type.String(), "description": Type.String(), "input": Type.Optional(Type.Union([Type.Ref('AvailableCommandInput'), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "AvailableCommandInput": Type.Union([Type.Intersect([Type.Ref('UnstructuredCommandInput')])]),
  "UnstructuredCommandInput": Type.Object({ "hint": Type.String(), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "AvailableCommandsUpdate": Type.Object({ "availableCommands": Type.Array(Type.Ref('AvailableCommand')), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "CurrentModeUpdate": Type.Object({ "currentModeId": Type.Intersect([Type.Ref('SessionModeId')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ConfigOptionUpdate": Type.Object({ "configOptions": Type.Array(Type.Ref('SessionConfigOption')), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "SessionInfoUpdate": Type.Object({ "title": Type.Optional(Type.Union([Type.String(), Type.Null()])), "updatedAt": Type.Optional(Type.Union([Type.String(), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "Cost": Type.Object({ "amount": Type.Number(), "currency": Type.String(), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "UsageUpdate": Type.Object({ "used": Type.Integer({ minimum: 0 }), "size": Type.Integer({ minimum: 0 }), "cost": Type.Optional(Type.Union([Type.Ref('Cost'), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "CompleteElicitationNotification": Type.Object({ "elicitationId": Type.Intersect([Type.Ref('ElicitationId')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ExtNotification": Type.Unknown(),
  "ClientRequest": Type.Object({ "id": Type.Intersect([Type.Ref('RequestId')]), "method": Type.String(), "params": Type.Optional(Type.Union([Type.Union([Type.Intersect([Type.Ref('InitializeRequest')]), Type.Intersect([Type.Ref('AuthenticateRequest')]), Type.Intersect([Type.Ref('LogoutRequest')]), Type.Intersect([Type.Ref('NewSessionRequest')]), Type.Intersect([Type.Ref('LoadSessionRequest')]), Type.Intersect([Type.Ref('ListSessionsRequest')]), Type.Intersect([Type.Ref('DeleteSessionRequest')]), Type.Intersect([Type.Ref('ResumeSessionRequest')]), Type.Intersect([Type.Ref('CloseSessionRequest')]), Type.Intersect([Type.Ref('SetSessionModeRequest')]), Type.Intersect([Type.Ref('SetSessionConfigOptionRequest')]), Type.Intersect([Type.Ref('PromptRequest')]), Type.Intersect([Type.Ref('ExtRequest')])]), Type.Null()])) }),
  "InitializeRequest": Type.Object({ "protocolVersion": Type.Intersect([Type.Ref('ProtocolVersion')]), "clientCapabilities": Type.Optional(Type.Intersect([Type.Ref('ClientCapabilities')])), "clientInfo": Type.Optional(Type.Union([Type.Ref('Implementation'), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ClientCapabilities": Type.Object({ "fs": Type.Optional(Type.Intersect([Type.Ref('FileSystemCapabilities')])), "terminal": Type.Optional(Type.Boolean()), "session": Type.Optional(Type.Union([Type.Ref('ClientSessionCapabilities'), Type.Null()])), "auth": Type.Optional(Type.Intersect([Type.Ref('AuthCapabilities')])), "elicitation": Type.Optional(Type.Union([Type.Ref('ElicitationCapabilities'), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "FileSystemCapabilities": Type.Object({ "readTextFile": Type.Optional(Type.Boolean()), "writeTextFile": Type.Optional(Type.Boolean()), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ClientSessionCapabilities": Type.Object({ "configOptions": Type.Optional(Type.Union([Type.Ref('SessionConfigOptionsCapabilities'), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "SessionConfigOptionsCapabilities": Type.Object({ "boolean": Type.Optional(Type.Union([Type.Ref('BooleanConfigOptionCapabilities'), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "BooleanConfigOptionCapabilities": Type.Object({ "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "AuthCapabilities": Type.Object({ "terminal": Type.Optional(Type.Boolean()), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ElicitationCapabilities": Type.Object({ "form": Type.Optional(Type.Union([Type.Ref('ElicitationFormCapabilities'), Type.Null()])), "url": Type.Optional(Type.Union([Type.Ref('ElicitationUrlCapabilities'), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ElicitationFormCapabilities": Type.Object({ "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ElicitationUrlCapabilities": Type.Object({ "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "AuthenticateRequest": Type.Object({ "methodId": Type.Intersect([Type.Ref('AuthMethodId')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "LogoutRequest": Type.Object({ "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "NewSessionRequest": Type.Object({ "cwd": Type.String(), "additionalDirectories": Type.Optional(Type.Array(Type.String())), "mcpServers": Type.Array(Type.Ref('McpServer')), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "McpServer": Type.Union([Type.Intersect([Type.Object({ "type": Type.Literal('http') }), Type.Ref('McpServerHttp')]), Type.Intersect([Type.Object({ "type": Type.Literal('sse') }), Type.Ref('McpServerSse')]), Type.Intersect([Type.Ref('McpServerStdio')])]),
  "HttpHeader": Type.Object({ "name": Type.String(), "value": Type.String(), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "McpServerHttp": Type.Object({ "name": Type.String(), "url": Type.String(), "headers": Type.Array(Type.Ref('HttpHeader')), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "McpServerSse": Type.Object({ "name": Type.String(), "url": Type.String(), "headers": Type.Array(Type.Ref('HttpHeader')), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "McpServerStdio": Type.Object({ "name": Type.String(), "command": Type.String(), "args": Type.Array(Type.String()), "env": Type.Array(Type.Ref('EnvVariable')), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "LoadSessionRequest": Type.Object({ "mcpServers": Type.Array(Type.Ref('McpServer')), "cwd": Type.String(), "additionalDirectories": Type.Optional(Type.Array(Type.String())), "sessionId": Type.Intersect([Type.Ref('SessionId')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ListSessionsRequest": Type.Object({ "cwd": Type.Optional(Type.Union([Type.String(), Type.Null()])), "cursor": Type.Optional(Type.Union([Type.String(), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "DeleteSessionRequest": Type.Object({ "sessionId": Type.Intersect([Type.Ref('SessionId')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ResumeSessionRequest": Type.Object({ "sessionId": Type.Intersect([Type.Ref('SessionId')]), "cwd": Type.String(), "additionalDirectories": Type.Optional(Type.Array(Type.String())), "mcpServers": Type.Optional(Type.Array(Type.Ref('McpServer'))), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "CloseSessionRequest": Type.Object({ "sessionId": Type.Intersect([Type.Ref('SessionId')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "SetSessionModeRequest": Type.Object({ "sessionId": Type.Intersect([Type.Ref('SessionId')]), "modeId": Type.Intersect([Type.Ref('SessionModeId')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "SetSessionConfigOptionRequest": Type.Union([Type.Intersect([Type.Object({ "sessionId": Type.Intersect([Type.Ref('SessionId')]), "configId": Type.Intersect([Type.Ref('SessionConfigId')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }), Type.Object({ "value": Type.Boolean(), "type": Type.Literal('boolean') })]), Type.Intersect([Type.Object({ "sessionId": Type.Intersect([Type.Ref('SessionId')]), "configId": Type.Intersect([Type.Ref('SessionConfigId')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }), Type.Object({ "value": Type.Intersect([Type.Ref('SessionConfigValueId')]) })])]),
  "PromptRequest": Type.Object({ "sessionId": Type.Intersect([Type.Ref('SessionId')]), "prompt": Type.Array(Type.Ref('ContentBlock')), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ClientResponse": Type.Union([Type.Object({ "id": Type.Intersect([Type.Ref('RequestId')]), "result": Type.Union([Type.Intersect([Type.Ref('WriteTextFileResponse')]), Type.Intersect([Type.Ref('ReadTextFileResponse')]), Type.Intersect([Type.Ref('RequestPermissionResponse')]), Type.Intersect([Type.Ref('CreateTerminalResponse')]), Type.Intersect([Type.Ref('TerminalOutputResponse')]), Type.Intersect([Type.Ref('ReleaseTerminalResponse')]), Type.Intersect([Type.Ref('WaitForTerminalExitResponse')]), Type.Intersect([Type.Ref('KillTerminalResponse')]), Type.Intersect([Type.Ref('CreateElicitationResponse')]), Type.Intersect([Type.Ref('ExtResponse')])]) }), Type.Object({ "id": Type.Intersect([Type.Ref('RequestId')]), "error": Type.Intersect([Type.Ref('Error')]) })]),
  "WriteTextFileResponse": Type.Object({ "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ReadTextFileResponse": Type.Object({ "content": Type.String(), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "RequestPermissionResponse": Type.Object({ "outcome": Type.Intersect([Type.Ref('RequestPermissionOutcome')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "RequestPermissionOutcome": Type.Union([Type.Object({ "outcome": Type.Literal('cancelled') }), Type.Intersect([Type.Object({ "outcome": Type.Literal('selected') }), Type.Ref('SelectedPermissionOutcome')])]),
  "SelectedPermissionOutcome": Type.Object({ "optionId": Type.Intersect([Type.Ref('PermissionOptionId')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "CreateTerminalResponse": Type.Object({ "terminalId": Type.Intersect([Type.Ref('TerminalId')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "TerminalOutputResponse": Type.Object({ "output": Type.String(), "truncated": Type.Boolean(), "exitStatus": Type.Optional(Type.Union([Type.Ref('TerminalExitStatus'), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "TerminalExitStatus": Type.Object({ "exitCode": Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])), "signal": Type.Optional(Type.Union([Type.String(), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "ReleaseTerminalResponse": Type.Object({ "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "WaitForTerminalExitResponse": Type.Object({ "exitCode": Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])), "signal": Type.Optional(Type.Union([Type.String(), Type.Null()])), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "KillTerminalResponse": Type.Object({ "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "CreateElicitationResponse": Type.Unknown(),
  "ElicitationContentValue": Type.Union([Type.String(), Type.Integer(), Type.Number(), Type.Boolean(), Type.Array(Type.String())]),
  "ElicitationAcceptAction": Type.Object({ "content": Type.Optional(Type.Union([Type.Record(Type.String(), Type.Ref('ElicitationContentValue')), Type.Null()])) }),
  "ClientNotification": Type.Object({ "method": Type.String(), "params": Type.Optional(Type.Union([Type.Union([Type.Intersect([Type.Ref('CancelNotification')]), Type.Intersect([Type.Ref('ExtNotification')])]), Type.Null()])) }),
  "CancelNotification": Type.Object({ "sessionId": Type.Intersect([Type.Ref('SessionId')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
  "CancelRequestNotification": Type.Object({ "requestId": Type.Intersect([Type.Ref('RequestId')]), "_meta": Type.Optional(Type.Union([Type.Object({  }), Type.Null()])) }),
})

export const AgentRequest = Acp.Import('AgentRequest')
export type AgentRequest = Static<typeof AgentRequest>
export const RequestId = Acp.Import('RequestId')
export type RequestId = Static<typeof RequestId>
export const WriteTextFileRequest = Acp.Import('WriteTextFileRequest')
export type WriteTextFileRequest = Static<typeof WriteTextFileRequest>
export const SessionId = Acp.Import('SessionId')
export type SessionId = Static<typeof SessionId>
export const ReadTextFileRequest = Acp.Import('ReadTextFileRequest')
export type ReadTextFileRequest = Static<typeof ReadTextFileRequest>
export const RequestPermissionRequest = Acp.Import('RequestPermissionRequest')
export type RequestPermissionRequest = Static<typeof RequestPermissionRequest>
export const ToolCallUpdate = Acp.Import('ToolCallUpdate')
export type ToolCallUpdate = Static<typeof ToolCallUpdate>
export const ToolCallId = Acp.Import('ToolCallId')
export type ToolCallId = Static<typeof ToolCallId>
export const ToolKind = Acp.Import('ToolKind')
export type ToolKind = Static<typeof ToolKind>
export const ToolCallStatus = Acp.Import('ToolCallStatus')
export type ToolCallStatus = Static<typeof ToolCallStatus>
export const ToolCallContent = Acp.Import('ToolCallContent')
export type ToolCallContent = Static<typeof ToolCallContent>
export const ContentBlock = Acp.Import('ContentBlock')
export type ContentBlock = Static<typeof ContentBlock>
export const Annotations = Acp.Import('Annotations')
export type Annotations = Static<typeof Annotations>
export const Role = Acp.Import('Role')
export type Role = Static<typeof Role>
export const TextContent = Acp.Import('TextContent')
export type TextContent = Static<typeof TextContent>
export const ImageContent = Acp.Import('ImageContent')
export type ImageContent = Static<typeof ImageContent>
export const AudioContent = Acp.Import('AudioContent')
export type AudioContent = Static<typeof AudioContent>
export const ResourceLink = Acp.Import('ResourceLink')
export type ResourceLink = Static<typeof ResourceLink>
export const EmbeddedResourceResource = Acp.Import('EmbeddedResourceResource')
export type EmbeddedResourceResource = Static<typeof EmbeddedResourceResource>
export const TextResourceContents = Acp.Import('TextResourceContents')
export type TextResourceContents = Static<typeof TextResourceContents>
export const BlobResourceContents = Acp.Import('BlobResourceContents')
export type BlobResourceContents = Static<typeof BlobResourceContents>
export const EmbeddedResource = Acp.Import('EmbeddedResource')
export type EmbeddedResource = Static<typeof EmbeddedResource>
export const Content = Acp.Import('Content')
export type Content = Static<typeof Content>
export const Diff = Acp.Import('Diff')
export type Diff = Static<typeof Diff>
export const TerminalId = Acp.Import('TerminalId')
export type TerminalId = Static<typeof TerminalId>
export const Terminal = Acp.Import('Terminal')
export type Terminal = Static<typeof Terminal>
export const ToolCallLocation = Acp.Import('ToolCallLocation')
export type ToolCallLocation = Static<typeof ToolCallLocation>
export const PermissionOption = Acp.Import('PermissionOption')
export type PermissionOption = Static<typeof PermissionOption>
export const PermissionOptionId = Acp.Import('PermissionOptionId')
export type PermissionOptionId = Static<typeof PermissionOptionId>
export const PermissionOptionKind = Acp.Import('PermissionOptionKind')
export type PermissionOptionKind = Static<typeof PermissionOptionKind>
export const CreateTerminalRequest = Acp.Import('CreateTerminalRequest')
export type CreateTerminalRequest = Static<typeof CreateTerminalRequest>
export const EnvVariable = Acp.Import('EnvVariable')
export type EnvVariable = Static<typeof EnvVariable>
export const TerminalOutputRequest = Acp.Import('TerminalOutputRequest')
export type TerminalOutputRequest = Static<typeof TerminalOutputRequest>
export const ReleaseTerminalRequest = Acp.Import('ReleaseTerminalRequest')
export type ReleaseTerminalRequest = Static<typeof ReleaseTerminalRequest>
export const WaitForTerminalExitRequest = Acp.Import('WaitForTerminalExitRequest')
export type WaitForTerminalExitRequest = Static<typeof WaitForTerminalExitRequest>
export const KillTerminalRequest = Acp.Import('KillTerminalRequest')
export type KillTerminalRequest = Static<typeof KillTerminalRequest>
export const CreateElicitationRequest = Acp.Import('CreateElicitationRequest')
export type CreateElicitationRequest = Static<typeof CreateElicitationRequest>
export const ElicitationSessionScope = Acp.Import('ElicitationSessionScope')
export type ElicitationSessionScope = Static<typeof ElicitationSessionScope>
export const ElicitationRequestScope = Acp.Import('ElicitationRequestScope')
export type ElicitationRequestScope = Static<typeof ElicitationRequestScope>
export const ElicitationSchema = Acp.Import('ElicitationSchema')
export type ElicitationSchema = Static<typeof ElicitationSchema>
export const ElicitationSchemaType = Acp.Import('ElicitationSchemaType')
export type ElicitationSchemaType = Static<typeof ElicitationSchemaType>
export const ElicitationPropertySchema = Acp.Import('ElicitationPropertySchema')
export type ElicitationPropertySchema = Static<typeof ElicitationPropertySchema>
export const StringFormat = Acp.Import('StringFormat')
export type StringFormat = Static<typeof StringFormat>
export const EnumOption = Acp.Import('EnumOption')
export type EnumOption = Static<typeof EnumOption>
export const StringPropertySchema = Acp.Import('StringPropertySchema')
export type StringPropertySchema = Static<typeof StringPropertySchema>
export const NumberPropertySchema = Acp.Import('NumberPropertySchema')
export type NumberPropertySchema = Static<typeof NumberPropertySchema>
export const IntegerPropertySchema = Acp.Import('IntegerPropertySchema')
export type IntegerPropertySchema = Static<typeof IntegerPropertySchema>
export const BooleanPropertySchema = Acp.Import('BooleanPropertySchema')
export type BooleanPropertySchema = Static<typeof BooleanPropertySchema>
export const MultiSelectItems = Acp.Import('MultiSelectItems')
export type MultiSelectItems = Static<typeof MultiSelectItems>
export const StringMultiSelectItems = Acp.Import('StringMultiSelectItems')
export type StringMultiSelectItems = Static<typeof StringMultiSelectItems>
export const TitledMultiSelectItems = Acp.Import('TitledMultiSelectItems')
export type TitledMultiSelectItems = Static<typeof TitledMultiSelectItems>
export const MultiSelectPropertySchema = Acp.Import('MultiSelectPropertySchema')
export type MultiSelectPropertySchema = Static<typeof MultiSelectPropertySchema>
export const ElicitationFormMode = Acp.Import('ElicitationFormMode')
export type ElicitationFormMode = Static<typeof ElicitationFormMode>
export const ElicitationId = Acp.Import('ElicitationId')
export type ElicitationId = Static<typeof ElicitationId>
export const ElicitationUrlMode = Acp.Import('ElicitationUrlMode')
export type ElicitationUrlMode = Static<typeof ElicitationUrlMode>
export const ExtRequest = Acp.Import('ExtRequest')
export type ExtRequest = Static<typeof ExtRequest>
export const AgentResponse = Acp.Import('AgentResponse')
export type AgentResponse = Static<typeof AgentResponse>
export const InitializeResponse = Acp.Import('InitializeResponse')
export type InitializeResponse = Static<typeof InitializeResponse>
export const ProtocolVersion = Acp.Import('ProtocolVersion')
export type ProtocolVersion = Static<typeof ProtocolVersion>
export const AgentCapabilities = Acp.Import('AgentCapabilities')
export type AgentCapabilities = Static<typeof AgentCapabilities>
export const PromptCapabilities = Acp.Import('PromptCapabilities')
export type PromptCapabilities = Static<typeof PromptCapabilities>
export const McpCapabilities = Acp.Import('McpCapabilities')
export type McpCapabilities = Static<typeof McpCapabilities>
export const SessionCapabilities = Acp.Import('SessionCapabilities')
export type SessionCapabilities = Static<typeof SessionCapabilities>
export const SessionListCapabilities = Acp.Import('SessionListCapabilities')
export type SessionListCapabilities = Static<typeof SessionListCapabilities>
export const SessionDeleteCapabilities = Acp.Import('SessionDeleteCapabilities')
export type SessionDeleteCapabilities = Static<typeof SessionDeleteCapabilities>
export const SessionAdditionalDirectoriesCapabilities = Acp.Import('SessionAdditionalDirectoriesCapabilities')
export type SessionAdditionalDirectoriesCapabilities = Static<typeof SessionAdditionalDirectoriesCapabilities>
export const SessionResumeCapabilities = Acp.Import('SessionResumeCapabilities')
export type SessionResumeCapabilities = Static<typeof SessionResumeCapabilities>
export const SessionCloseCapabilities = Acp.Import('SessionCloseCapabilities')
export type SessionCloseCapabilities = Static<typeof SessionCloseCapabilities>
export const AgentAuthCapabilities = Acp.Import('AgentAuthCapabilities')
export type AgentAuthCapabilities = Static<typeof AgentAuthCapabilities>
export const LogoutCapabilities = Acp.Import('LogoutCapabilities')
export type LogoutCapabilities = Static<typeof LogoutCapabilities>
export const AuthMethod = Acp.Import('AuthMethod')
export type AuthMethod = Static<typeof AuthMethod>
export const AuthMethodId = Acp.Import('AuthMethodId')
export type AuthMethodId = Static<typeof AuthMethodId>
export const AuthMethodTerminal = Acp.Import('AuthMethodTerminal')
export type AuthMethodTerminal = Static<typeof AuthMethodTerminal>
export const AuthMethodAgent = Acp.Import('AuthMethodAgent')
export type AuthMethodAgent = Static<typeof AuthMethodAgent>
export const Implementation = Acp.Import('Implementation')
export type Implementation = Static<typeof Implementation>
export const AuthenticateResponse = Acp.Import('AuthenticateResponse')
export type AuthenticateResponse = Static<typeof AuthenticateResponse>
export const LogoutResponse = Acp.Import('LogoutResponse')
export type LogoutResponse = Static<typeof LogoutResponse>
export const NewSessionResponse = Acp.Import('NewSessionResponse')
export type NewSessionResponse = Static<typeof NewSessionResponse>
export const SessionModeState = Acp.Import('SessionModeState')
export type SessionModeState = Static<typeof SessionModeState>
export const SessionModeId = Acp.Import('SessionModeId')
export type SessionModeId = Static<typeof SessionModeId>
export const SessionMode = Acp.Import('SessionMode')
export type SessionMode = Static<typeof SessionMode>
export const SessionConfigOption = Acp.Import('SessionConfigOption')
export type SessionConfigOption = Static<typeof SessionConfigOption>
export const SessionConfigId = Acp.Import('SessionConfigId')
export type SessionConfigId = Static<typeof SessionConfigId>
export const SessionConfigOptionCategory = Acp.Import('SessionConfigOptionCategory')
export type SessionConfigOptionCategory = Static<typeof SessionConfigOptionCategory>
export const SessionConfigValueId = Acp.Import('SessionConfigValueId')
export type SessionConfigValueId = Static<typeof SessionConfigValueId>
export const SessionConfigSelectOptions = Acp.Import('SessionConfigSelectOptions')
export type SessionConfigSelectOptions = Static<typeof SessionConfigSelectOptions>
export const SessionConfigSelectOption = Acp.Import('SessionConfigSelectOption')
export type SessionConfigSelectOption = Static<typeof SessionConfigSelectOption>
export const SessionConfigSelectGroup = Acp.Import('SessionConfigSelectGroup')
export type SessionConfigSelectGroup = Static<typeof SessionConfigSelectGroup>
export const SessionConfigGroupId = Acp.Import('SessionConfigGroupId')
export type SessionConfigGroupId = Static<typeof SessionConfigGroupId>
export const SessionConfigSelect = Acp.Import('SessionConfigSelect')
export type SessionConfigSelect = Static<typeof SessionConfigSelect>
export const SessionConfigBoolean = Acp.Import('SessionConfigBoolean')
export type SessionConfigBoolean = Static<typeof SessionConfigBoolean>
export const LoadSessionResponse = Acp.Import('LoadSessionResponse')
export type LoadSessionResponse = Static<typeof LoadSessionResponse>
export const ListSessionsResponse = Acp.Import('ListSessionsResponse')
export type ListSessionsResponse = Static<typeof ListSessionsResponse>
export const SessionInfo = Acp.Import('SessionInfo')
export type SessionInfo = Static<typeof SessionInfo>
export const DeleteSessionResponse = Acp.Import('DeleteSessionResponse')
export type DeleteSessionResponse = Static<typeof DeleteSessionResponse>
export const ResumeSessionResponse = Acp.Import('ResumeSessionResponse')
export type ResumeSessionResponse = Static<typeof ResumeSessionResponse>
export const CloseSessionResponse = Acp.Import('CloseSessionResponse')
export type CloseSessionResponse = Static<typeof CloseSessionResponse>
export const SetSessionModeResponse = Acp.Import('SetSessionModeResponse')
export type SetSessionModeResponse = Static<typeof SetSessionModeResponse>
export const SetSessionConfigOptionResponse = Acp.Import('SetSessionConfigOptionResponse')
export type SetSessionConfigOptionResponse = Static<typeof SetSessionConfigOptionResponse>
export const PromptResponse = Acp.Import('PromptResponse')
export type PromptResponse = Static<typeof PromptResponse>
export const StopReason = Acp.Import('StopReason')
export type StopReason = Static<typeof StopReason>
export const ExtResponse = Acp.Import('ExtResponse')
export type ExtResponse = Static<typeof ExtResponse>
export const Error = Acp.Import('Error')
export type Error = Static<typeof Error>
export const ErrorCode = Acp.Import('ErrorCode')
export type ErrorCode = Static<typeof ErrorCode>
export const AgentNotification = Acp.Import('AgentNotification')
export type AgentNotification = Static<typeof AgentNotification>
export const SessionNotification = Acp.Import('SessionNotification')
export type SessionNotification = Static<typeof SessionNotification>
export const SessionUpdate = Acp.Import('SessionUpdate')
export type SessionUpdate = Static<typeof SessionUpdate>
export const MessageId = Acp.Import('MessageId')
export type MessageId = Static<typeof MessageId>
export const ContentChunk = Acp.Import('ContentChunk')
export type ContentChunk = Static<typeof ContentChunk>
export const ToolCall = Acp.Import('ToolCall')
export type ToolCall = Static<typeof ToolCall>
export const PlanEntry = Acp.Import('PlanEntry')
export type PlanEntry = Static<typeof PlanEntry>
export const PlanEntryPriority = Acp.Import('PlanEntryPriority')
export type PlanEntryPriority = Static<typeof PlanEntryPriority>
export const PlanEntryStatus = Acp.Import('PlanEntryStatus')
export type PlanEntryStatus = Static<typeof PlanEntryStatus>
export const Plan = Acp.Import('Plan')
export type Plan = Static<typeof Plan>
export const AvailableCommand = Acp.Import('AvailableCommand')
export type AvailableCommand = Static<typeof AvailableCommand>
export const AvailableCommandInput = Acp.Import('AvailableCommandInput')
export type AvailableCommandInput = Static<typeof AvailableCommandInput>
export const UnstructuredCommandInput = Acp.Import('UnstructuredCommandInput')
export type UnstructuredCommandInput = Static<typeof UnstructuredCommandInput>
export const AvailableCommandsUpdate = Acp.Import('AvailableCommandsUpdate')
export type AvailableCommandsUpdate = Static<typeof AvailableCommandsUpdate>
export const CurrentModeUpdate = Acp.Import('CurrentModeUpdate')
export type CurrentModeUpdate = Static<typeof CurrentModeUpdate>
export const ConfigOptionUpdate = Acp.Import('ConfigOptionUpdate')
export type ConfigOptionUpdate = Static<typeof ConfigOptionUpdate>
export const SessionInfoUpdate = Acp.Import('SessionInfoUpdate')
export type SessionInfoUpdate = Static<typeof SessionInfoUpdate>
export const Cost = Acp.Import('Cost')
export type Cost = Static<typeof Cost>
export const UsageUpdate = Acp.Import('UsageUpdate')
export type UsageUpdate = Static<typeof UsageUpdate>
export const CompleteElicitationNotification = Acp.Import('CompleteElicitationNotification')
export type CompleteElicitationNotification = Static<typeof CompleteElicitationNotification>
export const ExtNotification = Acp.Import('ExtNotification')
export type ExtNotification = Static<typeof ExtNotification>
export const ClientRequest = Acp.Import('ClientRequest')
export type ClientRequest = Static<typeof ClientRequest>
export const InitializeRequest = Acp.Import('InitializeRequest')
export type InitializeRequest = Static<typeof InitializeRequest>
export const ClientCapabilities = Acp.Import('ClientCapabilities')
export type ClientCapabilities = Static<typeof ClientCapabilities>
export const FileSystemCapabilities = Acp.Import('FileSystemCapabilities')
export type FileSystemCapabilities = Static<typeof FileSystemCapabilities>
export const ClientSessionCapabilities = Acp.Import('ClientSessionCapabilities')
export type ClientSessionCapabilities = Static<typeof ClientSessionCapabilities>
export const SessionConfigOptionsCapabilities = Acp.Import('SessionConfigOptionsCapabilities')
export type SessionConfigOptionsCapabilities = Static<typeof SessionConfigOptionsCapabilities>
export const BooleanConfigOptionCapabilities = Acp.Import('BooleanConfigOptionCapabilities')
export type BooleanConfigOptionCapabilities = Static<typeof BooleanConfigOptionCapabilities>
export const AuthCapabilities = Acp.Import('AuthCapabilities')
export type AuthCapabilities = Static<typeof AuthCapabilities>
export const ElicitationCapabilities = Acp.Import('ElicitationCapabilities')
export type ElicitationCapabilities = Static<typeof ElicitationCapabilities>
export const ElicitationFormCapabilities = Acp.Import('ElicitationFormCapabilities')
export type ElicitationFormCapabilities = Static<typeof ElicitationFormCapabilities>
export const ElicitationUrlCapabilities = Acp.Import('ElicitationUrlCapabilities')
export type ElicitationUrlCapabilities = Static<typeof ElicitationUrlCapabilities>
export const AuthenticateRequest = Acp.Import('AuthenticateRequest')
export type AuthenticateRequest = Static<typeof AuthenticateRequest>
export const LogoutRequest = Acp.Import('LogoutRequest')
export type LogoutRequest = Static<typeof LogoutRequest>
export const NewSessionRequest = Acp.Import('NewSessionRequest')
export type NewSessionRequest = Static<typeof NewSessionRequest>
export const McpServer = Acp.Import('McpServer')
export type McpServer = Static<typeof McpServer>
export const HttpHeader = Acp.Import('HttpHeader')
export type HttpHeader = Static<typeof HttpHeader>
export const McpServerHttp = Acp.Import('McpServerHttp')
export type McpServerHttp = Static<typeof McpServerHttp>
export const McpServerSse = Acp.Import('McpServerSse')
export type McpServerSse = Static<typeof McpServerSse>
export const McpServerStdio = Acp.Import('McpServerStdio')
export type McpServerStdio = Static<typeof McpServerStdio>
export const LoadSessionRequest = Acp.Import('LoadSessionRequest')
export type LoadSessionRequest = Static<typeof LoadSessionRequest>
export const ListSessionsRequest = Acp.Import('ListSessionsRequest')
export type ListSessionsRequest = Static<typeof ListSessionsRequest>
export const DeleteSessionRequest = Acp.Import('DeleteSessionRequest')
export type DeleteSessionRequest = Static<typeof DeleteSessionRequest>
export const ResumeSessionRequest = Acp.Import('ResumeSessionRequest')
export type ResumeSessionRequest = Static<typeof ResumeSessionRequest>
export const CloseSessionRequest = Acp.Import('CloseSessionRequest')
export type CloseSessionRequest = Static<typeof CloseSessionRequest>
export const SetSessionModeRequest = Acp.Import('SetSessionModeRequest')
export type SetSessionModeRequest = Static<typeof SetSessionModeRequest>
export const SetSessionConfigOptionRequest = Acp.Import('SetSessionConfigOptionRequest')
export type SetSessionConfigOptionRequest = Static<typeof SetSessionConfigOptionRequest>
export const PromptRequest = Acp.Import('PromptRequest')
export type PromptRequest = Static<typeof PromptRequest>
export const ClientResponse = Acp.Import('ClientResponse')
export type ClientResponse = Static<typeof ClientResponse>
export const WriteTextFileResponse = Acp.Import('WriteTextFileResponse')
export type WriteTextFileResponse = Static<typeof WriteTextFileResponse>
export const ReadTextFileResponse = Acp.Import('ReadTextFileResponse')
export type ReadTextFileResponse = Static<typeof ReadTextFileResponse>
export const RequestPermissionResponse = Acp.Import('RequestPermissionResponse')
export type RequestPermissionResponse = Static<typeof RequestPermissionResponse>
export const RequestPermissionOutcome = Acp.Import('RequestPermissionOutcome')
export type RequestPermissionOutcome = Static<typeof RequestPermissionOutcome>
export const SelectedPermissionOutcome = Acp.Import('SelectedPermissionOutcome')
export type SelectedPermissionOutcome = Static<typeof SelectedPermissionOutcome>
export const CreateTerminalResponse = Acp.Import('CreateTerminalResponse')
export type CreateTerminalResponse = Static<typeof CreateTerminalResponse>
export const TerminalOutputResponse = Acp.Import('TerminalOutputResponse')
export type TerminalOutputResponse = Static<typeof TerminalOutputResponse>
export const TerminalExitStatus = Acp.Import('TerminalExitStatus')
export type TerminalExitStatus = Static<typeof TerminalExitStatus>
export const ReleaseTerminalResponse = Acp.Import('ReleaseTerminalResponse')
export type ReleaseTerminalResponse = Static<typeof ReleaseTerminalResponse>
export const WaitForTerminalExitResponse = Acp.Import('WaitForTerminalExitResponse')
export type WaitForTerminalExitResponse = Static<typeof WaitForTerminalExitResponse>
export const KillTerminalResponse = Acp.Import('KillTerminalResponse')
export type KillTerminalResponse = Static<typeof KillTerminalResponse>
export const CreateElicitationResponse = Acp.Import('CreateElicitationResponse')
export type CreateElicitationResponse = Static<typeof CreateElicitationResponse>
export const ElicitationContentValue = Acp.Import('ElicitationContentValue')
export type ElicitationContentValue = Static<typeof ElicitationContentValue>
export const ElicitationAcceptAction = Acp.Import('ElicitationAcceptAction')
export type ElicitationAcceptAction = Static<typeof ElicitationAcceptAction>
export const ClientNotification = Acp.Import('ClientNotification')
export type ClientNotification = Static<typeof ClientNotification>
export const CancelNotification = Acp.Import('CancelNotification')
export type CancelNotification = Static<typeof CancelNotification>
export const CancelRequestNotification = Acp.Import('CancelRequestNotification')
export type CancelRequestNotification = Static<typeof CancelRequestNotification>
