// generated from schema/app-server.json by tools/gen.ts — do not edit
const PUBLIC_ERROR_COPY = {
  "internal": {
    "en": {
      "reason": "The operation could not be confirmed.",
      "action": "Inspect its status using the diagnostic ID."
    },
    "zh-CN": {
      "reason": "无法确认操作结果。",
      "action": "请使用诊断 ID 检查状态。"
    }
  },
  "rejected": {
    "en": {
      "reason": "The operation was refused.",
      "action": "Check its configuration and current state."
    },
    "zh-CN": {
      "reason": "操作被拒绝。",
      "action": "请检查配置和当前状态。"
    }
  },
  "forbidden": {
    "en": {
      "reason": "Permission for this operation was denied.",
      "action": "Ask an administrator to review the applicable policy before retrying."
    },
    "zh-CN": {
      "reason": "此操作的权限被拒绝。",
      "action": "请管理员复核适用策略后再重试。"
    }
  },
  "permissionRevoked": {
    "en": {
      "reason": "The full-access authority was revoked.",
      "action": "Refresh the session permission and request a new approval."
    },
    "zh-CN": {
      "reason": "完全访问授权已撤销。",
      "action": "请刷新会话权限并重新请求审批。"
    }
  },
  "permissionGrant": {
    "en": {
      "reason": "The permission grant is missing, expired or already consumed.",
      "action": "Request a new approval for this action."
    },
    "zh-CN": {
      "reason": "权限授权缺失、已过期或已使用。",
      "action": "请为此操作重新请求审批。"
    }
  },
  "preset": {
    "en": {
      "reason": "The preset or permission selection was refused.",
      "action": "Choose a supported preset and a compatible permission level."
    },
    "zh-CN": {
      "reason": "预设或权限选择被拒绝。",
      "action": "请选择受支持的预设及兼容的权限级别。"
    }
  },
  "model": {
    "en": {
      "reason": "The requested model is not available in this profile.",
      "action": "Run `agh doctor provider` to list the configured routes and choose one of them."
    },
    "zh-CN": {
      "reason": "当前配置中没有所请求的模型。",
      "action": "运行 `agh doctor provider` 查看已配置的路由，并从中选择。"
    }
  },
  "modelUnknown": {
    "en": {
      "reason": "The requested model or route is not in the configured model catalogue.",
      "action": "Run `agh doctor provider` to list the configured routes and their models, and choose one of them."
    },
    "zh-CN": {
      "reason": "所请求的模型或路由不在已配置的模型目录中。",
      "action": "运行 `agh doctor provider` 查看已配置的路由及其模型，并从中选择。"
    }
  },
  "modelRestart": {
    "en": {
      "reason": "A saved account or model change is not active until the daemon restarts, so the requested model is not loaded yet.",
      "action": "Restart the daemon with `agh daemon stop`; the next agh command starts it with the saved configuration. If the model is still refused, run `agh doctor provider` to list the configured routes."
    },
    "zh-CN": {
      "reason": "已保存的账户或模型改动需重启后台才生效，所请求的模型尚未加载。",
      "action": "运行 `agh daemon stop` 重启后台；下一条 agh 命令会以已保存的配置启动它。若仍被拒绝，运行 `agh doctor provider` 查看已配置的路由。"
    }
  },
  "permissionAxis": {
    "en": {
      "reason": "The preset cannot accept the requested permission overlay.",
      "action": "Choose a compatible preset and permission level; required isolation must remain enabled."
    },
    "zh-CN": {
      "reason": "预设无法接受请求的权限叠加。",
      "action": "请选择兼容的预设和权限级别，并保留必需的隔离。"
    }
  },
  "approval": {
    "en": {
      "reason": "The action was rejected during approval.",
      "action": "Ask the reviewer before submitting the action again."
    },
    "zh-CN": {
      "reason": "此操作在审批时被拒绝。",
      "action": "再次提交前请先询问审核人。"
    }
  },
  "budget": {
    "en": {
      "reason": "The operation was refused by the budget limit.",
      "action": "Review the remaining budget and limits before trying again."
    },
    "zh-CN": {
      "reason": "操作因预算限制被拒绝。",
      "action": "请检查剩余预算和上限后再重试。"
    }
  },
  "publication": {
    "en": {
      "reason": "Plugin publication was refused by trust or capability policy.",
      "action": "Review the candidate, declared capabilities and publication approval."
    },
    "zh-CN": {
      "reason": "插件发布被信任或能力策略拒绝。",
      "action": "请复核候选、声明的能力及发布审批。"
    }
  },
  "pluginTest": {
    "en": {
      "reason": "The plugin test was refused.",
      "action": "Review the test approval and sandbox requirements before retrying."
    },
    "zh-CN": {
      "reason": "插件测试被拒绝。",
      "action": "请复核测试审批和沙箱要求后再重试。"
    }
  },
  "unavailable": {
    "en": {
      "reason": "The required backend is unavailable.",
      "action": "Check its configuration and compatibility."
    },
    "zh-CN": {
      "reason": "所需后端不可用。",
      "action": "请检查配置和兼容性。"
    }
  },
  "conflict": {
    "en": {
      "reason": "The resource changed.",
      "action": "Reload the latest state before retrying."
    },
    "zh-CN": {
      "reason": "资源已变更。",
      "action": "请重新载入最新状态后重试。"
    }
  },
  "busy": {
    "en": {
      "reason": "The resource is busy.",
      "action": "Wait for the current operation to finish."
    },
    "zh-CN": {
      "reason": "资源正在使用中。",
      "action": "请等待当前操作结束。"
    }
  },
  "auth": {
    "en": {
      "reason": "Authentication was refused.",
      "action": "Reconnect and authenticate again."
    },
    "zh-CN": {
      "reason": "认证被拒绝。",
      "action": "请重新连接并认证。"
    }
  },
  "invalidParams": {
    "en": {
      "reason": "The request parameters were refused.",
      "action": "Check the parameters and submit a valid request."
    },
    "zh-CN": {
      "reason": "请求参数被拒绝。",
      "action": "请检查参数并提交有效请求。"
    }
  },
  "invalidRequest": {
    "en": {
      "reason": "The request is not valid.",
      "action": "Check the request format."
    },
    "zh-CN": {
      "reason": "请求无效。",
      "action": "请检查请求格式。"
    }
  },
  "methodNotFound": {
    "en": {
      "reason": "This operation is unavailable.",
      "action": "Use a supported operation."
    },
    "zh-CN": {
      "reason": "此操作不可用。",
      "action": "请使用受支持的操作。"
    }
  },
  "notFound": {
    "en": {
      "reason": "The session or resource is unavailable.",
      "action": "Refresh the resource list."
    },
    "zh-CN": {
      "reason": "会话或资源不可用。",
      "action": "请刷新资源列表。"
    }
  },
  "chatModelRequired": {
    "en": {
      "reason": "Image and video generation models cannot be used for chat.",
      "action": "Choose a chat-capable model in model settings."
    },
    "zh-CN": {
      "reason": "图片或视频生成模型不能用于对话。",
      "action": "请在模型设置中选择支持对话的模型。"
    }
  },
  "credentialRequired": {
    "en": {
      "reason": "A provider credential is required.",
      "action": "Add a credential for this provider."
    },
    "zh-CN": {
      "reason": "缺少提供方凭据。",
      "action": "请为此提供方添加凭据。"
    }
  },
  "credentialRejected": {
    "en": {
      "reason": "The credential was rejected.",
      "action": "Check it and try again."
    },
    "zh-CN": {
      "reason": "凭据被拒绝。",
      "action": "请检查后重试。"
    }
  },
  "credentialStore": {
    "en": {
      "reason": "The credential could not be stored.",
      "action": "Check storage access."
    },
    "zh-CN": {
      "reason": "无法保存凭据。",
      "action": "请检查存储权限。"
    }
  },
  "provider": {
    "en": {
      "reason": "The selected provider cannot serve this request.",
      "action": "Check plugin state and compatibility."
    },
    "zh-CN": {
      "reason": "所选提供方无法处理请求。",
      "action": "请检查插件状态和兼容性。"
    }
  },
  "generation": {
    "en": {
      "reason": "The pinned plugin generation is unavailable or incompatible.",
      "action": "Review the plugin generation and session recovery options."
    },
    "zh-CN": {
      "reason": "固定的插件代际不可用或不兼容。",
      "action": "请检查插件代际和会话恢复选项。"
    }
  },
  "sessionNewer": {
    "en": {
      "reason": "This session was written by a newer AGH version.",
      "action": "Upgrade AGH to continue; history remains readable."
    },
    "zh-CN": {
      "reason": "此会话由更新版本的 AGH 写入。",
      "action": "请升级 AGH 后再继续；仍可查看历史。"
    }
  },
  "sessionOlder": {
    "en": {
      "reason": "This session needs an older plugin version.",
      "action": "Read its history or start a new session; an administrator can migrate it."
    },
    "zh-CN": {
      "reason": "此会话需要旧版插件。",
      "action": "可查看历史或新开会话；管理员可以迁移会话。"
    }
  },
  "sessionCorrupt": {
    "en": {
      "reason": "This session failed an integrity check.",
      "action": "Keep its history for diagnosis and start a new session."
    },
    "zh-CN": {
      "reason": "此会话未通过完整性检查。",
      "action": "请保留历史用于诊断，并新开会话。"
    }
  },
  "memoryCap": {
    "en": {
      "reason": "The memory file exceeds its limits.",
      "action": "Consolidate it within the file size and line limits; the previous file was kept."
    },
    "zh-CN": {
      "reason": "记忆文件超出限制。",
      "action": "请整理至文件大小和行数上限内；原文件已保留。"
    }
  },
  "memorySecret": {
    "en": {
      "reason": "Secret-like content cannot be saved as memory.",
      "action": "Remove credentials before saving."
    },
    "zh-CN": {
      "reason": "疑似凭据的内容不能保存到记忆。",
      "action": "请移除凭据后再保存。"
    }
  },
  "memoryDisabled": {
    "en": {
      "reason": "Memory is disabled.",
      "action": "Review the memory setting before requesting access."
    },
    "zh-CN": {
      "reason": "记忆已关闭。",
      "action": "请复核记忆设置后再请求访问。"
    }
  },
  "memoryPartial": {
    "en": {
      "reason": "The file was saved, but writer metadata failed.",
      "action": "Reload to inspect the saved file."
    },
    "zh-CN": {
      "reason": "文件已保存，但写入来源记录失败。",
      "action": "请重新载入检查已保存的文件。"
    }
  },
  "timeout": {
    "en": {
      "reason": "The operation timed out.",
      "action": "Inspect its status before retrying."
    },
    "zh-CN": {
      "reason": "操作超时。",
      "action": "请检查状态后再重试。"
    }
  },
  "sessionSandbox": {
    "en": {
      "reason": "This session has missing or incompatible execution isolation records.",
      "action": "Read its history and start a new session to continue working."
    },
    "zh-CN": {
      "reason": "此会话的执行隔离记录缺失或不匹配。",
      "action": "可以查看历史；请新建会话以继续工作。"
    }
  },
  "rateLimit": {
    "en": {
      "reason": "The provider rate limit was reached.",
      "action": "Wait before submitting another request."
    },
    "zh-CN": {
      "reason": "已达到提供方速率限制。",
      "action": "请稍后再提交请求。"
    }
  },
  "outputLimit": {
    "en": {
      "reason": "The model output limit was reached.",
      "action": "Reduce the requested output or review the model limits."
    },
    "zh-CN": {
      "reason": "已达到模型输出限制。",
      "action": "请减少请求的输出或复核模型上限。"
    }
  },
  "pluginReview": {
    "en": {
      "reason": "Plugin publication requires a current human review.",
      "action": "Open the candidate review, inspect its tests and permissions, then approve or reject it there."
    },
    "zh-CN": {
      "reason": "插件发布需要当前有效的人工审核。",
      "action": "请打开候选审核，检查测试和权限，并在那里批准或拒绝。"
    }
  },
  "transport": {
    "en": {
      "reason": "The provider could not be reached, or it answered with a server error.",
      "action": "Check connectivity and try again later. If it keeps happening, the provider may be down."
    },
    "zh-CN": {
      "reason": "无法连接提供方，或提供方返回了服务器错误。",
      "action": "请检查网络后稍后再试；如果持续出现，可能是提供方暂时不可用。"
    }
  },
  "providerAuth": {
    "en": {
      "reason": "The provider refused this model or its credentials.",
      "action": "Pick another model or sign in again."
    },
    "zh-CN": {
      "reason": "提供方拒绝了所选模型或凭据。",
      "action": "请选择其他模型或重新登录。"
    }
  },
  "forkBoundary": {
    "en": {
      "reason": "The fork boundary must be a completed turn.",
      "action": "Choose a completed turn/end sequence."
    },
    "zh-CN": {
      "reason": "分支起点必须是已完成的轮次。",
      "action": "请选择已完成的 turn/end 序号。"
    }
  },
  "bundleUnavailable": {
    "en": {
      "reason": "The selected agent bundle is unavailable.",
      "action": "Install, enable and trust the bundle, or choose another agent."
    },
    "zh-CN": {
      "reason": "所选 Agent 组合不可用。",
      "action": "请安装、启用并信任该组合，或选择其他 Agent。"
    }
  },
  "providerUnconfigured": {
    "en": {
      "reason": "No model provider is configured for this profile.",
      "action": "Run agh config to add a provider."
    },
    "zh-CN": {
      "reason": "当前配置尚未设置模型提供方。",
      "action": "请运行 agh config 添加提供方。"
    }
  },
  "loopMissing": {
    "en": {
      "reason": "The selected Loop is not installed.",
      "action": "Install its pinned ID and version before retrying."
    },
    "zh-CN": {
      "reason": "所选 Loop 尚未安装。",
      "action": "请安装其固定的 ID 和版本后再重试。"
    }
  },
  "sandboxUnavailable": {
    "en": {
      "reason": "Required execution isolation is unavailable.",
      "action": "Choose an available sandbox or review the required isolation settings."
    },
    "zh-CN": {
      "reason": "必需的执行隔离不可用。",
      "action": "请选择可用的沙箱，或复核必需隔离设置。"
    }
  },
  "cleanHome": {
    "en": {
      "reason": "This home or request uses a retired preview format.",
      "action": "Select a new, empty private AGH_HOME, configure it again, and use explicit recipe and permission fields. No data conversion or old trust is carried over."
    },
    "zh-CN": {
      "reason": "该 home 或请求使用了已退役的预览格式。",
      "action": "请使用新的空私有 AGH_HOME，重新配置，并分别指定配方与权限。不会转换旧数据或沿用旧信任。"
    }
  }
} as const
export const PUBLIC_ERROR_CONTRACT = {
  "CONFIG_AUTH_BUSY": { rpc: "AUTH_INVALID", messageKey: "appServer.errors.auth", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["auth"], reasons: {  } },
  "CONFIG_AUTH_CANCELLED": { rpc: "AUTH_INVALID", messageKey: "appServer.errors.auth", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["auth"], reasons: {  } },
  "CONFIG_AUTH_EXPIRED": { rpc: "AUTH_INVALID", messageKey: "appServer.errors.auth", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["auth"], reasons: {  } },
  "CONFIG_AUTH_FAILED": { rpc: "AUTH_INVALID", messageKey: "appServer.errors.auth", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["auth"], reasons: {  } },
  "CONFIG_AUTH_UNAVAILABLE": { rpc: "AUTH_INVALID", messageKey: "appServer.errors.auth", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["auth"], reasons: {  } },
  "CONFIG_CREDENTIAL_INVALID": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.credentialStore", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["credentialStore"], reasons: {  } },
  "CONFIG_CREDENTIAL_NOT_FOUND": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.credentialStore", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["credentialStore"], reasons: {  } },
  "CONFIG_CREDENTIAL_REFERENCED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.credentialStore", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["credentialStore"], reasons: {  } },
  "CONFIG_CREDENTIAL_CONFIRMATION_REQUIRED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.credentialStore", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["credentialStore"], reasons: {  } },
  "CONFIG_CREDENTIAL_UNAVAILABLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.credentialStore", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["credentialStore"], reasons: {  } },
  "CONFIG_CREDENTIAL_NO_SPACE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.credentialStore", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["credentialStore"], reasons: {  } },
  "CONFIG_CREDENTIAL_PERMISSIONS": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.credentialStore", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["credentialStore"], reasons: {  } },
  "CONFIG_CREDENTIAL_READ_ONLY": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.credentialStore", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["credentialStore"], reasons: {  } },
  "CONFIG_CREDENTIAL_REJECTED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.credentialRejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["credentialRejected"], reasons: {  } },
  "CONFIG_CREDENTIAL_REQUIRED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.credentialRequired", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["credentialRequired"], reasons: {  } },
  "CONFIG_CREDENTIAL_STORE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.credentialStore", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["credentialStore"], reasons: {  } },
  "CONFIG_ENDPOINT_OVERRIDE_UNSUPPORTED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "CONFIG_FAILED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "CONFIG_INVALID_INPUT": { rpc: "INVALID_PARAMS", messageKey: "appServer.errors.invalidParams", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["invalidParams"], reasons: {  } },
  "CONFIG_INVALID_STATE": { rpc: "INVALID_PARAMS", messageKey: "appServer.errors.invalidParams", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["invalidParams"], reasons: {  } },
  "CONFIG_CHAT_MODEL_REQUIRED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.chatModelRequired", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["chatModelRequired"], reasons: {  } },
  "CONFIG_MODEL_UNAVAILABLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "CONFIG_PERSIST_FAILED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "CONFIG_PROVIDER_UNAVAILABLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "CONFIG_REVISION_CONFLICT": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.conflict", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["conflict"], reasons: {  } },
  "CONFIG_SUBSCRIPTION_AUTH": { rpc: "AUTH_INVALID", messageKey: "appServer.errors.auth", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["auth"], reasons: {  } },
  "CONFIG_SUBSCRIPTION_FAILED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "CONFIG_SUBSCRIPTION_MODEL": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "CONFIG_SUBSCRIPTION_QUOTA": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "CONFIG_SUBSCRIPTION_RATE_LIMIT": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "CONFIG_SUBSCRIPTION_TIMEOUT": { rpc: "REQUEST_TIMEOUT", messageKey: "appServer.errors.timeout", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["timeout"], reasons: {  } },
  "CONFIG_TEST_FAILED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "CONFIG_UNKNOWN_PROVIDER": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "E_SEAM_PIN_CHANGE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.sessionOlder", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["sessionOlder"], reasons: {  } },
  "E_SEAM_PIN_MISMATCH": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.sessionOlder", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["sessionOlder"], reasons: {  } },
  "E_SESSION_CORRUPT": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.sessionCorrupt", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["sessionCorrupt"], reasons: {  } },
  "E_SESSION_VERSION_NEWER": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.sessionNewer", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["sessionNewer"], reasons: {  } },
  "E_SESSION_VERSION_OLDER": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.sessionOlder", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["sessionOlder"], reasons: {  } },
  "E_GENERATION_BINDING_CONFLICT": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.generation", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["generation"], reasons: {  } },
  "E_GENERATION_DISPOSE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.generation", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["generation"], reasons: {  } },
  "E_GENERATION_FACTORY_INCOMPATIBLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.generation", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["generation"], reasons: {  } },
  "E_GENERATION_FACTORY_UNAVAILABLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.generation", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["generation"], reasons: {  } },
  "E_GENERATION_INCOMPATIBLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.generation", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["generation"], reasons: {  } },
  "E_GENERATION_LOOP_INCOMPATIBLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.generation", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["generation"], reasons: {  } },
  "E_GENERATION_MIGRATION_UNAVAILABLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.generation", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["generation"], reasons: {  } },
  "E_GENERATION_PIN_MISSING": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.generation", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["generation"], reasons: {  } },
  "E_GENERATION_RESOURCE_INTEGRITY": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.generation", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["generation"], reasons: {  } },
  "E_GENERATION_RESTART_REQUIRED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.generation", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["generation"], reasons: {  } },
  "E_GENERATION_SESSION_OPEN": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.generation", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["generation"], reasons: {  } },
  "E_GENERATION_SKILLS": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.generation", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["generation"], reasons: {  } },
  "E_GENERATION_TARGET_MISSING": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.generation", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["generation"], reasons: {  } },
  "E_MCP_SANDBOX_UNAVAILABLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "E_PACKAGE_INTEGRITY": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: true, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: { "clean-home-required": PUBLIC_ERROR_COPY["cleanHome"] } },
  "E_PACKAGE_PROVENANCE": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["publication"], reasons: {  } },
  "E_PACKAGE_SOURCE_POLICY": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["publication"], reasons: {  } },
  "E_PROVIDER_DUPLICATE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.provider", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["provider"], reasons: {  } },
  "E_PROVIDER_INCOMPATIBLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.provider", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["provider"], reasons: {  } },
  "E_PROVIDER_INVALID": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.provider", boot: true, skillInstall: false, localized: PUBLIC_ERROR_COPY["provider"], reasons: {  } },
  "E_PROVIDER_UNAVAILABLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.provider", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["provider"], reasons: {  } },
  "E_PROVIDER_UNKNOWN": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.provider", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["provider"], reasons: {  } },
  "E_SANDBOX_WORKSPACE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: { "session-execution-record-invalid": PUBLIC_ERROR_COPY["sessionSandbox"], "workspace-ancestor-not-directory": PUBLIC_ERROR_COPY["unavailable"], "workspace-ancestor-unavailable": PUBLIC_ERROR_COPY["unavailable"] } },
  "MEMORY_APPROVAL_REJECTED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "MEMORY_BUSY": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.busy", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["busy"], reasons: {  } },
  "MEMORY_COMMITTED_METADATA_FAILED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.memoryPartial", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["memoryPartial"], reasons: {  } },
  "MEMORY_CONFLICT": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.conflict", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["conflict"], reasons: {  } },
  "MEMORY_CONSOLIDATION_REQUIRED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.memoryCap", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["memoryCap"], reasons: {  } },
  "MEMORY_DISABLED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.memoryDisabled", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["memoryDisabled"], reasons: {  } },
  "MEMORY_INVALID_METADATA": { rpc: "INVALID_PARAMS", messageKey: "appServer.errors.invalidParams", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["invalidParams"], reasons: {  } },
  "MEMORY_INVALID_REQUEST": { rpc: "INVALID_PARAMS", messageKey: "appServer.errors.invalidParams", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["invalidParams"], reasons: {  } },
  "MEMORY_INVALID_SETTINGS": { rpc: "INVALID_PARAMS", messageKey: "appServer.errors.invalidParams", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["invalidParams"], reasons: {  } },
  "MEMORY_MISSING_TOPIC": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "MEMORY_POLICY_CHANGED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.conflict", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["conflict"], reasons: {  } },
  "MEMORY_PROVIDER_UNAVAILABLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "MEMORY_SCOPE_DENIED": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["forbidden"], reasons: {  } },
  "MEMORY_SECRET_LIKE_CONTENT": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.memorySecret", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["memorySecret"], reasons: {  } },
  "SEARCH_FAILED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SEARCH_INVALID": { rpc: "INVALID_PARAMS", messageKey: "appServer.errors.invalidParams", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["invalidParams"], reasons: {  } },
  "SEARCH_NOT_CONFIGURED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "SEARCH_RATE_LIMITED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SEARCH_ROUTE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SEARCH_TIMEOUT": { rpc: "REQUEST_TIMEOUT", messageKey: "appServer.errors.timeout", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["timeout"], reasons: {  } },
  "E_PRESET_UNSUPPORTED": { rpc: "PRESET_SWITCH_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["preset"], reasons: { "permission-axis": PUBLIC_ERROR_COPY["permissionAxis"], "bundle-unavailable": PUBLIC_ERROR_COPY["unavailable"], "preset-not-allowed": PUBLIC_ERROR_COPY["preset"], "clean-home-required": PUBLIC_ERROR_COPY["cleanHome"] } },
  "E_PRESET_UNRESOLVED": { rpc: "PRESET_SWITCH_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: { "no-routes": PUBLIC_ERROR_COPY["unavailable"], "no-models": PUBLIC_ERROR_COPY["unavailable"], "pin-without-route": PUBLIC_ERROR_COPY["unavailable"], "unknown-slot": PUBLIC_ERROR_COPY["unavailable"], "unknown-route": PUBLIC_ERROR_COPY["unavailable"], "model-undeclared": PUBLIC_ERROR_COPY["unavailable"], "no-primary": PUBLIC_ERROR_COPY["unavailable"], "route-unserved": PUBLIC_ERROR_COPY["unavailable"], "model-unserved": PUBLIC_ERROR_COPY["unavailable"], "route-not-assembled": PUBLIC_ERROR_COPY["unavailable"], "route-duplicate": PUBLIC_ERROR_COPY["unavailable"], "reserved-route-name": PUBLIC_ERROR_COPY["unavailable"], "bedrock-region-conflict": PUBLIC_ERROR_COPY["unavailable"] } },
  "E_MODEL_UNSUPPORTED": { rpc: "PRESET_SWITCH_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["model"], reasons: { "restart-required": PUBLIC_ERROR_COPY["modelRestart"] } },
  "E_MODEL_UNKNOWN": { rpc: "PRESET_SWITCH_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["modelUnknown"], reasons: {  } },
  "E_SEAM_INIT": { rpc: "INTERNAL_ERROR", messageKey: "appServer.errors.internal", boot: true, skillInstall: false, localized: PUBLIC_ERROR_COPY["internal"], reasons: { "provider-unknown": PUBLIC_ERROR_COPY["provider"], "provider-invalid": PUBLIC_ERROR_COPY["provider"], "provider-incompatible": PUBLIC_ERROR_COPY["provider"], "provider-unavailable": PUBLIC_ERROR_COPY["provider"], "provider-duplicate": PUBLIC_ERROR_COPY["provider"] } },
  "E_PERMISSION_REVOKED": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["permissionRevoked"], reasons: {  } },
  "E_PERMISSION_GRANT_UNAVAILABLE": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["permissionGrant"], reasons: {  } },
  "E_BUDGET": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["budget"], reasons: {  } },
  "BUDGET_EXCEEDED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["budget"], reasons: {  } },
  "APPROVAL_REJECTED": { rpc: "APPROVAL_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["approval"], reasons: {  } },
  "APPROVAL_UNAVAILABLE": { rpc: "APPROVAL_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["approval"], reasons: {  } },
  "APPROVAL_STATE_INVALID": { rpc: "APPROVAL_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["approval"], reasons: {  } },
  "APPROVAL_GRANT_UNAVAILABLE": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["permissionGrant"], reasons: {  } },
  "UNATTENDED_APPROVAL_REFUSED": { rpc: "APPROVAL_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["approval"], reasons: {  } },
  "E_FS_DENIED": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["forbidden"], reasons: {  } },
  "E_CAPABILITY_UNDECLARED": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["publication"], reasons: {  } },
  "E_WORKSPACE_UNTRUSTED": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["forbidden"], reasons: {  } },
  "E_LEASE_EXPIRED": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["forbidden"], reasons: {  } },
  "PLUGIN_CANDIDATE_STALE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.conflict", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["conflict"], reasons: {  } },
  "PLUGIN_MANAGEMENT_UNAVAILABLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "PLUGIN_PORT_UNAVAILABLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "PLUGIN_PERMISSION_REQUIRED": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["publication"], reasons: {  } },
  "PLUGIN_LOCAL_OWNER_REQUIRED": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["publication"], reasons: {  } },
  "PLUGIN_TEST_REJECTED": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["pluginTest"], reasons: {  } },
  "PLUGIN_TEST_UNANSWERED": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["pluginTest"], reasons: {  } },
  "PLUGIN_TEST_SANDBOX_REQUIRED": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["pluginTest"], reasons: {  } },
  "PLUGIN_FILES_INVALID": { rpc: "INVALID_PARAMS", messageKey: "appServer.errors.invalidParams", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["invalidParams"], reasons: {  } },
  "E_PACKAGE_UNTRUSTED": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["publication"], reasons: {  } },
  "E_PACKAGE_CAPABILITY": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "E_PACKAGE_MANIFEST": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "E_PACKAGE_API_RANGE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "E_PACKAGE_SOURCE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "E_PACKAGE_TRUST": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["publication"], reasons: {  } },
  "E_PACKAGE_STATE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "E_PACKAGE_BLOCKED": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["publication"], reasons: {  } },
  "E_PACKAGE_PREVIEW_STALE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.conflict", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["conflict"], reasons: {  } },
  "E_PACKAGE_CANCELLED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "E_PACKAGE_BUSY": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.busy", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["busy"], reasons: {  } },
  "SKILL_ATOMIC_PUBLISH_UNAVAILABLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "SKILL_DOCUMENT_INVALID": { rpc: "INVALID_PARAMS", messageKey: "appServer.errors.invalidParams", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["invalidParams"], reasons: {  } },
  "SKILL_FILE_MISSING": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_FILE_REFUSED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_INSTALL_BAD_RECEIPT": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_INSTALL_BUSY": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.busy", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["busy"], reasons: {  } },
  "SKILL_INSTALL_CANCELLED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_INSTALL_CAPABILITY_DENIED": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["forbidden"], reasons: {  } },
  "SKILL_INSTALL_EXPIRED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_INSTALL_FAILED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_INSTALL_INTERRUPTED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_INSTALL_INVALID": { rpc: "INVALID_PARAMS", messageKey: "appServer.errors.invalidParams", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["invalidParams"], reasons: {  } },
  "SKILL_INSTALL_LEASE_CHANGED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_INSTALL_LOCAL_OWNER_REQUIRED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_INSTALL_PERMISSION_INVALID": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["forbidden"], reasons: {  } },
  "SKILL_INSTALL_PERMISSION_TIMEOUT": { rpc: "REQUEST_TIMEOUT", messageKey: "appServer.errors.timeout", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["timeout"], reasons: {  } },
  "SKILL_INSTALL_PERMISSION_UNAVAILABLE": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["forbidden"], reasons: {  } },
  "SKILL_INSTALL_REJECTED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_INSTALL_SESSION_CLOSED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_LINK_REFUSED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_NAME_INVALID": { rpc: "INVALID_PARAMS", messageKey: "appServer.errors.invalidParams", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["invalidParams"], reasons: {  } },
  "SKILL_NOT_READY": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_PATH_DENIED": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["forbidden"], reasons: {  } },
  "SKILL_PATH_INVALID": { rpc: "INVALID_PARAMS", messageKey: "appServer.errors.invalidParams", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["invalidParams"], reasons: {  } },
  "SKILL_PROPOSAL_TERMINAL": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_PROPOSAL_UNAVAILABLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "SKILL_READ_REJECTED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_RECEIPT_DIRECTORY_UNSAFE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_RESOURCE_CHANGED_OR_SHADOWED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_RESOURCE_OPERATION_FAILED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_RESOURCE_OPERATION_PENDING": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_SIZE_LIMIT": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_SOURCE_CHANGED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_SOURCE_NOT_DIRECTORY": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_SOURCE_TARGET_OVERLAP": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "SKILL_STAGE_INVALID": { rpc: "INVALID_PARAMS", messageKey: "appServer.errors.invalidParams", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["invalidParams"], reasons: {  } },
  "SKILL_TARGET_BUSY": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.busy", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["busy"], reasons: {  } },
  "SKILL_TARGET_CONFLICT": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: true, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "OVERLOADED": { rpc: "OVERLOADED", messageKey: "appServer.errors.busy", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["busy"], reasons: {  } },
  "SESSION_BUSY": { rpc: "SESSION_BUSY", messageKey: "appServer.errors.busy", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["busy"], reasons: {  } },
  "SESSION_NOT_FOUND": { rpc: "SESSION_NOT_FOUND", messageKey: "appServer.errors.notFound", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["notFound"], reasons: {  } },
  "GENERATION_STALE": { rpc: "GENERATION_STALE", messageKey: "appServer.errors.conflict", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["conflict"], reasons: {  } },
  "CURSOR_OUT_OF_RANGE": { rpc: "CURSOR_OUT_OF_RANGE", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "CAPABILITY_DENIED": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["forbidden"], reasons: {  } },
  "AUTH_INVALID": { rpc: "AUTH_INVALID", messageKey: "appServer.errors.auth", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["auth"], reasons: {  } },
  "PRESET_SWITCH_REJECTED": { rpc: "PRESET_SWITCH_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["preset"], reasons: {  } },
  "CLAIM_DENIED": { rpc: "CLAIM_DENIED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["forbidden"], reasons: {  } },
  "SEMANTIC_REJECTED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: { "fork boundary must be a completed turn/end": PUBLIC_ERROR_COPY["forkBoundary"] } },
  "REQUEST_TIMEOUT": { rpc: "REQUEST_TIMEOUT", messageKey: "appServer.errors.timeout", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["timeout"], reasons: {  } },
  "OUTCOME_UNKNOWN": { rpc: "OUTCOME_UNKNOWN", messageKey: "appServer.errors.internal", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["internal"], reasons: {  } },
  "PARSE_ERROR": { rpc: "PARSE_ERROR", messageKey: "appServer.errors.invalidRequest", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["invalidRequest"], reasons: {  } },
  "INVALID_REQUEST": { rpc: "INVALID_REQUEST", messageKey: "appServer.errors.invalidRequest", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["invalidRequest"], reasons: {  } },
  "METHOD_NOT_FOUND": { rpc: "METHOD_NOT_FOUND", messageKey: "appServer.errors.methodNotFound", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["methodNotFound"], reasons: {  } },
  "INVALID_PARAMS": { rpc: "INVALID_PARAMS", messageKey: "appServer.errors.invalidParams", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["invalidParams"], reasons: {  } },
  "INTERNAL_ERROR": { rpc: "INTERNAL_ERROR", messageKey: "appServer.errors.internal", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["internal"], reasons: {  } },
  "E_RELATION": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: { "authority-revoked": PUBLIC_ERROR_COPY["permissionRevoked"], "not-consumable": PUBLIC_ERROR_COPY["permissionGrant"], "human-required": PUBLIC_ERROR_COPY["approval"], "clean-home-required": PUBLIC_ERROR_COPY["cleanHome"] } },
  "E_CAS": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.conflict", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["conflict"], reasons: {  } },
  "AUTH": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.auth", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["providerAuth"], reasons: {  } },
  "RATE_LIMIT": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.busy", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rateLimit"], reasons: {  } },
  "OUTPUT_LIMIT": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["outputLimit"], reasons: {  } },
  "PLUGIN_LEGACY_PROPOSAL_REVIEW_REQUIRED": { rpc: "CAPABILITY_DENIED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["pluginReview"], reasons: {  } },
  "PLUGIN_REJECT_IN_REVIEW_UI": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["pluginReview"], reasons: {  } },
  "PLUGIN_PUBLICATION_UNANSWERED": { rpc: "APPROVAL_REJECTED", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["pluginReview"], reasons: {  } },
  "PLUGIN_REQUEST_LIMIT": { rpc: "OVERLOADED", messageKey: "appServer.errors.busy", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["busy"], reasons: {  } },
  "HELPER_MANAGEMENT_FAILED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "QUOTA": { rpc: "INTERNAL_ERROR", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["budget"], reasons: {  } },
  "OVERFLOW": { rpc: "INTERNAL_ERROR", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["budget"], reasons: {  } },
  "TIMEOUT": { rpc: "INTERNAL_ERROR", messageKey: "appServer.errors.timeout", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["timeout"], reasons: {  } },
  "NO_MODEL": { rpc: "INTERNAL_ERROR", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "NO_ADAPTER": { rpc: "INTERNAL_ERROR", messageKey: "appServer.errors.provider", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["provider"], reasons: {  } },
  "FORMAT": { rpc: "INTERNAL_ERROR", messageKey: "appServer.errors.provider", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["provider"], reasons: {  } },
  "TRANSPORT": { rpc: "INTERNAL_ERROR", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["transport"], reasons: {  } },
  "CONTRACT_MISMATCH": { rpc: "INTERNAL_ERROR", messageKey: "appServer.errors.provider", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["provider"], reasons: {  } },
  "ABORTED": { rpc: "INTERNAL_ERROR", messageKey: "appServer.errors.rejected", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["rejected"], reasons: {  } },
  "E_PROFILE_FRAGMENT_KEY": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.invalidParams", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["invalidParams"], reasons: {  } },
  "E_PROFILE_CYCLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.invalidParams", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["invalidParams"], reasons: {  } },
  "E_PACKAGE_DUPLICATE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "E_PACKAGE_QUARANTINED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "E_DEP_MISSING": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: true, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "E_SEAM_MISSING": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: true, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "E_CEILING_EXCEEDED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "E_SEAM_IMMUTABLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "E_STATIC_COMPONENT": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "E_LOCK_MISMATCH": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: true, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "E_WORKSPACE_REQUIRED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "E_WORKSPACE_CLOSED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "E_REMOTE_WORKSPACE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "E_MANAGED_POLICY_CORRUPT": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "E_SECRET_UNRESOLVED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: true, skillInstall: false, localized: PUBLIC_ERROR_COPY["credentialRequired"], reasons: {  } },
  "E_API_RANGE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: true, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "E_SEAM_EXPORT_MISSING": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: true, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "E_EXT_LOAD": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: true, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "E_EXT_ISOLATION_UNAVAILABLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "E_HOST_CLOSED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "E_GENERATION_EXECUTION_UNSETTLED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "E_HOME_INVALID": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.invalidParams", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["invalidParams"], reasons: { "clean-home-required": PUBLIC_ERROR_COPY["cleanHome"] } },
  "E_WRITER_LEASE": { rpc: "INTERNAL_ERROR", messageKey: "appServer.errors.internal", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["internal"], reasons: {  } },
  "E_STORAGE_FAULT": { rpc: "INTERNAL_ERROR", messageKey: "appServer.errors.internal", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["internal"], reasons: {  } },
  "E_LEDGER_INTEGRITY": { rpc: "INTERNAL_ERROR", messageKey: "appServer.errors.internal", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["internal"], reasons: {  } },
  "BUNDLE_UNAVAILABLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["bundleUnavailable"], reasons: {  } },
  "PROVIDER_UNCONFIGURED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["providerUnconfigured"], reasons: {  } },
  "LOOP_MISSING": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["loopMissing"], reasons: {  } },
  "SANDBOX_UNAVAILABLE": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["sandboxUnavailable"], reasons: {  } },
  "E_RESOURCE_UNSUPPORTED": { rpc: "INTERNAL_ERROR", messageKey: "appServer.errors.unavailable", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["unavailable"], reasons: {  } },
  "REVISION_CONFLICT": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.conflict", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["conflict"], reasons: {  } },
  "WORKSPACE_PATH_DENIED": { rpc: "SEMANTIC_REJECTED", messageKey: "appServer.errors.forbidden", boot: false, skillInstall: false, localized: PUBLIC_ERROR_COPY["forbidden"], reasons: {  } },
} as const
export const PUBLIC_ERROR_MESSAGES = {
  "appServer.errors.internal": PUBLIC_ERROR_COPY["internal"],
  "appServer.errors.invalidRequest": PUBLIC_ERROR_COPY["invalidRequest"],
  "appServer.errors.invalidParams": PUBLIC_ERROR_COPY["invalidParams"],
  "appServer.errors.methodNotFound": PUBLIC_ERROR_COPY["methodNotFound"],
  "appServer.errors.forbidden": PUBLIC_ERROR_COPY["forbidden"],
  "appServer.errors.auth": PUBLIC_ERROR_COPY["auth"],
  "appServer.errors.busy": PUBLIC_ERROR_COPY["busy"],
  "appServer.errors.notFound": PUBLIC_ERROR_COPY["notFound"],
  "appServer.errors.conflict": PUBLIC_ERROR_COPY["conflict"],
  "appServer.errors.timeout": PUBLIC_ERROR_COPY["timeout"],
  "appServer.errors.unavailable": PUBLIC_ERROR_COPY["unavailable"],
  "appServer.errors.chatModelRequired": PUBLIC_ERROR_COPY["chatModelRequired"],
  "appServer.errors.credentialRequired": PUBLIC_ERROR_COPY["credentialRequired"],
  "appServer.errors.credentialRejected": PUBLIC_ERROR_COPY["credentialRejected"],
  "appServer.errors.credentialStore": PUBLIC_ERROR_COPY["credentialStore"],
  "appServer.errors.provider": PUBLIC_ERROR_COPY["provider"],
  "appServer.errors.generation": PUBLIC_ERROR_COPY["generation"],
  "appServer.errors.sessionNewer": PUBLIC_ERROR_COPY["sessionNewer"],
  "appServer.errors.sessionOlder": PUBLIC_ERROR_COPY["sessionOlder"],
  "appServer.errors.sessionCorrupt": PUBLIC_ERROR_COPY["sessionCorrupt"],
  "appServer.errors.sessionSandbox": PUBLIC_ERROR_COPY["sessionSandbox"],
  "appServer.errors.rejected": PUBLIC_ERROR_COPY["rejected"],
  "appServer.errors.memoryCap": PUBLIC_ERROR_COPY["memoryCap"],
  "appServer.errors.memorySecret": PUBLIC_ERROR_COPY["memorySecret"],
  "appServer.errors.memoryDisabled": PUBLIC_ERROR_COPY["memoryDisabled"],
  "appServer.errors.memoryPartial": PUBLIC_ERROR_COPY["memoryPartial"],
} as const
