// generated from schema/runtime by tools/gen-runtime.ts — do not edit
export const RuntimeServiceCatalog = {
  "agh.loop": {
    "major": 1,
    "methods": {
      "start": {
        "kind": "compute",
        "input": "RunFrame",
        "output": "LoopTransition",
        "inputTypeId": "agh.loop/start.request@1",
        "outputTypeId": "agh.loop/start.response@1"
      },
      "resume": {
        "kind": "compute",
        "input": "RunFrame",
        "output": "LoopTransition",
        "inputTypeId": "agh.loop/resume.request@1",
        "outputTypeId": "agh.loop/resume.response@1"
      }
    }
  },
  "agh.context": {
    "major": 1,
    "methods": {
      "view": {
        "kind": "query",
        "input": "ContextViewRequest",
        "output": "ContextView",
        "inputTypeId": "agh.context/view.request@1",
        "outputTypeId": "agh.context/view.response@1"
      },
      "prepareView": {
        "kind": "action",
        "input": "ContextPrepareViewRequest",
        "output": "ContextView",
        "inputTypeId": "agh.context/prepareView.request@1",
        "outputTypeId": "agh.context/prepareView.response@1"
      },
      "refresh": {
        "kind": "action",
        "input": "ContextRefreshRequest",
        "output": "ContextRefreshResult",
        "inputTypeId": "agh.context/refresh.request@1",
        "outputTypeId": "agh.context/refresh.response@1"
      }
    }
  },
  "agh.compaction": {
    "major": 1,
    "methods": {
      "plan": {
        "kind": "compute",
        "input": "CompactionPlanRequest",
        "output": "CompactionPlan",
        "inputTypeId": "agh.compaction/plan.request@1",
        "outputTypeId": "agh.compaction/plan.response@1"
      },
      "preparePlan": {
        "kind": "action",
        "input": "CompactionPreparePlanRequest",
        "output": "CompactionPlan",
        "inputTypeId": "agh.compaction/preparePlan.request@1",
        "outputTypeId": "agh.compaction/preparePlan.response@1"
      },
      "execute": {
        "kind": "action",
        "input": "CompactionExecuteRequest",
        "output": "CompactionResult",
        "inputTypeId": "agh.compaction/execute.request@1",
        "outputTypeId": "agh.compaction/execute.response@1"
      },
      "apply": {
        "kind": "action",
        "input": "CompactionApplyRequest",
        "output": "CompactionApplyResult",
        "inputTypeId": "agh.compaction/apply.request@1",
        "outputTypeId": "agh.compaction/apply.response@1"
      },
      "expand": {
        "kind": "query",
        "input": "CompactionExpandRequest",
        "output": "CompactionExpandResult",
        "inputTypeId": "agh.compaction/expand.request@1",
        "outputTypeId": "agh.compaction/expand.response@1"
      }
    }
  },
  "agh.model": {
    "major": 1,
    "methods": {
      "prepare": {
        "kind": "compute",
        "input": "ModelPrepareRequest",
        "output": "ModelPrepareResult",
        "inputTypeId": "agh.model/prepare.request@1",
        "outputTypeId": "agh.model/prepare.response@1"
      },
      "prepareRequest": {
        "kind": "action",
        "input": "ModelPrepareRequestRequest",
        "output": "ModelPrepareRequestResult",
        "inputTypeId": "agh.model/prepareRequest.request@1",
        "outputTypeId": "agh.model/prepareRequest.response@1"
      },
      "infer": {
        "kind": "action",
        "input": "ModelInferRequest",
        "output": "ModelOutput",
        "inputTypeId": "agh.model/infer.request@1",
        "outputTypeId": "agh.model/infer.response@1"
      }
    }
  },
  "agh.routing": {
    "major": 1,
    "methods": {
      "select": {
        "kind": "compute",
        "input": "RoutingSelectInput",
        "output": "RoutingSelectResult",
        "inputTypeId": "agh.routing/select.request@1",
        "outputTypeId": "agh.routing/select.response@1"
      }
    }
  },
  "agh.media": {
    "major": 1,
    "methods": {
      "prepare": {
        "kind": "action",
        "input": "MediaPlan",
        "output": "PreparedMedia",
        "inputTypeId": "agh.media/prepare.request@1",
        "outputTypeId": "agh.media/prepare.response@1"
      }
    }
  },
  "agh.model-adapter": {
    "major": 1,
    "methods": {
      "invoke": {
        "kind": "action",
        "input": "ModelAdapterInvokeRequest",
        "output": "ModelOutput",
        "inputTypeId": "agh.model-adapter/invoke.request@1",
        "outputTypeId": "agh.model-adapter/invoke.response@1"
      },
      "reconcile": {
        "kind": "action",
        "input": "ModelAdapterReconcileRequest",
        "output": "ReconcileResult",
        "inputTypeId": "agh.model-adapter/reconcile.request@1",
        "outputTypeId": "agh.model-adapter/reconcile.response@1"
      }
    }
  },
  "agh.resources": {
    "major": 1,
    "methods": {
      "list": {
        "kind": "query",
        "input": "ResourcesListRequest",
        "output": "ResourcesListResult",
        "inputTypeId": "agh.resources/list.request@1",
        "outputTypeId": "agh.resources/list.response@1"
      },
      "describe": {
        "kind": "query",
        "input": "ResourcesDescribeRequest",
        "output": "ResourceDescriptor",
        "inputTypeId": "agh.resources/describe.request@1",
        "outputTypeId": "agh.resources/describe.response@1"
      },
      "register": {
        "kind": "maintenance",
        "input": "ResourcesRegisterRequest",
        "output": "ResourcesRegisterResult",
        "inputTypeId": "agh.resources/register.request@1",
        "outputTypeId": "agh.resources/register.response@1"
      },
      "remove": {
        "kind": "maintenance",
        "input": "ResourcesRemoveRequest",
        "output": "ResourcesRemoveResult",
        "inputTypeId": "agh.resources/remove.request@1",
        "outputTypeId": "agh.resources/remove.response@1"
      },
      "retain": {
        "kind": "action",
        "input": "ResourcesRetainRequest",
        "output": "RetentionRef",
        "inputTypeId": "agh.resources/retain.request@1",
        "outputTypeId": "agh.resources/retain.response@1"
      },
      "release": {
        "kind": "action",
        "input": "ResourcesReleaseRequest",
        "output": "ResourcesReleaseResult",
        "inputTypeId": "agh.resources/release.request@1",
        "outputTypeId": "agh.resources/release.response@1"
      }
    }
  },
  "agh.mcp": {
    "major": 1,
    "methods": {
      "connect": {
        "kind": "action",
        "input": "McpConnectRequest",
        "output": "McpConnectResult",
        "inputTypeId": "agh.mcp/connect.request@1",
        "outputTypeId": "agh.mcp/connect.response@1"
      },
      "prepareConnection": {
        "kind": "action",
        "input": "McpConnectionPreparation",
        "output": "McpConnectRequest",
        "inputTypeId": "agh.mcp/prepareConnection.request@1",
        "outputTypeId": "agh.mcp/prepareConnection.response@1"
      },
      "call": {
        "kind": "action",
        "input": "McpCallRequest",
        "output": "McpCallResult",
        "inputTypeId": "agh.mcp/call.request@1",
        "outputTypeId": "agh.mcp/call.response@1"
      },
      "read": {
        "kind": "action",
        "input": "McpReadRequest",
        "output": "McpReadResult",
        "inputTypeId": "agh.mcp/read.request@1",
        "outputTypeId": "agh.mcp/read.response@1"
      }
    }
  },
  "agh.tools": {
    "major": 1,
    "methods": {
      "describe": {
        "kind": "query",
        "input": "ToolsDescribeRequest",
        "output": "ToolDefinition",
        "inputTypeId": "agh.tools/describe.request@1",
        "outputTypeId": "agh.tools/describe.response@1"
      },
      "inspect": {
        "kind": "query",
        "input": "ToolsInspectRequest",
        "output": "ToolsInspectResult",
        "inputTypeId": "agh.tools/inspect.request@1",
        "outputTypeId": "agh.tools/inspect.response@1"
      },
      "classify": {
        "kind": "compute",
        "input": "ToolsClassifyRequest",
        "output": "ToolPolicySnapshot",
        "inputTypeId": "agh.tools/classify.request@1",
        "outputTypeId": "agh.tools/classify.response@1"
      },
      "catalog": {
        "kind": "compute",
        "input": "ToolsCatalogRequest",
        "output": "ToolCatalog",
        "inputTypeId": "agh.tools/catalog.request@1",
        "outputTypeId": "agh.tools/catalog.response@1"
      },
      "updatePlan": {
        "kind": "action",
        "input": "ToolPlanUpdate",
        "output": "ToolsUpdatePlanResult",
        "inputTypeId": "agh.tools/updatePlan.request@1",
        "outputTypeId": "agh.tools/updatePlan.response@1"
      },
      "requestCompaction": {
        "kind": "action",
        "input": "ToolsRequestCompactionRequest",
        "output": "ToolsRequestCompactionResult",
        "inputTypeId": "agh.tools/requestCompaction.request@1",
        "outputTypeId": "agh.tools/requestCompaction.response@1"
      },
      "invoke": {
        "kind": "action",
        "input": "ToolCall",
        "output": "ToolResult",
        "inputTypeId": "agh.tools/invoke.request@1",
        "outputTypeId": "agh.tools/invoke.response@1"
      },
      "cancel": {
        "kind": "action",
        "input": "ToolsCancelRequest",
        "output": "ToolsCancelResult",
        "inputTypeId": "agh.tools/cancel.request@1",
        "outputTypeId": "agh.tools/cancel.response@1"
      },
      "reconcile": {
        "kind": "action",
        "input": "ToolsReconcileRequest",
        "output": "ReconcileResult",
        "inputTypeId": "agh.tools/reconcile.request@1",
        "outputTypeId": "agh.tools/reconcile.response@1"
      }
    }
  },
  "agh.memory": {
    "major": 1,
    "methods": {
      "remember": {
        "kind": "action",
        "input": "MemoryRememberRequest",
        "output": "MemoryRememberResult",
        "inputTypeId": "agh.memory/remember.request@1",
        "outputTypeId": "agh.memory/remember.response@1"
      },
      "forget": {
        "kind": "action",
        "input": "MemoryForgetRequest",
        "output": "MemoryForgetResult",
        "inputTypeId": "agh.memory/forget.request@1",
        "outputTypeId": "agh.memory/forget.response@1"
      },
      "get": {
        "kind": "query",
        "input": "MemoryGetRequest",
        "output": "MemoryGetResult",
        "inputTypeId": "agh.memory/get.request@1",
        "outputTypeId": "agh.memory/get.response@1"
      }
    }
  },
  "agh.retrieval": {
    "major": 1,
    "methods": {
      "search": {
        "kind": "query",
        "input": "RetrievalSearchRequest",
        "output": "RetrievalSearchResult",
        "inputTypeId": "agh.retrieval/search.request@1",
        "outputTypeId": "agh.retrieval/search.response@1"
      },
      "searchRemote": {
        "kind": "action",
        "input": "RetrievalSearchRemoteRequest",
        "output": "RetrievalSearchRemoteResult",
        "inputTypeId": "agh.retrieval/searchRemote.request@1",
        "outputTypeId": "agh.retrieval/searchRemote.response@1"
      }
    }
  },
  "agh.embedding": {
    "major": 1,
    "methods": {
      "encode": {
        "kind": "action",
        "input": "EmbeddingEncodeRequest",
        "output": "EmbeddingEncodeResult",
        "inputTypeId": "agh.embedding/encode.request@1",
        "outputTypeId": "agh.embedding/encode.response@1"
      }
    }
  },
  "agh.identity": {
    "major": 1,
    "methods": {
      "authenticate": {
        "kind": "ingress",
        "input": "IdentityAuthenticateRequest",
        "output": "AuthenticatedIdentity",
        "inputTypeId": "agh.identity/authenticate.request@1",
        "outputTypeId": "agh.identity/authenticate.response@1"
      },
      "resolve": {
        "kind": "query",
        "input": "IdentityResolveRequest",
        "output": "AuthenticatedIdentity",
        "inputTypeId": "agh.identity/resolve.request@1",
        "outputTypeId": "agh.identity/resolve.response@1"
      }
    }
  },
  "agh.policy": {
    "major": 1,
    "methods": {
      "evaluate": {
        "kind": "compute",
        "input": "PolicyEvaluateRequest",
        "output": "PolicyDecision",
        "inputTypeId": "agh.policy/evaluate.request@1",
        "outputTypeId": "agh.policy/evaluate.response@1"
      }
    }
  },
  "agh.effects": {
    "major": 1,
    "methods": {
      "runHooks": {
        "kind": "action",
        "input": "HookStageRequest",
        "output": "HookResultSet",
        "inputTypeId": "agh.effects/runHooks.request@1",
        "outputTypeId": "agh.effects/runHooks.response@1"
      },
      "dispatch": {
        "kind": "control",
        "input": "EffectsDispatchRequest",
        "output": "EffectsDispatchResult",
        "inputTypeId": "agh.effects/dispatch.request@1",
        "outputTypeId": "agh.effects/dispatch.response@1"
      },
      "reconcile": {
        "kind": "control",
        "input": "EffectsReconcileRequest",
        "output": "EffectsReconcileResult",
        "inputTypeId": "agh.effects/reconcile.request@1",
        "outputTypeId": "agh.effects/reconcile.response@1"
      }
    }
  },
  "agh.workspace": {
    "major": 1,
    "methods": {
      "acquire": {
        "kind": "action",
        "input": "WorkspaceAcquireRequest",
        "output": "WorkspaceAcquireResult",
        "inputTypeId": "agh.workspace/acquire.request@1",
        "outputTypeId": "agh.workspace/acquire.response@1"
      },
      "release": {
        "kind": "action",
        "input": "WorkspaceReleaseRequest",
        "output": "WorkspaceReleaseResult",
        "inputTypeId": "agh.workspace/release.request@1",
        "outputTypeId": "agh.workspace/release.response@1"
      }
    }
  },
  "agh.files": {
    "major": 1,
    "methods": {
      "read": {
        "kind": "action",
        "input": "FilesReadRequest",
        "output": "FilesReadResult",
        "inputTypeId": "agh.files/read.request@1",
        "outputTypeId": "agh.files/read.response@1"
      },
      "write": {
        "kind": "action",
        "input": "FilesWriteRequest",
        "output": "FilesWriteResult",
        "inputTypeId": "agh.files/write.request@1",
        "outputTypeId": "agh.files/write.response@1"
      },
      "list": {
        "kind": "action",
        "input": "FilesListRequest",
        "output": "FilesListResult",
        "inputTypeId": "agh.files/list.request@1",
        "outputTypeId": "agh.files/list.response@1"
      },
      "stat": {
        "kind": "action",
        "input": "FilesStatRequest",
        "output": "FileStat",
        "inputTypeId": "agh.files/stat.request@1",
        "outputTypeId": "agh.files/stat.response@1"
      },
      "verifyPolicy": {
        "kind": "control",
        "input": "FsPolicySnapshot",
        "output": "FsEnforcementProof",
        "inputTypeId": "agh.files/verifyPolicy.request@1",
        "outputTypeId": "agh.files/verifyPolicy.response@1"
      }
    }
  },
  "agh.sandbox": {
    "major": 1,
    "methods": {
      "create": {
        "kind": "action",
        "input": "SandboxCreateRequest",
        "output": "SandboxCreateResult",
        "inputTypeId": "agh.sandbox/create.request@1",
        "outputTypeId": "agh.sandbox/create.response@1"
      },
      "stop": {
        "kind": "action",
        "input": "SandboxStopRequest",
        "output": "SandboxStopResult",
        "inputTypeId": "agh.sandbox/stop.request@1",
        "outputTypeId": "agh.sandbox/stop.response@1"
      },
      "inspect": {
        "kind": "action",
        "input": "SandboxInspectRequest",
        "output": "SandboxInspectResult",
        "inputTypeId": "agh.sandbox/inspect.request@1",
        "outputTypeId": "agh.sandbox/inspect.response@1"
      }
    }
  },
  "agh.exec": {
    "major": 1,
    "methods": {
      "run": {
        "kind": "action",
        "input": "ExecRequest",
        "output": "ExecResult",
        "inputTypeId": "agh.exec/run.request@1",
        "outputTypeId": "agh.exec/run.response@1"
      },
      "reconcile": {
        "kind": "action",
        "input": "ExecReconcileRequest",
        "output": "ReconcileResult",
        "inputTypeId": "agh.exec/reconcile.request@1",
        "outputTypeId": "agh.exec/reconcile.response@1"
      }
    }
  },
  "agh.network": {
    "major": 1,
    "methods": {
      "request": {
        "kind": "action",
        "input": "NetworkRequest",
        "output": "NetworkRequestResult",
        "inputTypeId": "agh.network/request.request@1",
        "outputTypeId": "agh.network/request.response@1"
      }
    }
  },
  "agh.secrets": {
    "major": 1,
    "methods": {
      "resolve": {
        "kind": "query",
        "input": "SecretsResolveRequest",
        "output": "SecretHandle",
        "inputTypeId": "agh.secrets/resolve.request@1",
        "outputTypeId": "agh.secrets/resolve.response@1"
      },
      "rotate": {
        "kind": "maintenance",
        "input": "SecretsRotateRequest",
        "output": "SecretsRotateResult",
        "inputTypeId": "agh.secrets/rotate.request@1",
        "outputTypeId": "agh.secrets/rotate.response@1"
      },
      "revoke": {
        "kind": "maintenance",
        "input": "SecretsRevokeRequest",
        "output": "SecretsRevokeResult",
        "inputTypeId": "agh.secrets/revoke.request@1",
        "outputTypeId": "agh.secrets/revoke.response@1"
      },
      "refresh": {
        "kind": "action",
        "input": "CredentialRefreshRequest",
        "output": "CredentialRefreshResult",
        "inputTypeId": "agh.secrets/refresh.request@1",
        "outputTypeId": "agh.secrets/refresh.response@1"
      },
      "exchange": {
        "kind": "action",
        "input": "CredentialExchangeRequest",
        "output": "CredentialRefreshResult",
        "inputTypeId": "agh.secrets/exchange.request@1",
        "outputTypeId": "agh.secrets/exchange.response@1"
      },
      "acceptCallback": {
        "kind": "ingress",
        "input": "CredentialCallbackRequest",
        "output": "SecretsAcceptCallbackResult",
        "inputTypeId": "agh.secrets/acceptCallback.request@1",
        "outputTypeId": "agh.secrets/acceptCallback.response@1"
      }
    }
  },
  "agh.interaction": {
    "major": 1,
    "methods": {
      "request": {
        "kind": "action",
        "input": "InteractionRequest",
        "output": "InteractionRecord",
        "inputTypeId": "agh.interaction/request.request@1",
        "outputTypeId": "agh.interaction/request.response@1"
      },
      "respond": {
        "kind": "action",
        "input": "InteractionRespondRequest",
        "output": "InteractionResponseStatus",
        "inputTypeId": "agh.interaction/respond.request@1",
        "outputTypeId": "agh.interaction/respond.response@1"
      },
      "expire": {
        "kind": "action",
        "input": "InteractionExpireRequest",
        "output": "InteractionRecord",
        "inputTypeId": "agh.interaction/expire.request@1",
        "outputTypeId": "agh.interaction/expire.response@1"
      },
      "cancel": {
        "kind": "action",
        "input": "InteractionCancelRequest",
        "output": "InteractionRecord",
        "inputTypeId": "agh.interaction/cancel.request@1",
        "outputTypeId": "agh.interaction/cancel.response@1"
      },
      "read": {
        "kind": "query",
        "input": "Id",
        "output": "InteractionRecord",
        "inputTypeId": "agh.interaction/read.request@1",
        "outputTypeId": "agh.interaction/read.response@1"
      }
    }
  },
  "agh.recovery": {
    "major": 1,
    "methods": {
      "inspect": {
        "kind": "maintenance",
        "input": "RecoveryInspectRequest",
        "output": "RecoveryInspectResult",
        "inputTypeId": "agh.recovery/inspect.request@1",
        "outputTypeId": "agh.recovery/inspect.response@1"
      },
      "restore": {
        "kind": "maintenance",
        "input": "RecoveryRestoreRequest",
        "output": "RecoveryRestoreResult",
        "inputTypeId": "agh.recovery/restore.request@1",
        "outputTypeId": "agh.recovery/restore.response@1"
      }
    }
  },
  "agh.supervisor": {
    "major": 1,
    "methods": {
      "admit": {
        "kind": "control",
        "input": "NewRunSpec",
        "output": "SupervisorAdmitResult",
        "inputTypeId": "agh.supervisor/admit.request@1",
        "outputTypeId": "agh.supervisor/admit.response@1"
      },
      "admitServiceCommand": {
        "kind": "control",
        "input": "ServiceCommandAdmission",
        "output": "ServiceCommandRecord",
        "inputTypeId": "agh.supervisor/admitServiceCommand.request@1",
        "outputTypeId": "agh.supervisor/admitServiceCommand.response@1"
      },
      "signal": {
        "kind": "control",
        "input": "SupervisorSignalRequest",
        "output": "SupervisorSignalResult",
        "inputTypeId": "agh.supervisor/signal.request@1",
        "outputTypeId": "agh.supervisor/signal.response@1"
      },
      "cancel": {
        "kind": "control",
        "input": "SupervisorCancelRequest",
        "output": "SupervisorCancelResult",
        "inputTypeId": "agh.supervisor/cancel.request@1",
        "outputTypeId": "agh.supervisor/cancel.response@1"
      },
      "sessionParameters": {
        "kind": "query",
        "input": "SupervisorSessionParametersRequest",
        "output": "SupervisorSessionParametersResult",
        "inputTypeId": "agh.supervisor/sessionParameters.request@1",
        "outputTypeId": "agh.supervisor/sessionParameters.response@1"
      },
      "inspect": {
        "kind": "query",
        "input": "SupervisorInspectRequest",
        "output": "SupervisorInspectResult",
        "inputTypeId": "agh.supervisor/inspect.request@1",
        "outputTypeId": "agh.supervisor/inspect.response@1"
      },
      "serviceCommandStatus": {
        "kind": "query",
        "input": "StateStoreControlReadServiceCommandRequest",
        "output": "SupervisorServiceCommandStatusResult",
        "inputTypeId": "agh.supervisor/serviceCommandStatus.request@1",
        "outputTypeId": "agh.supervisor/serviceCommandStatus.response@1"
      },
      "actionReceipt": {
        "kind": "query",
        "input": "SupervisorActionReceiptRequest",
        "output": "SupervisorActionReceiptResult",
        "inputTypeId": "agh.supervisor/actionReceipt.request@1",
        "outputTypeId": "agh.supervisor/actionReceipt.response@1"
      }
    }
  },
  "agh.scheduler": {
    "major": 1,
    "methods": {
      "enqueue": {
        "kind": "control",
        "input": "SchedulerEnqueueRequest",
        "output": "SchedulerEnqueueResult",
        "inputTypeId": "agh.scheduler/enqueue.request@1",
        "outputTypeId": "agh.scheduler/enqueue.response@1"
      },
      "claim": {
        "kind": "control",
        "input": "SchedulerClaimRequest",
        "output": "SchedulerClaimResult",
        "inputTypeId": "agh.scheduler/claim.request@1",
        "outputTypeId": "agh.scheduler/claim.response@1"
      },
      "ack": {
        "kind": "control",
        "input": "SchedulerAckRequest",
        "output": "SchedulerAckResult",
        "inputTypeId": "agh.scheduler/ack.request@1",
        "outputTypeId": "agh.scheduler/ack.response@1"
      }
    }
  },
  "agh.agents": {
    "major": 1,
    "methods": {
      "spawn": {
        "kind": "action",
        "input": "AgentSpawnRequest",
        "output": "AgentsSpawnResult",
        "inputTypeId": "agh.agents/spawn.request@1",
        "outputTypeId": "agh.agents/spawn.response@1"
      },
      "send": {
        "kind": "action",
        "input": "AgentsSendRequest",
        "output": "AgentsSendResult",
        "inputTypeId": "agh.agents/send.request@1",
        "outputTypeId": "agh.agents/send.response@1"
      },
      "resume": {
        "kind": "action",
        "input": "AgentsResumeRequest",
        "output": "AgentsResumeResult",
        "inputTypeId": "agh.agents/resume.request@1",
        "outputTypeId": "agh.agents/resume.response@1"
      },
      "cancel": {
        "kind": "action",
        "input": "AgentsCancelRequest",
        "output": "AgentsCancelResult",
        "inputTypeId": "agh.agents/cancel.request@1",
        "outputTypeId": "agh.agents/cancel.response@1"
      },
      "retire": {
        "kind": "action",
        "input": "AgentsRetireRequest",
        "output": "AgentsRetireResult",
        "inputTypeId": "agh.agents/retire.request@1",
        "outputTypeId": "agh.agents/retire.response@1"
      },
      "inspect": {
        "kind": "query",
        "input": "AgentsInspectRequest",
        "output": "AgentSnapshot",
        "inputTypeId": "agh.agents/inspect.request@1",
        "outputTypeId": "agh.agents/inspect.response@1"
      }
    }
  },
  "agh.jobs": {
    "major": 1,
    "methods": {
      "requestCreate": {
        "kind": "action",
        "input": "JobsRequestCreateRequest",
        "output": "JobDefinition",
        "inputTypeId": "agh.jobs/requestCreate.request@1",
        "outputTypeId": "agh.jobs/requestCreate.response@1"
      },
      "requestUpdate": {
        "kind": "action",
        "input": "JobsRequestUpdateRequest",
        "output": "JobDefinition",
        "inputTypeId": "agh.jobs/requestUpdate.request@1",
        "outputTypeId": "agh.jobs/requestUpdate.response@1"
      },
      "requestCancel": {
        "kind": "action",
        "input": "JobsRequestCancelRequest",
        "output": "JobsRequestCancelResult",
        "inputTypeId": "agh.jobs/requestCancel.request@1",
        "outputTypeId": "agh.jobs/requestCancel.response@1"
      },
      "requestReserveDetached": {
        "kind": "action",
        "input": "JobsRequestReserveDetachedRequest",
        "output": "DetachedAcceptance",
        "inputTypeId": "agh.jobs/requestReserveDetached.request@1",
        "outputTypeId": "agh.jobs/requestReserveDetached.response@1"
      },
      "claimOccurrence": {
        "kind": "control",
        "input": "JobsClaimOccurrenceRequest",
        "output": "JobOccurrence",
        "inputTypeId": "agh.jobs/claimOccurrence.request@1",
        "outputTypeId": "agh.jobs/claimOccurrence.response@1"
      },
      "completeOccurrence": {
        "kind": "control",
        "input": "JobsCompleteOccurrenceRequest",
        "output": "JobOccurrence",
        "inputTypeId": "agh.jobs/completeOccurrence.request@1",
        "outputTypeId": "agh.jobs/completeOccurrence.response@1"
      },
      "reserveDetached": {
        "kind": "control",
        "input": "JobsReserveDetachedRequest",
        "output": "DetachedAcceptance",
        "inputTypeId": "agh.jobs/reserveDetached.request@1",
        "outputTypeId": "agh.jobs/reserveDetached.response@1"
      },
      "attachDetached": {
        "kind": "control",
        "input": "JobsAttachDetachedRequest",
        "output": "DetachedAcceptance",
        "inputTypeId": "agh.jobs/attachDetached.request@1",
        "outputTypeId": "agh.jobs/attachDetached.response@1"
      },
      "cancelDetached": {
        "kind": "control",
        "input": "JobsCancelDetachedRequest",
        "output": "DetachedAcceptance",
        "inputTypeId": "agh.jobs/cancelDetached.request@1",
        "outputTypeId": "agh.jobs/cancelDetached.response@1"
      },
      "inspect": {
        "kind": "query",
        "input": "JobsInspectRequest",
        "output": "JobsInspectResult",
        "inputTypeId": "agh.jobs/inspect.request@1",
        "outputTypeId": "agh.jobs/inspect.response@1"
      },
      "createDefinition": {
        "kind": "control",
        "input": "JobsCreateDefinitionRequest",
        "output": "JobDefinition",
        "inputTypeId": "agh.jobs/createDefinition.request@1",
        "outputTypeId": "agh.jobs/createDefinition.response@1"
      },
      "updateDefinition": {
        "kind": "control",
        "input": "JobsUpdateDefinitionRequest",
        "output": "JobDefinition",
        "inputTypeId": "agh.jobs/updateDefinition.request@1",
        "outputTypeId": "agh.jobs/updateDefinition.response@1"
      },
      "cancelDefinition": {
        "kind": "control",
        "input": "JobsCancelDefinitionRequest",
        "output": "JobsRequestCancelResult",
        "inputTypeId": "agh.jobs/cancelDefinition.request@1",
        "outputTypeId": "agh.jobs/cancelDefinition.response@1"
      }
    }
  },
  "agh.artifacts": {
    "major": 1,
    "methods": {
      "reserve": {
        "kind": "action",
        "input": "ArtifactsReserveRequest",
        "output": "ArtifactReservation",
        "inputTypeId": "agh.artifacts/reserve.request@1",
        "outputTypeId": "agh.artifacts/reserve.response@1"
      },
      "publish": {
        "kind": "action",
        "input": "ArtifactsPublishRequest",
        "output": "ArtifactReservation",
        "inputTypeId": "agh.artifacts/publish.request@1",
        "outputTypeId": "agh.artifacts/publish.response@1"
      },
      "revoke": {
        "kind": "action",
        "input": "ArtifactsRevokeRequest",
        "output": "ArtifactReservation",
        "inputTypeId": "agh.artifacts/revoke.request@1",
        "outputTypeId": "agh.artifacts/revoke.response@1"
      },
      "query": {
        "kind": "query",
        "input": "ArtifactsQueryRequest",
        "output": "ArtifactViewRef",
        "inputTypeId": "agh.artifacts/query.request@1",
        "outputTypeId": "agh.artifacts/query.response@1"
      },
      "describe": {
        "local": true,
        "localInterface": "ArtifactClient",
        "localMethod": "describe"
      },
      "openDownload": {
        "local": true,
        "localInterface": "ArtifactClient",
        "localMethod": "openDownload"
      },
      "readRange": {
        "local": true,
        "localInterface": "ArtifactClient",
        "localMethod": "readRange"
      },
      "openStream": {
        "local": true,
        "localInterface": "ArtifactClient",
        "localMethod": "openStream"
      },
      "followDownload": {
        "local": true,
        "localInterface": "ArtifactClient",
        "localMethod": "followDownload"
      }
    }
  },
  "agh.blob": {
    "major": 1,
    "methods": {
      "stage": {
        "kind": "action",
        "input": "BlobStageRequest",
        "output": "UploadSession",
        "inputTypeId": "agh.blob/stage.request@1",
        "outputTypeId": "agh.blob/stage.response@1"
      },
      "promote": {
        "kind": "action",
        "input": "BlobPromoteRequest",
        "output": "StagedBlobRef",
        "inputTypeId": "agh.blob/promote.request@1",
        "outputTypeId": "agh.blob/promote.response@1"
      },
      "pin": {
        "kind": "action",
        "input": "BlobPinRequest",
        "output": "BlobRef",
        "inputTypeId": "agh.blob/pin.request@1",
        "outputTypeId": "agh.blob/pin.response@1"
      },
      "unpin": {
        "kind": "action",
        "input": "BlobUnpinRequest",
        "output": "BlobUnpinResult",
        "inputTypeId": "agh.blob/unpin.request@1",
        "outputTypeId": "agh.blob/unpin.response@1"
      },
      "gc": {
        "kind": "action",
        "input": "BlobGcRequest",
        "output": "BlobGcResult",
        "inputTypeId": "agh.blob/gc.request@1",
        "outputTypeId": "agh.blob/gc.response@1"
      },
      "inspect": {
        "kind": "query",
        "input": "BlobInspectRequest",
        "output": "BlobInspectResult",
        "inputTypeId": "agh.blob/inspect.request@1",
        "outputTypeId": "agh.blob/inspect.response@1"
      }
    }
  },
  "agh.budget": {
    "major": 1,
    "methods": {
      "reserve": {
        "kind": "control",
        "input": "BudgetReserveRequest",
        "output": "BudgetReserveResult",
        "inputTypeId": "agh.budget/reserve.request@1",
        "outputTypeId": "agh.budget/reserve.response@1"
      },
      "settle": {
        "kind": "control",
        "input": "BudgetSettleRequest",
        "output": "BudgetSettleResult",
        "inputTypeId": "agh.budget/settle.request@1",
        "outputTypeId": "agh.budget/settle.response@1"
      },
      "reconcile": {
        "kind": "control",
        "input": "BudgetReconcileRequest",
        "output": "BudgetReconcileResult",
        "inputTypeId": "agh.budget/reconcile.request@1",
        "outputTypeId": "agh.budget/reconcile.response@1"
      },
      "reserveQuota": {
        "kind": "control",
        "input": "BudgetReserveQuotaRequest",
        "output": "QuotaReservation",
        "inputTypeId": "agh.budget/reserveQuota.request@1",
        "outputTypeId": "agh.budget/reserveQuota.response@1"
      },
      "releaseQuota": {
        "kind": "control",
        "input": "BudgetReleaseQuotaRequest",
        "output": "QuotaReservation",
        "inputTypeId": "agh.budget/releaseQuota.request@1",
        "outputTypeId": "agh.budget/releaseQuota.response@1"
      }
    }
  },
  "agh.usage": {
    "major": 1,
    "methods": {
      "record": {
        "kind": "control",
        "input": "UsageRecordRequest",
        "output": "UsageRecordResult",
        "inputTypeId": "agh.usage/record.request@1",
        "outputTypeId": "agh.usage/record.response@1"
      },
      "query": {
        "kind": "query",
        "input": "UsageQueryRequest",
        "output": "UsageQueryResult",
        "inputTypeId": "agh.usage/query.request@1",
        "outputTypeId": "agh.usage/query.response@1"
      }
    }
  },
  "agh.pricing": {
    "major": 1,
    "methods": {
      "quote": {
        "kind": "compute",
        "input": "PricingQuoteInput",
        "output": "PriceQuote",
        "inputTypeId": "agh.pricing/quote.request@1",
        "outputTypeId": "agh.pricing/quote.response@1"
      }
    }
  },
  "agh.billing": {
    "major": 1,
    "methods": {
      "post": {
        "kind": "action",
        "input": "BillingPostRequest",
        "output": "BillingEntry",
        "inputTypeId": "agh.billing/post.request@1",
        "outputTypeId": "agh.billing/post.response@1"
      },
      "refund": {
        "kind": "action",
        "input": "BillingRefundRequest",
        "output": "BillingEntry",
        "inputTypeId": "agh.billing/refund.request@1",
        "outputTypeId": "agh.billing/refund.response@1"
      },
      "reconcile": {
        "kind": "action",
        "input": "BillingReconcileRequest",
        "output": "BillingEntry",
        "inputTypeId": "agh.billing/reconcile.request@1",
        "outputTypeId": "agh.billing/reconcile.response@1"
      }
    }
  },
  "agh.audit": {
    "major": 1,
    "methods": {
      "append": {
        "kind": "control",
        "input": "AuditAppend",
        "output": "AuditAppendResult",
        "inputTypeId": "agh.audit/append.request@1",
        "outputTypeId": "agh.audit/append.response@1"
      },
      "export": {
        "kind": "action",
        "input": "AuditExportRequest",
        "output": "AuditExportResult",
        "inputTypeId": "agh.audit/export.request@1",
        "outputTypeId": "agh.audit/export.response@1"
      }
    }
  },
  "agh.trace": {
    "major": 1,
    "methods": {
      "record": {
        "kind": "observe",
        "input": "TraceRecordRequest",
        "output": "TraceRecordResult",
        "inputTypeId": "agh.trace/record.request@1",
        "outputTypeId": "agh.trace/record.response@1"
      },
      "export": {
        "kind": "action",
        "input": "TelemetryExportRequest",
        "output": "TelemetryExportResult",
        "inputTypeId": "agh.trace/export.request@1",
        "outputTypeId": "agh.trace/export.response@1"
      }
    }
  },
  "agh.events": {
    "major": 1,
    "methods": {
      "subscribe": {
        "kind": "query",
        "input": "EventsSubscribeRequest",
        "output": "EventsSubscribeResult",
        "inputTypeId": "agh.events/subscribe.request@1",
        "outputTypeId": "agh.events/subscribe.response@1"
      },
      "publish": {
        "kind": "action",
        "input": "EventsPublishRequest",
        "output": "EventsPublishResult",
        "inputTypeId": "agh.events/publish.request@1",
        "outputTypeId": "agh.events/publish.response@1"
      }
    }
  },
  "agh.projection": {
    "major": 1,
    "methods": {
      "snapshot": {
        "kind": "query",
        "input": "DomainQuery",
        "output": "ProjectionSnapshot",
        "inputTypeId": "agh.projection/snapshot.request@1",
        "outputTypeId": "agh.projection/snapshot.response@1"
      },
      "changes": {
        "kind": "query",
        "input": "ProjectionChangesRequest",
        "output": "ProjectionChanges",
        "inputTypeId": "agh.projection/changes.request@1",
        "outputTypeId": "agh.projection/changes.response@1"
      },
      "command": {
        "kind": "action",
        "input": "DomainCommandRequest",
        "output": "CommandHandle",
        "inputTypeId": "agh.projection/command.request@1",
        "outputTypeId": "agh.projection/command.response@1"
      }
    }
  },
  "agh.transport": {
    "major": 1,
    "methods": {
      "handshake": {
        "kind": "query",
        "input": "ClientHello",
        "output": "ClientWelcome",
        "inputTypeId": "agh.transport/handshake.request@1",
        "outputTypeId": "agh.transport/handshake.response@1"
      },
      "connect": {
        "kind": "query",
        "input": "ClientHello",
        "output": "ClientWelcome",
        "inputTypeId": "agh.transport/connect.request@1",
        "outputTypeId": "agh.transport/connect.response@1"
      },
      "command": {
        "kind": "action",
        "input": "DomainCommandRequest",
        "output": "CommandHandle",
        "inputTypeId": "agh.transport/command.request@1",
        "outputTypeId": "agh.transport/command.response@1"
      }
    }
  },
  "agh.channel": {
    "major": 1,
    "methods": {
      "send": {
        "kind": "action",
        "input": "ChannelMessage",
        "output": "ChannelDelivery",
        "inputTypeId": "agh.channel/send.request@1",
        "outputTypeId": "agh.channel/send.response@1"
      },
      "reconcile": {
        "kind": "action",
        "input": "ChannelReconcileRequest",
        "output": "ChannelDelivery",
        "inputTypeId": "agh.channel/reconcile.request@1",
        "outputTypeId": "agh.channel/reconcile.response@1"
      },
      "callback": {
        "kind": "ingress",
        "input": "ChannelCallbackRequest",
        "output": "ChannelCallbackResult",
        "inputTypeId": "agh.channel/callback.request@1",
        "outputTypeId": "agh.channel/callback.response@1"
      }
    }
  },
  "agh.package-source": {
    "major": 1,
    "methods": {
      "discover": {
        "kind": "query",
        "input": "PackageSourceDiscoverRequest",
        "output": "PackageSourceDiscoverResult",
        "inputTypeId": "agh.package-source/discover.request@1",
        "outputTypeId": "agh.package-source/discover.response@1"
      },
      "resolveMetadata": {
        "kind": "query",
        "input": "PackageSourceResolveMetadataRequest",
        "output": "PackageSourceResolveMetadataResult",
        "inputTypeId": "agh.package-source/resolveMetadata.request@1",
        "outputTypeId": "agh.package-source/resolveMetadata.response@1"
      },
      "fetch": {
        "kind": "maintenance",
        "input": "PackageSourceFetchRequest",
        "output": "PackageSourceFetchResult",
        "inputTypeId": "agh.package-source/fetch.request@1",
        "outputTypeId": "agh.package-source/fetch.response@1"
      },
      "refreshCatalog": {
        "kind": "maintenance",
        "input": "PackageSourceRefreshCatalogRequest",
        "output": "PackageSourceRefreshCatalogResult",
        "inputTypeId": "agh.package-source/refreshCatalog.request@1",
        "outputTypeId": "agh.package-source/refreshCatalog.response@1"
      }
    }
  },
  "agh.package-resolver": {
    "major": 1,
    "methods": {
      "resolve": {
        "kind": "compute",
        "input": "PackageResolverResolveRequest",
        "output": "PackageResolverResolveResult",
        "inputTypeId": "agh.package-resolver/resolve.request@1",
        "outputTypeId": "agh.package-resolver/resolve.response@1"
      }
    }
  },
  "agh.package-installer": {
    "major": 1,
    "methods": {
      "prepare": {
        "kind": "maintenance",
        "input": "PackageInstallerPrepareRequest",
        "output": "PackageInstallerPrepareResult",
        "inputTypeId": "agh.package-installer/prepare.request@1",
        "outputTypeId": "agh.package-installer/prepare.response@1"
      },
      "activate": {
        "kind": "maintenance",
        "input": "PackageInstallerActivateRequest",
        "output": "PackageInstallerActivateResult",
        "inputTypeId": "agh.package-installer/activate.request@1",
        "outputTypeId": "agh.package-installer/activate.response@1"
      },
      "disable": {
        "kind": "maintenance",
        "input": "PackageInstallerDisableRequest",
        "output": "PackageInstallerDisableResult",
        "inputTypeId": "agh.package-installer/disable.request@1",
        "outputTypeId": "agh.package-installer/disable.response@1"
      },
      "repair": {
        "kind": "maintenance",
        "input": "PackageInstallerRepairRequest",
        "output": "MigrationReceipt",
        "inputTypeId": "agh.package-installer/repair.request@1",
        "outputTypeId": "agh.package-installer/repair.response@1"
      },
      "requestChange": {
        "kind": "action",
        "input": "ChangeProposalRequest",
        "output": "ChangeProposal",
        "inputTypeId": "agh.package-installer/requestChange.request@1",
        "outputTypeId": "agh.package-installer/requestChange.response@1"
      },
      "cancelProposal": {
        "kind": "action",
        "input": "PackageInstallerCancelProposalRequest",
        "output": "ChangeProposal",
        "inputTypeId": "agh.package-installer/cancelProposal.request@1",
        "outputTypeId": "agh.package-installer/cancelProposal.response@1"
      },
      "proposalStatus": {
        "kind": "query",
        "input": "PackageInstallerProposalStatusRequest",
        "output": "ChangeProposal",
        "inputTypeId": "agh.package-installer/proposalStatus.request@1",
        "outputTypeId": "agh.package-installer/proposalStatus.response@1"
      },
      "applyResourceChange": {
        "kind": "maintenance",
        "input": "PackageInstallerApplyResourceChangeRequest",
        "output": "PackageInstallerApplyResourceChangeResult",
        "inputTypeId": "agh.package-installer/applyResourceChange.request@1",
        "outputTypeId": "agh.package-installer/applyResourceChange.response@1"
      }
    }
  },
  "agh.config": {
    "major": 1,
    "methods": {
      "read": {
        "kind": "query",
        "input": "ConfigReadRequest",
        "output": "ConfigReadResult",
        "inputTypeId": "agh.config/read.request@1",
        "outputTypeId": "agh.config/read.response@1"
      }
    }
  },
  "agh.assembly": {
    "major": 1,
    "methods": {
      "plan": {
        "kind": "maintenance",
        "input": "AssemblyPlanRequest",
        "output": "AssemblyGraph",
        "inputTypeId": "agh.assembly/plan.request@1",
        "outputTypeId": "agh.assembly/plan.response@1"
      },
      "prepare": {
        "kind": "maintenance",
        "input": "AssemblyPrepareRequest",
        "output": "AssemblyPrepareResult",
        "inputTypeId": "agh.assembly/prepare.request@1",
        "outputTypeId": "agh.assembly/prepare.response@1"
      },
      "publish": {
        "kind": "maintenance",
        "input": "AssemblyPublishRequest",
        "output": "AssemblyPublishResult",
        "inputTypeId": "agh.assembly/publish.request@1",
        "outputTypeId": "agh.assembly/publish.response@1"
      },
      "drain": {
        "kind": "maintenance",
        "input": "AssemblyDrainRequest",
        "output": "AssemblyDrainResult",
        "inputTypeId": "agh.assembly/drain.request@1",
        "outputTypeId": "agh.assembly/drain.response@1"
      }
    }
  },
  "agh.migration": {
    "major": 1,
    "methods": {
      "inspect": {
        "kind": "maintenance",
        "input": "MigrationRequest",
        "output": "MigrationPlan",
        "inputTypeId": "agh.migration/inspect.request@1",
        "outputTypeId": "agh.migration/inspect.response@1"
      },
      "prepare": {
        "kind": "maintenance",
        "input": "MigrationPrepareRequest",
        "output": "MigrationPrepareResult",
        "inputTypeId": "agh.migration/prepare.request@1",
        "outputTypeId": "agh.migration/prepare.response@1"
      },
      "validate": {
        "kind": "maintenance",
        "input": "MigrationValidateRequest",
        "output": "MigrationValidateResult",
        "inputTypeId": "agh.migration/validate.request@1",
        "outputTypeId": "agh.migration/validate.response@1"
      },
      "cutover": {
        "kind": "maintenance",
        "input": "MigrationCutoverRequest",
        "output": "MigrationReceipt",
        "inputTypeId": "agh.migration/cutover.request@1",
        "outputTypeId": "agh.migration/cutover.response@1"
      },
      "probe": {
        "kind": "maintenance",
        "input": "MigrationProbeRequest",
        "output": "MigrationReceipt",
        "inputTypeId": "agh.migration/probe.request@1",
        "outputTypeId": "agh.migration/probe.response@1"
      },
      "abort": {
        "kind": "maintenance",
        "input": "MigrationAbortRequest",
        "output": "MigrationReceipt",
        "inputTypeId": "agh.migration/abort.request@1",
        "outputTypeId": "agh.migration/abort.response@1"
      }
    }
  },
  "agh.integrity": {
    "major": 1,
    "methods": {
      "verifyPackage": {
        "kind": "maintenance",
        "input": "IntegrityVerifyPackageRequest",
        "output": "IntegrityVerifyPackageResult",
        "inputTypeId": "agh.integrity/verifyPackage.request@1",
        "outputTypeId": "agh.integrity/verifyPackage.response@1"
      }
    }
  },
  "agh.authority-directory": {
    "major": 1,
    "methods": {
      "read": {
        "kind": "maintenance",
        "input": "AuthorityDirectoryReadRequest",
        "output": "AuthorityDirectoryReadResult",
        "inputTypeId": "agh.authority-directory/read.request@1",
        "outputTypeId": "agh.authority-directory/read.response@1"
      },
      "transfer": {
        "kind": "maintenance",
        "input": "MigrationRequest",
        "output": "MigrationReceipt",
        "inputTypeId": "agh.authority-directory/transfer.request@1",
        "outputTypeId": "agh.authority-directory/transfer.response@1"
      }
    }
  },
  "agh.state": {
    "major": 1,
    "methods": {
      "acceptServiceCommand": {
        "kind": "control",
        "input": "ServiceCommandAdmission",
        "output": "ServiceCommandRecord",
        "inputTypeId": "agh.state/acceptServiceCommand.request@1",
        "outputTypeId": "agh.state/acceptServiceCommand.response@1"
      },
      "readServiceCommand": {
        "kind": "query",
        "input": "StateStoreControlReadServiceCommandRequest",
        "output": "StateStoreControlReadServiceCommandResult",
        "inputTypeId": "agh.state/readServiceCommand.request@1",
        "outputTypeId": "agh.state/readServiceCommand.response@1"
      },
      "importConversation": {
        "kind": "control",
        "input": "ConversationImportRequest",
        "output": "ConversationImportResult",
        "inputTypeId": "agh.state/importConversation.request@1",
        "outputTypeId": "agh.state/importConversation.response@1"
      },
      "probeConversationImport": {
        "kind": "query",
        "input": "Id",
        "output": "StateStoreControlProbeConversationImportResult",
        "inputTypeId": "agh.state/probeConversationImport.request@1",
        "outputTypeId": "agh.state/probeConversationImport.response@1"
      },
      "open": {
        "kind": "control",
        "input": "StateOpenRequest",
        "output": "StateOpenResult",
        "inputTypeId": "agh.state/open.request@1",
        "outputTypeId": "agh.state/open.response@1"
      },
      "lease": {
        "kind": "control",
        "input": "StateLeaseRequest",
        "output": "StateLeaseResult",
        "inputTypeId": "agh.state/lease.request@1",
        "outputTypeId": "agh.state/lease.response@1"
      },
      "createChild": {
        "kind": "control",
        "input": "ChildCreateRequest",
        "output": "StateOpenResult",
        "inputTypeId": "agh.state/createChild.request@1",
        "outputTypeId": "agh.state/createChild.response@1"
      },
      "admitInvocation": {
        "kind": "control",
        "input": "InvocationAdmission",
        "output": "AdmitInvocationResult",
        "inputTypeId": "agh.state/admitInvocation.request@1",
        "outputTypeId": "agh.state/admitInvocation.response@1"
      },
      "admitQuery": {
        "kind": "control",
        "input": "QueryAdmission",
        "output": "AdmitQueryResult",
        "inputTypeId": "agh.state/admitQuery.request@1",
        "outputTypeId": "agh.state/admitQuery.response@1"
      },
      "closeInvocation": {
        "kind": "control",
        "input": "CloseInvocationRequest",
        "output": "CloseInvocationResult",
        "inputTypeId": "agh.state/closeInvocation.request@1",
        "outputTypeId": "agh.state/closeInvocation.response@1"
      },
      "dispatchAdmission": {
        "kind": "control",
        "input": "DispatchAdmissionRequest",
        "output": "DispatchAdmissionResult",
        "inputTypeId": "agh.state/dispatchAdmission.request@1",
        "outputTypeId": "agh.state/dispatchAdmission.response@1"
      },
      "probeDispatchAdmission": {
        "kind": "query",
        "input": "Id",
        "output": "DispatchAdmissionProbe",
        "inputTypeId": "agh.state/probeDispatchAdmission.request@1",
        "outputTypeId": "agh.state/probeDispatchAdmission.response@1"
      },
      "pruneRecordVersions": {
        "kind": "maintenance",
        "input": "PruneRecordVersionsRequest",
        "output": "PruneRecordVersionsResult",
        "inputTypeId": "agh.state/pruneRecordVersions.request@1",
        "outputTypeId": "agh.state/pruneRecordVersions.response@1"
      },
      "commitControl": {
        "kind": "control",
        "input": "CommitControlRequest",
        "output": "StateCommitReceipt",
        "inputTypeId": "agh.state/commitControl.request@1",
        "outputTypeId": "agh.state/commitControl.response@1"
      },
      "createRun": {
        "kind": "control",
        "input": "RunAdmission",
        "output": "AdmissionProbe",
        "inputTypeId": "agh.state/createRun.request@1",
        "outputTypeId": "agh.state/createRun.response@1"
      },
      "probeAdmission": {
        "kind": "query",
        "input": "Id",
        "output": "AdmissionProbe",
        "inputTypeId": "agh.state/probeAdmission.request@1",
        "outputTypeId": "agh.state/probeAdmission.response@1"
      },
      "cancelPreparedActionAdmission": {
        "kind": "control",
        "input": "StateStoreControlCancelPreparedActionAdmissionRequest",
        "output": "PreparedActionAdmissionProbe",
        "inputTypeId": "agh.state/cancelPreparedActionAdmission.request@1",
        "outputTypeId": "agh.state/cancelPreparedActionAdmission.response@1"
      },
      "probePreparedActionAdmission": {
        "kind": "query",
        "input": "StateStoreControlProbePreparedActionAdmissionRequest",
        "output": "PreparedActionAdmissionProbe",
        "inputTypeId": "agh.state/probePreparedActionAdmission.request@1",
        "outputTypeId": "agh.state/probePreparedActionAdmission.response@1"
      },
      "readSessionControl": {
        "kind": "query",
        "input": "StateStoreControlReadSessionControlRequest",
        "output": "SessionControlState",
        "inputTypeId": "agh.state/readSessionControl.request@1",
        "outputTypeId": "agh.state/readSessionControl.response@1"
      },
      "submitSessionControl": {
        "kind": "control",
        "input": "SessionControlRequest",
        "output": "SessionControlResult",
        "inputTypeId": "agh.state/submitSessionControl.request@1",
        "outputTypeId": "agh.state/submitSessionControl.response@1"
      },
      "sessionControlStatus": {
        "kind": "control",
        "input": "StateStoreControlSessionControlStatusRequest",
        "output": "StateStoreControlSessionControlStatusResult",
        "inputTypeId": "agh.state/sessionControlStatus.request@1",
        "outputTypeId": "agh.state/sessionControlStatus.response@1"
      },
      "acceptInbox": {
        "kind": "control",
        "input": "SignalDelivery",
        "output": "SignalIntakeReceipt",
        "inputTypeId": "agh.state/acceptInbox.request@1",
        "outputTypeId": "agh.state/acceptInbox.response@1"
      },
      "fireTimer": {
        "kind": "control",
        "input": "StateStoreControlFireTimerRequest",
        "output": "SignalIntakeReceipt",
        "inputTypeId": "agh.state/fireTimer.request@1",
        "outputTypeId": "agh.state/fireTimer.response@1"
      },
      "registerStream": {
        "kind": "control",
        "input": "StreamRegistration",
        "output": "StateStoreControlRegisterStreamResult",
        "inputTypeId": "agh.state/registerStream.request@1",
        "outputTypeId": "agh.state/registerStream.response@1"
      },
      "appendStream": {
        "kind": "control",
        "input": "StateStoreControlAppendStreamRequest",
        "output": "StateStoreControlAppendStreamResult",
        "inputTypeId": "agh.state/appendStream.request@1",
        "outputTypeId": "agh.state/appendStream.response@1"
      },
      "claimOutbox": {
        "kind": "control",
        "input": "ClaimOutboxRequest",
        "output": "ClaimOutboxResult",
        "inputTypeId": "agh.state/claimOutbox.request@1",
        "outputTypeId": "agh.state/claimOutbox.response@1"
      },
      "ackOutbox": {
        "kind": "control",
        "input": "AckOutboxRequest",
        "output": "AckOutboxResult",
        "inputTypeId": "agh.state/ackOutbox.request@1",
        "outputTypeId": "agh.state/ackOutbox.response@1"
      },
      "failOutbox": {
        "kind": "control",
        "input": "FailOutboxRequest",
        "output": "FailOutboxResult",
        "inputTypeId": "agh.state/failOutbox.request@1",
        "outputTypeId": "agh.state/failOutbox.response@1"
      },
      "beginReconciliation": {
        "kind": "control",
        "input": "StateStoreControlBeginReconciliationRequest",
        "output": "ReconciliationCheckValue",
        "inputTypeId": "agh.state/beginReconciliation.request@1",
        "outputTypeId": "agh.state/beginReconciliation.response@1"
      },
      "completeReconciliation": {
        "kind": "control",
        "input": "StateStoreControlCompleteReconciliationRequest",
        "output": "ReconciliationCheckValue",
        "inputTypeId": "agh.state/completeReconciliation.request@1",
        "outputTypeId": "agh.state/completeReconciliation.response@1"
      },
      "advanceRun": {
        "kind": "control",
        "input": "AdvanceRunRequest",
        "output": "StateCommitReceipt",
        "inputTypeId": "agh.state/advanceRun.request@1",
        "outputTypeId": "agh.state/advanceRun.response@1"
      },
      "advanceProvider": {
        "kind": "control",
        "input": "AdvanceProviderRequest",
        "output": "StateCommitReceipt",
        "inputTypeId": "agh.state/advanceProvider.request@1",
        "outputTypeId": "agh.state/advanceProvider.response@1"
      },
      "intakeReceipt": {
        "kind": "control",
        "input": "ReceiptIntakeRequest",
        "output": "ReceiptIntakeResult",
        "inputTypeId": "agh.state/intakeReceipt.request@1",
        "outputTypeId": "agh.state/intakeReceipt.response@1"
      },
      "publishActionResult": {
        "kind": "control",
        "input": "ResultVisibilityCommit",
        "output": "PublishActionResultResult",
        "inputTypeId": "agh.state/publishActionResult.request@1",
        "outputTypeId": "agh.state/publishActionResult.response@1"
      },
      "probeActionResult": {
        "kind": "query",
        "input": "ProbeActionResultRequest",
        "output": "ProbeActionResultResult",
        "inputTypeId": "agh.state/probeActionResult.request@1",
        "outputTypeId": "agh.state/probeActionResult.response@1"
      },
      "acceptBridgeChild": {
        "kind": "control",
        "input": "LegacyBridgeRequest",
        "output": "StateStoreControlAcceptBridgeChildResult",
        "inputTypeId": "agh.state/acceptBridgeChild.request@1",
        "outputTypeId": "agh.state/acceptBridgeChild.response@1"
      },
      "probeBridgeChild": {
        "kind": "query",
        "input": "StateStoreControlProbeBridgeChildRequest",
        "output": "StateStoreControlProbeBridgeChildResult",
        "inputTypeId": "agh.state/probeBridgeChild.request@1",
        "outputTypeId": "agh.state/probeBridgeChild.response@1"
      },
      "beginMigration": {
        "kind": "control",
        "input": "StateStoreControlBeginMigrationRequest",
        "output": "MigrationToken",
        "inputTypeId": "agh.state/beginMigration.request@1",
        "outputTypeId": "agh.state/beginMigration.response@1"
      },
      "commitMigratedRun": {
        "kind": "control",
        "input": "StateStoreControlCommitMigratedRunRequest",
        "output": "StateCommitReceipt",
        "inputTypeId": "agh.state/commitMigratedRun.request@1",
        "outputTypeId": "agh.state/commitMigratedRun.response@1"
      },
      "abortMigration": {
        "kind": "control",
        "input": "StateStoreControlAbortMigrationRequest",
        "output": "StateCommitReceipt",
        "inputTypeId": "agh.state/abortMigration.request@1",
        "outputTypeId": "agh.state/abortMigration.response@1"
      },
      "probeMigration": {
        "kind": "query",
        "input": "Id",
        "output": "MigrationProbe",
        "inputTypeId": "agh.state/probeMigration.request@1",
        "outputTypeId": "agh.state/probeMigration.response@1"
      },
      "cancelAdmission": {
        "kind": "control",
        "input": "StateCancelAdmissionRequest",
        "output": "AdmissionProbe",
        "inputTypeId": "agh.state/cancelAdmission.request@1",
        "outputTypeId": "agh.state/cancelAdmission.response@1"
      }
    }
  },
  "agh.ui-registry": {
    "major": 1,
    "methods": {
      "register": {
        "local": true,
        "localInterface": "UIRegistry",
        "localMethod": "register"
      },
      "resolve": {
        "local": true,
        "localInterface": "UIRegistry",
        "localMethod": "resolve"
      },
      "bindRenderer": {
        "local": true,
        "localInterface": "UIRegistryHost",
        "localMethod": "bindRenderer"
      }
    }
  },
  "agh.renderer": {
    "major": 1,
    "methods": {
      "component": {
        "local": true,
        "localInterface": "WebRendererDefinition",
        "localMethod": "component"
      },
      "format": {
        "local": true,
        "localInterface": "TextRenderer",
        "localMethod": "format"
      },
      "encode": {
        "local": true,
        "localInterface": "IMRenderer",
        "localMethod": "encode"
      },
      "present": {
        "local": true,
        "localInterface": "RendererHandle",
        "localMethod": "present"
      },
      "dispose": {
        "local": true,
        "localInterface": "RendererHandle",
        "localMethod": "dispose"
      },
      "domain": {
        "local": true,
        "localInterface": "ClientPresentation",
        "localMethod": "domain"
      },
      "legacySlot": {
        "local": true,
        "localInterface": "ClientPresentation",
        "localMethod": "legacySlot"
      }
    }
  },
  "agh.shell": {
    "major": 1,
    "methods": {
      "mount": {
        "local": true,
        "localInterface": "ShellProvider",
        "localMethod": "mount"
      },
      "update": {
        "local": true,
        "localInterface": "ShellProvider",
        "localMethod": "update"
      },
      "exportState": {
        "local": true,
        "localInterface": "ShellProvider",
        "localMethod": "exportState"
      },
      "importState": {
        "local": true,
        "localInterface": "ShellProvider",
        "localMethod": "importState"
      },
      "stopAdmission": {
        "local": true,
        "localInterface": "ShellProvider",
        "localMethod": "stopAdmission"
      },
      "dispose": {
        "local": true,
        "localInterface": "ShellProvider",
        "localMethod": "dispose"
      },
      "create": {
        "local": true,
        "localInterface": "ShellConversationClient",
        "localMethod": "create"
      },
      "open": {
        "local": true,
        "localInterface": "ShellConversationClient",
        "localMethod": "open"
      },
      "history": {
        "local": true,
        "localInterface": "ShellConversationClient",
        "localMethod": "history"
      },
      "submit": {
        "local": true,
        "localInterface": "ShellConversationClient",
        "localMethod": "submit"
      },
      "cancel": {
        "local": true,
        "localInterface": "ShellConversationClient",
        "localMethod": "cancel"
      },
      "query": {
        "local": true,
        "localInterface": "ShellDomainClient",
        "localMethod": "query"
      },
      "command": {
        "local": true,
        "localInterface": "ShellDomainClient",
        "localMethod": "command"
      },
      "navigate": {
        "local": true,
        "localInterface": "ShellServices",
        "localMethod": "navigate"
      }
    }
  }
} as const
export const RuntimeConfigurationSchemas = [
  "RuntimeEmptyAuthorConfig",
  "RuntimeProfile",
  "RuntimePreset",
  "RuntimePluginManifest",
  "RuntimeSimpleLoopCheckpoint"
] as const
export const RuntimeAuthorCapabilities = {
  "rawToolResult": {
    "capability": "agh.hooks.raw-result.read",
    "resourceTypes": [
      "agh.runtime/action-result@1"
    ],
    "operations": [
      "read-raw"
    ]
  },
  "toolResultDisplay": {
    "capability": "agh.hooks.tool-result.transform",
    "resourceTypes": [
      "agh.runtime/action-result@1"
    ],
    "operations": [
      "transform-display"
    ]
  },
  "networkRequest": {
    "capability": "agh.network.request",
    "resourceTypes": [
      "agh.network/target@1"
    ],
    "operations": [
      "request"
    ]
  },
  "modelInference": {
    "capability": "agh.model.infer",
    "resourceTypes": [
      "agh.model/prepared-request@1"
    ],
    "operations": [
      "infer"
    ]
  }
} as const
export const RuntimeInterceptorPolicy = {
  "resources_discover": {
    "category": "transform",
    "readFields": [
      "/actor",
      "/cwd",
      "/registered"
    ],
    "writeFields": [
      "/resources",
      "/additionalContext"
    ]
  },
  "before_step": {
    "category": "directive",
    "readFields": [
      "/turn",
      "/step",
      "/depth",
      "/budget"
    ],
    "writeFields": [
      "/block",
      "/reason"
    ]
  },
  "context": {
    "category": "transform",
    "readFields": [
      "/sections",
      "/surfaceDigest"
    ],
    "writeFields": [
      "/sections",
      "/additionalContext"
    ]
  },
  "before_request": {
    "category": "transform",
    "readFields": [
      "/request",
      "/slot",
      "/model",
      "/attempt"
    ],
    "writeFields": [
      "/patch/samplingParams",
      "/patch/maxTokens",
      "/patch/metadata"
    ]
  },
  "tool_call": {
    "category": "directive",
    "readFields": [
      "/toolUseId",
      "/name",
      "/args",
      "/meta",
      "/actor",
      "/taint",
      "/resolvedPolicy",
      "/executionDomain",
      "/definitionFingerprint",
      "/policyHash"
    ],
    "writeFields": [
      "/allow",
      "/reason"
    ]
  },
  "tool_result": {
    "category": "transform",
    "readFields": [
      "/toolUseId",
      "/name",
      "/args",
      "/result",
      "/enforcement"
    ],
    "writeFields": [
      "/result/content",
      "/result/structured"
    ],
    "readCapabilities": {
      "/result": [
        "rawToolResult"
      ]
    },
    "writeCapabilities": {
      "/result/content": [
        "toolResultDisplay"
      ],
      "/result/structured": [
        "toolResultDisplay"
      ]
    }
  },
  "turn_stopping": {
    "category": "directive",
    "readFields": [
      "/turn",
      "/step",
      "/proposedReason",
      "/plan",
      "/verifier"
    ],
    "writeFields": [
      "/action",
      "/note"
    ]
  },
  "approval_request": {
    "category": "transform",
    "readFields": [
      "/request"
    ],
    "writeFields": [
      "/request/risk",
      "/request/context",
      "/request/summary"
    ]
  },
  "before_compact": {
    "category": "transform",
    "readFields": [
      "/contextTokens",
      "/contextWindow",
      "/reserveTokens",
      "/reason",
      "/previousSummarySeq",
      "/customInstructions"
    ],
    "writeFields": [
      "/keepFromSeq",
      "/summarizeRange",
      "/turnPrefixRange",
      "/previousSummarySeq",
      "/prompts",
      "/maxTokens",
      "/details",
      "/customInstructions"
    ]
  }
} as const
