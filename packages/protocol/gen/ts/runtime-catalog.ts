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
        "outputTypeId": "agh.loop/start.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "resume": {
        "kind": "compute",
        "input": "RunFrame",
        "output": "LoopTransition",
        "inputTypeId": "agh.loop/resume.request@1",
        "outputTypeId": "agh.loop/resume.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.loop/authorityFence.request@1",
        "outputTypeId": "agh.loop/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.loop/authorityExport.request@1",
        "outputTypeId": "agh.loop/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.loop/authorityExportPage.request@1",
        "outputTypeId": "agh.loop/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.loop/authorityImport.request@1",
        "outputTypeId": "agh.loop/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.loop/authorityVerify.request@1",
        "outputTypeId": "agh.loop/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.loop/authorityActivate.request@1",
        "outputTypeId": "agh.loop/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.loop/authorityAbort.request@1",
        "outputTypeId": "agh.loop/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.loop/authorityProbe.request@1",
        "outputTypeId": "agh.loop/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.context/view.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "prepareView": {
        "kind": "action",
        "input": "ContextPrepareViewRequest",
        "output": "ContextView",
        "inputTypeId": "agh.context/prepareView.request@1",
        "outputTypeId": "agh.context/prepareView.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "refresh": {
        "kind": "action",
        "input": "ContextRefreshRequest",
        "output": "ContextRefreshResult",
        "inputTypeId": "agh.context/refresh.request@1",
        "outputTypeId": "agh.context/refresh.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.context/authorityFence.request@1",
        "outputTypeId": "agh.context/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.context/authorityExport.request@1",
        "outputTypeId": "agh.context/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.context/authorityExportPage.request@1",
        "outputTypeId": "agh.context/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.context/authorityImport.request@1",
        "outputTypeId": "agh.context/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.context/authorityVerify.request@1",
        "outputTypeId": "agh.context/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.context/authorityActivate.request@1",
        "outputTypeId": "agh.context/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.context/authorityAbort.request@1",
        "outputTypeId": "agh.context/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.context/authorityProbe.request@1",
        "outputTypeId": "agh.context/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.compaction/plan.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "preparePlan": {
        "kind": "action",
        "input": "CompactionPreparePlanRequest",
        "output": "CompactionPlan",
        "inputTypeId": "agh.compaction/preparePlan.request@1",
        "outputTypeId": "agh.compaction/preparePlan.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "execute": {
        "kind": "action",
        "input": "CompactionExecuteRequest",
        "output": "CompactionResult",
        "inputTypeId": "agh.compaction/execute.request@1",
        "outputTypeId": "agh.compaction/execute.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "apply": {
        "kind": "action",
        "input": "CompactionApplyRequest",
        "output": "CompactionApplyResult",
        "inputTypeId": "agh.compaction/apply.request@1",
        "outputTypeId": "agh.compaction/apply.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "expand": {
        "kind": "query",
        "input": "CompactionExpandRequest",
        "output": "CompactionExpandResult",
        "inputTypeId": "agh.compaction/expand.request@1",
        "outputTypeId": "agh.compaction/expand.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.compaction/authorityFence.request@1",
        "outputTypeId": "agh.compaction/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.compaction/authorityExport.request@1",
        "outputTypeId": "agh.compaction/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.compaction/authorityExportPage.request@1",
        "outputTypeId": "agh.compaction/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.compaction/authorityImport.request@1",
        "outputTypeId": "agh.compaction/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.compaction/authorityVerify.request@1",
        "outputTypeId": "agh.compaction/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.compaction/authorityActivate.request@1",
        "outputTypeId": "agh.compaction/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.compaction/authorityAbort.request@1",
        "outputTypeId": "agh.compaction/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.compaction/authorityProbe.request@1",
        "outputTypeId": "agh.compaction/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.model/prepare.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "prepareRequest": {
        "kind": "action",
        "input": "ModelPrepareRequestRequest",
        "output": "ModelPrepareRequestResult",
        "inputTypeId": "agh.model/prepareRequest.request@1",
        "outputTypeId": "agh.model/prepareRequest.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "infer": {
        "kind": "action",
        "input": "ModelInferRequest",
        "output": "ModelOutput",
        "inputTypeId": "agh.model/infer.request@1",
        "outputTypeId": "agh.model/infer.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.model/authorityFence.request@1",
        "outputTypeId": "agh.model/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.model/authorityExport.request@1",
        "outputTypeId": "agh.model/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.model/authorityExportPage.request@1",
        "outputTypeId": "agh.model/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.model/authorityImport.request@1",
        "outputTypeId": "agh.model/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.model/authorityVerify.request@1",
        "outputTypeId": "agh.model/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.model/authorityActivate.request@1",
        "outputTypeId": "agh.model/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.model/authorityAbort.request@1",
        "outputTypeId": "agh.model/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.model/authorityProbe.request@1",
        "outputTypeId": "agh.model/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.routing/select.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.routing/authorityFence.request@1",
        "outputTypeId": "agh.routing/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.routing/authorityExport.request@1",
        "outputTypeId": "agh.routing/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.routing/authorityExportPage.request@1",
        "outputTypeId": "agh.routing/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.routing/authorityImport.request@1",
        "outputTypeId": "agh.routing/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.routing/authorityVerify.request@1",
        "outputTypeId": "agh.routing/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.routing/authorityActivate.request@1",
        "outputTypeId": "agh.routing/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.routing/authorityAbort.request@1",
        "outputTypeId": "agh.routing/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.routing/authorityProbe.request@1",
        "outputTypeId": "agh.routing/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.media/prepare.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.media/authorityFence.request@1",
        "outputTypeId": "agh.media/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.media/authorityExport.request@1",
        "outputTypeId": "agh.media/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.media/authorityExportPage.request@1",
        "outputTypeId": "agh.media/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.media/authorityImport.request@1",
        "outputTypeId": "agh.media/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.media/authorityVerify.request@1",
        "outputTypeId": "agh.media/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.media/authorityActivate.request@1",
        "outputTypeId": "agh.media/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.media/authorityAbort.request@1",
        "outputTypeId": "agh.media/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.media/authorityProbe.request@1",
        "outputTypeId": "agh.media/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.model-adapter/invoke.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "reconcile": {
        "kind": "action",
        "input": "ModelAdapterReconcileRequest",
        "output": "ReconcileResult",
        "inputTypeId": "agh.model-adapter/reconcile.request@1",
        "outputTypeId": "agh.model-adapter/reconcile.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.model-adapter/authorityFence.request@1",
        "outputTypeId": "agh.model-adapter/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.model-adapter/authorityExport.request@1",
        "outputTypeId": "agh.model-adapter/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.model-adapter/authorityExportPage.request@1",
        "outputTypeId": "agh.model-adapter/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.model-adapter/authorityImport.request@1",
        "outputTypeId": "agh.model-adapter/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.model-adapter/authorityVerify.request@1",
        "outputTypeId": "agh.model-adapter/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.model-adapter/authorityActivate.request@1",
        "outputTypeId": "agh.model-adapter/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.model-adapter/authorityAbort.request@1",
        "outputTypeId": "agh.model-adapter/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.model-adapter/authorityProbe.request@1",
        "outputTypeId": "agh.model-adapter/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.resources/list.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "describe": {
        "kind": "query",
        "input": "ResourcesDescribeRequest",
        "output": "ResourceDescriptor",
        "inputTypeId": "agh.resources/describe.request@1",
        "outputTypeId": "agh.resources/describe.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "register": {
        "kind": "maintenance",
        "input": "ResourcesRegisterRequest",
        "output": "ResourcesRegisterResult",
        "inputTypeId": "agh.resources/register.request@1",
        "outputTypeId": "agh.resources/register.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "remove": {
        "kind": "maintenance",
        "input": "ResourcesRemoveRequest",
        "output": "ResourcesRemoveResult",
        "inputTypeId": "agh.resources/remove.request@1",
        "outputTypeId": "agh.resources/remove.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "retain": {
        "kind": "action",
        "input": "ResourcesRetainRequest",
        "output": "RetentionRef",
        "inputTypeId": "agh.resources/retain.request@1",
        "outputTypeId": "agh.resources/retain.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "release": {
        "kind": "action",
        "input": "ResourcesReleaseRequest",
        "output": "ResourcesReleaseResult",
        "inputTypeId": "agh.resources/release.request@1",
        "outputTypeId": "agh.resources/release.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.resources/authorityFence.request@1",
        "outputTypeId": "agh.resources/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.resources/authorityExport.request@1",
        "outputTypeId": "agh.resources/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.resources/authorityExportPage.request@1",
        "outputTypeId": "agh.resources/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.resources/authorityImport.request@1",
        "outputTypeId": "agh.resources/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.resources/authorityVerify.request@1",
        "outputTypeId": "agh.resources/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.resources/authorityActivate.request@1",
        "outputTypeId": "agh.resources/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.resources/authorityAbort.request@1",
        "outputTypeId": "agh.resources/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.resources/authorityProbe.request@1",
        "outputTypeId": "agh.resources/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.mcp/connect.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "prepareConnection": {
        "kind": "action",
        "input": "McpConnectionPreparation",
        "output": "McpConnectRequest",
        "inputTypeId": "agh.mcp/prepareConnection.request@1",
        "outputTypeId": "agh.mcp/prepareConnection.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "call": {
        "kind": "action",
        "input": "McpCallRequest",
        "output": "McpCallResult",
        "inputTypeId": "agh.mcp/call.request@1",
        "outputTypeId": "agh.mcp/call.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "read": {
        "kind": "action",
        "input": "McpReadRequest",
        "output": "McpReadResult",
        "inputTypeId": "agh.mcp/read.request@1",
        "outputTypeId": "agh.mcp/read.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.mcp/authorityFence.request@1",
        "outputTypeId": "agh.mcp/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.mcp/authorityExport.request@1",
        "outputTypeId": "agh.mcp/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.mcp/authorityExportPage.request@1",
        "outputTypeId": "agh.mcp/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.mcp/authorityImport.request@1",
        "outputTypeId": "agh.mcp/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.mcp/authorityVerify.request@1",
        "outputTypeId": "agh.mcp/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.mcp/authorityActivate.request@1",
        "outputTypeId": "agh.mcp/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.mcp/authorityAbort.request@1",
        "outputTypeId": "agh.mcp/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.mcp/authorityProbe.request@1",
        "outputTypeId": "agh.mcp/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.tools/describe.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "inspect": {
        "kind": "query",
        "input": "ToolsInspectRequest",
        "output": "ToolsInspectResult",
        "inputTypeId": "agh.tools/inspect.request@1",
        "outputTypeId": "agh.tools/inspect.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "classify": {
        "kind": "compute",
        "input": "ToolsClassifyRequest",
        "output": "ToolPolicySnapshot",
        "inputTypeId": "agh.tools/classify.request@1",
        "outputTypeId": "agh.tools/classify.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "catalog": {
        "kind": "compute",
        "input": "ToolsCatalogRequest",
        "output": "ToolCatalog",
        "inputTypeId": "agh.tools/catalog.request@1",
        "outputTypeId": "agh.tools/catalog.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "updatePlan": {
        "kind": "action",
        "input": "ToolPlanUpdate",
        "output": "ToolsUpdatePlanResult",
        "inputTypeId": "agh.tools/updatePlan.request@1",
        "outputTypeId": "agh.tools/updatePlan.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "requestCompaction": {
        "kind": "action",
        "input": "ToolsRequestCompactionRequest",
        "output": "ToolsRequestCompactionResult",
        "inputTypeId": "agh.tools/requestCompaction.request@1",
        "outputTypeId": "agh.tools/requestCompaction.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "invoke": {
        "kind": "action",
        "input": "ToolCall",
        "output": "ToolResult",
        "inputTypeId": "agh.tools/invoke.request@1",
        "outputTypeId": "agh.tools/invoke.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "cancel": {
        "kind": "action",
        "input": "ToolsCancelRequest",
        "output": "ToolsCancelResult",
        "inputTypeId": "agh.tools/cancel.request@1",
        "outputTypeId": "agh.tools/cancel.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "reconcile": {
        "kind": "action",
        "input": "ToolsReconcileRequest",
        "output": "ReconcileResult",
        "inputTypeId": "agh.tools/reconcile.request@1",
        "outputTypeId": "agh.tools/reconcile.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.tools/authorityFence.request@1",
        "outputTypeId": "agh.tools/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.tools/authorityExport.request@1",
        "outputTypeId": "agh.tools/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.tools/authorityExportPage.request@1",
        "outputTypeId": "agh.tools/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.tools/authorityImport.request@1",
        "outputTypeId": "agh.tools/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.tools/authorityVerify.request@1",
        "outputTypeId": "agh.tools/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.tools/authorityActivate.request@1",
        "outputTypeId": "agh.tools/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.tools/authorityAbort.request@1",
        "outputTypeId": "agh.tools/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.tools/authorityProbe.request@1",
        "outputTypeId": "agh.tools/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.memory/remember.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "forget": {
        "kind": "action",
        "input": "MemoryForgetRequest",
        "output": "MemoryForgetResult",
        "inputTypeId": "agh.memory/forget.request@1",
        "outputTypeId": "agh.memory/forget.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "get": {
        "kind": "query",
        "input": "MemoryGetRequest",
        "output": "MemoryGetResult",
        "inputTypeId": "agh.memory/get.request@1",
        "outputTypeId": "agh.memory/get.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.memory/authorityFence.request@1",
        "outputTypeId": "agh.memory/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.memory/authorityExport.request@1",
        "outputTypeId": "agh.memory/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.memory/authorityExportPage.request@1",
        "outputTypeId": "agh.memory/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.memory/authorityImport.request@1",
        "outputTypeId": "agh.memory/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.memory/authorityVerify.request@1",
        "outputTypeId": "agh.memory/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.memory/authorityActivate.request@1",
        "outputTypeId": "agh.memory/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.memory/authorityAbort.request@1",
        "outputTypeId": "agh.memory/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.memory/authorityProbe.request@1",
        "outputTypeId": "agh.memory/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.retrieval/search.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "searchRemote": {
        "kind": "action",
        "input": "RetrievalSearchRemoteRequest",
        "output": "RetrievalSearchRemoteResult",
        "inputTypeId": "agh.retrieval/searchRemote.request@1",
        "outputTypeId": "agh.retrieval/searchRemote.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.retrieval/authorityFence.request@1",
        "outputTypeId": "agh.retrieval/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.retrieval/authorityExport.request@1",
        "outputTypeId": "agh.retrieval/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.retrieval/authorityExportPage.request@1",
        "outputTypeId": "agh.retrieval/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.retrieval/authorityImport.request@1",
        "outputTypeId": "agh.retrieval/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.retrieval/authorityVerify.request@1",
        "outputTypeId": "agh.retrieval/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.retrieval/authorityActivate.request@1",
        "outputTypeId": "agh.retrieval/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.retrieval/authorityAbort.request@1",
        "outputTypeId": "agh.retrieval/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.retrieval/authorityProbe.request@1",
        "outputTypeId": "agh.retrieval/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.embedding/encode.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.embedding/authorityFence.request@1",
        "outputTypeId": "agh.embedding/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.embedding/authorityExport.request@1",
        "outputTypeId": "agh.embedding/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.embedding/authorityExportPage.request@1",
        "outputTypeId": "agh.embedding/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.embedding/authorityImport.request@1",
        "outputTypeId": "agh.embedding/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.embedding/authorityVerify.request@1",
        "outputTypeId": "agh.embedding/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.embedding/authorityActivate.request@1",
        "outputTypeId": "agh.embedding/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.embedding/authorityAbort.request@1",
        "outputTypeId": "agh.embedding/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.embedding/authorityProbe.request@1",
        "outputTypeId": "agh.embedding/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.identity/authenticate.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "resolve": {
        "kind": "query",
        "input": "IdentityResolveRequest",
        "output": "AuthenticatedIdentity",
        "inputTypeId": "agh.identity/resolve.request@1",
        "outputTypeId": "agh.identity/resolve.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.identity/authorityFence.request@1",
        "outputTypeId": "agh.identity/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.identity/authorityExport.request@1",
        "outputTypeId": "agh.identity/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.identity/authorityExportPage.request@1",
        "outputTypeId": "agh.identity/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.identity/authorityImport.request@1",
        "outputTypeId": "agh.identity/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.identity/authorityVerify.request@1",
        "outputTypeId": "agh.identity/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.identity/authorityActivate.request@1",
        "outputTypeId": "agh.identity/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.identity/authorityAbort.request@1",
        "outputTypeId": "agh.identity/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.identity/authorityProbe.request@1",
        "outputTypeId": "agh.identity/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.policy/evaluate.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "listGrants": {
        "kind": "query",
        "input": "ApprovalGrantBindingInput",
        "output": "ApprovalGrantListResult",
        "inputTypeId": "agh.policy/listGrants.request@1",
        "outputTypeId": "agh.policy/listGrants.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "revokeGrant": {
        "kind": "control",
        "input": "PermissionClientRevokeGrantRequest",
        "output": "ApprovalGrantRecord",
        "inputTypeId": "agh.policy/revokeGrant.request@1",
        "outputTypeId": "agh.policy/revokeGrant.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.policy/authorityFence.request@1",
        "outputTypeId": "agh.policy/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.policy/authorityExport.request@1",
        "outputTypeId": "agh.policy/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.policy/authorityExportPage.request@1",
        "outputTypeId": "agh.policy/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.policy/authorityImport.request@1",
        "outputTypeId": "agh.policy/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.policy/authorityVerify.request@1",
        "outputTypeId": "agh.policy/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.policy/authorityActivate.request@1",
        "outputTypeId": "agh.policy/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.policy/authorityAbort.request@1",
        "outputTypeId": "agh.policy/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.policy/authorityProbe.request@1",
        "outputTypeId": "agh.policy/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.effects/runHooks.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "dispatch": {
        "kind": "control",
        "input": "EffectsDispatchRequest",
        "output": "EffectsDispatchResult",
        "inputTypeId": "agh.effects/dispatch.request@1",
        "outputTypeId": "agh.effects/dispatch.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "reconcile": {
        "kind": "control",
        "input": "EffectsReconcileRequest",
        "output": "EffectsReconcileResult",
        "inputTypeId": "agh.effects/reconcile.request@1",
        "outputTypeId": "agh.effects/reconcile.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.effects/authorityFence.request@1",
        "outputTypeId": "agh.effects/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.effects/authorityExport.request@1",
        "outputTypeId": "agh.effects/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.effects/authorityExportPage.request@1",
        "outputTypeId": "agh.effects/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.effects/authorityImport.request@1",
        "outputTypeId": "agh.effects/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.effects/authorityVerify.request@1",
        "outputTypeId": "agh.effects/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.effects/authorityActivate.request@1",
        "outputTypeId": "agh.effects/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.effects/authorityAbort.request@1",
        "outputTypeId": "agh.effects/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.effects/authorityProbe.request@1",
        "outputTypeId": "agh.effects/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.workspace/acquire.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "release": {
        "kind": "action",
        "input": "WorkspaceReleaseRequest",
        "output": "WorkspaceReleaseResult",
        "inputTypeId": "agh.workspace/release.request@1",
        "outputTypeId": "agh.workspace/release.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.workspace/authorityFence.request@1",
        "outputTypeId": "agh.workspace/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.workspace/authorityExport.request@1",
        "outputTypeId": "agh.workspace/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.workspace/authorityExportPage.request@1",
        "outputTypeId": "agh.workspace/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.workspace/authorityImport.request@1",
        "outputTypeId": "agh.workspace/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.workspace/authorityVerify.request@1",
        "outputTypeId": "agh.workspace/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.workspace/authorityActivate.request@1",
        "outputTypeId": "agh.workspace/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.workspace/authorityAbort.request@1",
        "outputTypeId": "agh.workspace/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.workspace/authorityProbe.request@1",
        "outputTypeId": "agh.workspace/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.files/read.response@1",
        "sameAttemptBrokerAllowed": true
      },
      "write": {
        "kind": "action",
        "input": "FilesWriteRequest",
        "output": "FilesWriteResult",
        "inputTypeId": "agh.files/write.request@1",
        "outputTypeId": "agh.files/write.response@1",
        "sameAttemptBrokerAllowed": true
      },
      "list": {
        "kind": "action",
        "input": "FilesListRequest",
        "output": "FilesListResult",
        "inputTypeId": "agh.files/list.request@1",
        "outputTypeId": "agh.files/list.response@1",
        "sameAttemptBrokerAllowed": true
      },
      "stat": {
        "kind": "action",
        "input": "FilesStatRequest",
        "output": "FileStat",
        "inputTypeId": "agh.files/stat.request@1",
        "outputTypeId": "agh.files/stat.response@1",
        "sameAttemptBrokerAllowed": true
      },
      "verifyPolicy": {
        "kind": "control",
        "input": "FsPolicySnapshot",
        "output": "FsEnforcementProof",
        "inputTypeId": "agh.files/verifyPolicy.request@1",
        "outputTypeId": "agh.files/verifyPolicy.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.files/authorityFence.request@1",
        "outputTypeId": "agh.files/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.files/authorityExport.request@1",
        "outputTypeId": "agh.files/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.files/authorityExportPage.request@1",
        "outputTypeId": "agh.files/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.files/authorityImport.request@1",
        "outputTypeId": "agh.files/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.files/authorityVerify.request@1",
        "outputTypeId": "agh.files/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.files/authorityActivate.request@1",
        "outputTypeId": "agh.files/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.files/authorityAbort.request@1",
        "outputTypeId": "agh.files/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.files/authorityProbe.request@1",
        "outputTypeId": "agh.files/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.sandbox/create.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "stop": {
        "kind": "action",
        "input": "SandboxStopRequest",
        "output": "SandboxStopResult",
        "inputTypeId": "agh.sandbox/stop.request@1",
        "outputTypeId": "agh.sandbox/stop.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "inspect": {
        "kind": "action",
        "input": "SandboxInspectRequest",
        "output": "SandboxInspectResult",
        "inputTypeId": "agh.sandbox/inspect.request@1",
        "outputTypeId": "agh.sandbox/inspect.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.sandbox/authorityFence.request@1",
        "outputTypeId": "agh.sandbox/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.sandbox/authorityExport.request@1",
        "outputTypeId": "agh.sandbox/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.sandbox/authorityExportPage.request@1",
        "outputTypeId": "agh.sandbox/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.sandbox/authorityImport.request@1",
        "outputTypeId": "agh.sandbox/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.sandbox/authorityVerify.request@1",
        "outputTypeId": "agh.sandbox/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.sandbox/authorityActivate.request@1",
        "outputTypeId": "agh.sandbox/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.sandbox/authorityAbort.request@1",
        "outputTypeId": "agh.sandbox/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.sandbox/authorityProbe.request@1",
        "outputTypeId": "agh.sandbox/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.exec/run.response@1",
        "sameAttemptBrokerAllowed": true
      },
      "reconcile": {
        "kind": "action",
        "input": "ExecReconcileRequest",
        "output": "ReconcileResult",
        "inputTypeId": "agh.exec/reconcile.request@1",
        "outputTypeId": "agh.exec/reconcile.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.exec/authorityFence.request@1",
        "outputTypeId": "agh.exec/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.exec/authorityExport.request@1",
        "outputTypeId": "agh.exec/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.exec/authorityExportPage.request@1",
        "outputTypeId": "agh.exec/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.exec/authorityImport.request@1",
        "outputTypeId": "agh.exec/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.exec/authorityVerify.request@1",
        "outputTypeId": "agh.exec/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.exec/authorityActivate.request@1",
        "outputTypeId": "agh.exec/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.exec/authorityAbort.request@1",
        "outputTypeId": "agh.exec/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.exec/authorityProbe.request@1",
        "outputTypeId": "agh.exec/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.network/request.response@1",
        "sameAttemptBrokerAllowed": true
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.network/authorityFence.request@1",
        "outputTypeId": "agh.network/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.network/authorityExport.request@1",
        "outputTypeId": "agh.network/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.network/authorityExportPage.request@1",
        "outputTypeId": "agh.network/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.network/authorityImport.request@1",
        "outputTypeId": "agh.network/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.network/authorityVerify.request@1",
        "outputTypeId": "agh.network/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.network/authorityActivate.request@1",
        "outputTypeId": "agh.network/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.network/authorityAbort.request@1",
        "outputTypeId": "agh.network/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.network/authorityProbe.request@1",
        "outputTypeId": "agh.network/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.secrets/resolve.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "rotate": {
        "kind": "maintenance",
        "input": "SecretsRotateRequest",
        "output": "SecretsRotateResult",
        "inputTypeId": "agh.secrets/rotate.request@1",
        "outputTypeId": "agh.secrets/rotate.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "revoke": {
        "kind": "maintenance",
        "input": "SecretsRevokeRequest",
        "output": "SecretsRevokeResult",
        "inputTypeId": "agh.secrets/revoke.request@1",
        "outputTypeId": "agh.secrets/revoke.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "refresh": {
        "kind": "action",
        "input": "CredentialRefreshRequest",
        "output": "CredentialRefreshResult",
        "inputTypeId": "agh.secrets/refresh.request@1",
        "outputTypeId": "agh.secrets/refresh.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "exchange": {
        "kind": "action",
        "input": "CredentialExchangeRequest",
        "output": "CredentialRefreshResult",
        "inputTypeId": "agh.secrets/exchange.request@1",
        "outputTypeId": "agh.secrets/exchange.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "acceptCallback": {
        "kind": "ingress",
        "input": "CredentialCallbackRequest",
        "output": "SecretsAcceptCallbackResult",
        "inputTypeId": "agh.secrets/acceptCallback.request@1",
        "outputTypeId": "agh.secrets/acceptCallback.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.secrets/authorityFence.request@1",
        "outputTypeId": "agh.secrets/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.secrets/authorityExport.request@1",
        "outputTypeId": "agh.secrets/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.secrets/authorityExportPage.request@1",
        "outputTypeId": "agh.secrets/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.secrets/authorityImport.request@1",
        "outputTypeId": "agh.secrets/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.secrets/authorityVerify.request@1",
        "outputTypeId": "agh.secrets/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.secrets/authorityActivate.request@1",
        "outputTypeId": "agh.secrets/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.secrets/authorityAbort.request@1",
        "outputTypeId": "agh.secrets/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.secrets/authorityProbe.request@1",
        "outputTypeId": "agh.secrets/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.interaction/request.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "respond": {
        "kind": "action",
        "input": "InteractionRespondRequest",
        "output": "InteractionResponseStatus",
        "inputTypeId": "agh.interaction/respond.request@1",
        "outputTypeId": "agh.interaction/respond.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "expire": {
        "kind": "action",
        "input": "InteractionExpireRequest",
        "output": "InteractionRecord",
        "inputTypeId": "agh.interaction/expire.request@1",
        "outputTypeId": "agh.interaction/expire.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "cancel": {
        "kind": "action",
        "input": "InteractionCancelRequest",
        "output": "InteractionRecord",
        "inputTypeId": "agh.interaction/cancel.request@1",
        "outputTypeId": "agh.interaction/cancel.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "read": {
        "kind": "query",
        "input": "Id",
        "output": "InteractionRecord",
        "inputTypeId": "agh.interaction/read.request@1",
        "outputTypeId": "agh.interaction/read.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "pending": {
        "kind": "query",
        "input": "InteractionClientPendingRequest",
        "output": "InteractionClientPendingResult",
        "inputTypeId": "agh.interaction/pending.request@1",
        "outputTypeId": "agh.interaction/pending.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "responseStatus": {
        "kind": "query",
        "input": "Id",
        "output": "InteractionResponseStatus",
        "inputTypeId": "agh.interaction/responseStatus.request@1",
        "outputTypeId": "agh.interaction/responseStatus.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "acceptResponse": {
        "kind": "control",
        "input": "InteractionClientRespondRequest",
        "output": "InteractionResponseStatus",
        "inputTypeId": "agh.interaction/acceptResponse.request@1",
        "outputTypeId": "agh.interaction/acceptResponse.response@1",
        "sameAttemptBrokerAllowed": false,
        "identityField": "responseId"
      },
      "respondApproval": {
        "kind": "control",
        "input": "ApprovalRespondRequest",
        "output": "InteractionResponseStatus",
        "inputTypeId": "agh.interaction/respondApproval.request@1",
        "outputTypeId": "agh.interaction/respondApproval.response@1",
        "sameAttemptBrokerAllowed": false,
        "identityField": "responseId"
      },
      "formLink": {
        "kind": "control",
        "input": "InteractionFormLinkRequest",
        "output": "InteractionFormLink",
        "inputTypeId": "agh.interaction/formLink.request@1",
        "outputTypeId": "agh.interaction/formLink.response@1",
        "sameAttemptBrokerAllowed": false,
        "identityField": "requestId"
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.interaction/authorityFence.request@1",
        "outputTypeId": "agh.interaction/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.interaction/authorityExport.request@1",
        "outputTypeId": "agh.interaction/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.interaction/authorityExportPage.request@1",
        "outputTypeId": "agh.interaction/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.interaction/authorityImport.request@1",
        "outputTypeId": "agh.interaction/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.interaction/authorityVerify.request@1",
        "outputTypeId": "agh.interaction/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.interaction/authorityActivate.request@1",
        "outputTypeId": "agh.interaction/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.interaction/authorityAbort.request@1",
        "outputTypeId": "agh.interaction/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.interaction/authorityProbe.request@1",
        "outputTypeId": "agh.interaction/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.recovery/inspect.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "restore": {
        "kind": "maintenance",
        "input": "RecoveryRestoreRequest",
        "output": "RecoveryRestoreResult",
        "inputTypeId": "agh.recovery/restore.request@1",
        "outputTypeId": "agh.recovery/restore.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.recovery/authorityFence.request@1",
        "outputTypeId": "agh.recovery/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.recovery/authorityExport.request@1",
        "outputTypeId": "agh.recovery/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.recovery/authorityExportPage.request@1",
        "outputTypeId": "agh.recovery/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.recovery/authorityImport.request@1",
        "outputTypeId": "agh.recovery/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.recovery/authorityVerify.request@1",
        "outputTypeId": "agh.recovery/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.recovery/authorityActivate.request@1",
        "outputTypeId": "agh.recovery/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.recovery/authorityAbort.request@1",
        "outputTypeId": "agh.recovery/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.recovery/authorityProbe.request@1",
        "outputTypeId": "agh.recovery/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.supervisor/admit.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "admitServiceCommand": {
        "kind": "control",
        "input": "ServiceCommandAdmission",
        "output": "ServiceCommandRecord",
        "inputTypeId": "agh.supervisor/admitServiceCommand.request@1",
        "outputTypeId": "agh.supervisor/admitServiceCommand.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "signal": {
        "kind": "control",
        "input": "SupervisorSignalRequest",
        "output": "SupervisorSignalResult",
        "inputTypeId": "agh.supervisor/signal.request@1",
        "outputTypeId": "agh.supervisor/signal.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "cancel": {
        "kind": "control",
        "input": "SupervisorCancelRequest",
        "output": "SupervisorCancelResult",
        "inputTypeId": "agh.supervisor/cancel.request@1",
        "outputTypeId": "agh.supervisor/cancel.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "sessionParameters": {
        "kind": "query",
        "input": "SupervisorSessionParametersRequest",
        "output": "SupervisorSessionParametersResult",
        "inputTypeId": "agh.supervisor/sessionParameters.request@1",
        "outputTypeId": "agh.supervisor/sessionParameters.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "inspect": {
        "kind": "query",
        "input": "SupervisorInspectRequest",
        "output": "SupervisorInspectResult",
        "inputTypeId": "agh.supervisor/inspect.request@1",
        "outputTypeId": "agh.supervisor/inspect.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "serviceCommandStatus": {
        "kind": "query",
        "input": "StateStoreControlReadServiceCommandRequest",
        "output": "SupervisorServiceCommandStatusResult",
        "inputTypeId": "agh.supervisor/serviceCommandStatus.request@1",
        "outputTypeId": "agh.supervisor/serviceCommandStatus.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "actionReceipt": {
        "kind": "query",
        "input": "SupervisorActionReceiptRequest",
        "output": "SupervisorActionReceiptResult",
        "inputTypeId": "agh.supervisor/actionReceipt.request@1",
        "outputTypeId": "agh.supervisor/actionReceipt.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "createConversation": {
        "kind": "control",
        "input": "ShellConversationClientCreateRequest",
        "output": "ShellConversationClientCreateResult",
        "inputTypeId": "agh.supervisor/createConversation.request@1",
        "outputTypeId": "agh.supervisor/createConversation.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "submitConversation": {
        "kind": "control",
        "input": "ShellConversationClientSubmitRequest",
        "output": "CommandHandle",
        "inputTypeId": "agh.supervisor/submitConversation.request@1",
        "outputTypeId": "agh.supervisor/submitConversation.response@1",
        "sameAttemptBrokerAllowed": false,
        "completion": "runtime-accepted"
      },
      "cancelConversation": {
        "kind": "control",
        "input": "ShellConversationClientCancelRequest",
        "output": "CommandHandle",
        "inputTypeId": "agh.supervisor/cancelConversation.request@1",
        "outputTypeId": "agh.supervisor/cancelConversation.response@1",
        "sameAttemptBrokerAllowed": false,
        "completion": "runtime-accepted"
      },
      "conversationCommandStatus": {
        "kind": "query",
        "input": "ShellConversationClientStatusRequest",
        "output": "CommandHandle",
        "inputTypeId": "agh.supervisor/conversationCommandStatus.request@1",
        "outputTypeId": "agh.supervisor/conversationCommandStatus.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "readSessionControl": {
        "kind": "query",
        "input": "Id",
        "output": "SessionControlState",
        "inputTypeId": "agh.supervisor/readSessionControl.request@1",
        "outputTypeId": "agh.supervisor/readSessionControl.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "submitSessionControl": {
        "kind": "control",
        "input": "SessionControlRequest",
        "output": "SessionControlResult",
        "inputTypeId": "agh.supervisor/submitSessionControl.request@1",
        "outputTypeId": "agh.supervisor/submitSessionControl.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "sessionControlStatus": {
        "kind": "query",
        "input": "SessionControlClientStatusRequest",
        "output": "SessionControlResult",
        "inputTypeId": "agh.supervisor/sessionControlStatus.request@1",
        "outputTypeId": "agh.supervisor/sessionControlStatus.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.supervisor/authorityFence.request@1",
        "outputTypeId": "agh.supervisor/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.supervisor/authorityExport.request@1",
        "outputTypeId": "agh.supervisor/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.supervisor/authorityExportPage.request@1",
        "outputTypeId": "agh.supervisor/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.supervisor/authorityImport.request@1",
        "outputTypeId": "agh.supervisor/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.supervisor/authorityVerify.request@1",
        "outputTypeId": "agh.supervisor/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.supervisor/authorityActivate.request@1",
        "outputTypeId": "agh.supervisor/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.supervisor/authorityAbort.request@1",
        "outputTypeId": "agh.supervisor/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.supervisor/authorityProbe.request@1",
        "outputTypeId": "agh.supervisor/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.scheduler/enqueue.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "claim": {
        "kind": "control",
        "input": "SchedulerClaimRequest",
        "output": "SchedulerClaimResult",
        "inputTypeId": "agh.scheduler/claim.request@1",
        "outputTypeId": "agh.scheduler/claim.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "ack": {
        "kind": "control",
        "input": "SchedulerAckRequest",
        "output": "SchedulerAckResult",
        "inputTypeId": "agh.scheduler/ack.request@1",
        "outputTypeId": "agh.scheduler/ack.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.scheduler/authorityFence.request@1",
        "outputTypeId": "agh.scheduler/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.scheduler/authorityExport.request@1",
        "outputTypeId": "agh.scheduler/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.scheduler/authorityExportPage.request@1",
        "outputTypeId": "agh.scheduler/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.scheduler/authorityImport.request@1",
        "outputTypeId": "agh.scheduler/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.scheduler/authorityVerify.request@1",
        "outputTypeId": "agh.scheduler/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.scheduler/authorityActivate.request@1",
        "outputTypeId": "agh.scheduler/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.scheduler/authorityAbort.request@1",
        "outputTypeId": "agh.scheduler/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.scheduler/authorityProbe.request@1",
        "outputTypeId": "agh.scheduler/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.agents/spawn.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "send": {
        "kind": "action",
        "input": "AgentsSendRequest",
        "output": "AgentsSendResult",
        "inputTypeId": "agh.agents/send.request@1",
        "outputTypeId": "agh.agents/send.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "resume": {
        "kind": "action",
        "input": "AgentsResumeRequest",
        "output": "AgentsResumeResult",
        "inputTypeId": "agh.agents/resume.request@1",
        "outputTypeId": "agh.agents/resume.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "cancel": {
        "kind": "action",
        "input": "AgentsCancelRequest",
        "output": "AgentsCancelResult",
        "inputTypeId": "agh.agents/cancel.request@1",
        "outputTypeId": "agh.agents/cancel.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "retire": {
        "kind": "action",
        "input": "AgentsRetireRequest",
        "output": "AgentsRetireResult",
        "inputTypeId": "agh.agents/retire.request@1",
        "outputTypeId": "agh.agents/retire.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "inspect": {
        "kind": "query",
        "input": "AgentsInspectRequest",
        "output": "AgentSnapshot",
        "inputTypeId": "agh.agents/inspect.request@1",
        "outputTypeId": "agh.agents/inspect.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.agents/authorityFence.request@1",
        "outputTypeId": "agh.agents/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.agents/authorityExport.request@1",
        "outputTypeId": "agh.agents/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.agents/authorityExportPage.request@1",
        "outputTypeId": "agh.agents/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.agents/authorityImport.request@1",
        "outputTypeId": "agh.agents/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.agents/authorityVerify.request@1",
        "outputTypeId": "agh.agents/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.agents/authorityActivate.request@1",
        "outputTypeId": "agh.agents/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.agents/authorityAbort.request@1",
        "outputTypeId": "agh.agents/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.agents/authorityProbe.request@1",
        "outputTypeId": "agh.agents/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.jobs/requestCreate.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "requestUpdate": {
        "kind": "action",
        "input": "JobsRequestUpdateRequest",
        "output": "JobDefinition",
        "inputTypeId": "agh.jobs/requestUpdate.request@1",
        "outputTypeId": "agh.jobs/requestUpdate.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "requestCancel": {
        "kind": "action",
        "input": "JobsRequestCancelRequest",
        "output": "JobsRequestCancelResult",
        "inputTypeId": "agh.jobs/requestCancel.request@1",
        "outputTypeId": "agh.jobs/requestCancel.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "requestReserveDetached": {
        "kind": "action",
        "input": "JobsRequestReserveDetachedRequest",
        "output": "DetachedAcceptance",
        "inputTypeId": "agh.jobs/requestReserveDetached.request@1",
        "outputTypeId": "agh.jobs/requestReserveDetached.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "claimOccurrence": {
        "kind": "control",
        "input": "JobsClaimOccurrenceRequest",
        "output": "JobOccurrence",
        "inputTypeId": "agh.jobs/claimOccurrence.request@1",
        "outputTypeId": "agh.jobs/claimOccurrence.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "completeOccurrence": {
        "kind": "control",
        "input": "JobsCompleteOccurrenceRequest",
        "output": "JobOccurrence",
        "inputTypeId": "agh.jobs/completeOccurrence.request@1",
        "outputTypeId": "agh.jobs/completeOccurrence.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "reserveDetached": {
        "kind": "control",
        "input": "JobsReserveDetachedRequest",
        "output": "DetachedAcceptance",
        "inputTypeId": "agh.jobs/reserveDetached.request@1",
        "outputTypeId": "agh.jobs/reserveDetached.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "attachDetached": {
        "kind": "control",
        "input": "JobsAttachDetachedRequest",
        "output": "DetachedAcceptance",
        "inputTypeId": "agh.jobs/attachDetached.request@1",
        "outputTypeId": "agh.jobs/attachDetached.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "cancelDetached": {
        "kind": "control",
        "input": "JobsCancelDetachedRequest",
        "output": "DetachedAcceptance",
        "inputTypeId": "agh.jobs/cancelDetached.request@1",
        "outputTypeId": "agh.jobs/cancelDetached.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "inspect": {
        "kind": "query",
        "input": "JobsInspectRequest",
        "output": "JobsInspectResult",
        "inputTypeId": "agh.jobs/inspect.request@1",
        "outputTypeId": "agh.jobs/inspect.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "createDefinition": {
        "kind": "control",
        "input": "JobsCreateDefinitionRequest",
        "output": "JobDefinition",
        "inputTypeId": "agh.jobs/createDefinition.request@1",
        "outputTypeId": "agh.jobs/createDefinition.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "updateDefinition": {
        "kind": "control",
        "input": "JobsUpdateDefinitionRequest",
        "output": "JobDefinition",
        "inputTypeId": "agh.jobs/updateDefinition.request@1",
        "outputTypeId": "agh.jobs/updateDefinition.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "cancelDefinition": {
        "kind": "control",
        "input": "JobsCancelDefinitionRequest",
        "output": "JobsRequestCancelResult",
        "inputTypeId": "agh.jobs/cancelDefinition.request@1",
        "outputTypeId": "agh.jobs/cancelDefinition.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "enqueueClientJob": {
        "kind": "control",
        "input": "SessionJobsClientEnqueueRequest",
        "output": "SessionJobsClientEnqueueResult",
        "inputTypeId": "agh.jobs/enqueueClientJob.request@1",
        "outputTypeId": "agh.jobs/enqueueClientJob.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "pollClientJob": {
        "kind": "query",
        "input": "SessionJobsClientPollRequest",
        "output": "JobStatus",
        "inputTypeId": "agh.jobs/pollClientJob.request@1",
        "outputTypeId": "agh.jobs/pollClientJob.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "cancelClientJob": {
        "kind": "control",
        "input": "SessionJobsClientCancelRequest",
        "output": "SessionJobsClientCancelResult",
        "inputTypeId": "agh.jobs/cancelClientJob.request@1",
        "outputTypeId": "agh.jobs/cancelClientJob.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "acceptCreateDefinition": {
        "kind": "control",
        "input": "SessionJobsClientCreateRequest",
        "output": "CommandHandle",
        "inputTypeId": "agh.jobs/acceptCreateDefinition.request@1",
        "outputTypeId": "agh.jobs/acceptCreateDefinition.response@1",
        "sameAttemptBrokerAllowed": false,
        "completion": "domain-commit"
      },
      "acceptUpdateDefinition": {
        "kind": "control",
        "input": "SessionJobsClientUpdateRequest",
        "output": "CommandHandle",
        "inputTypeId": "agh.jobs/acceptUpdateDefinition.request@1",
        "outputTypeId": "agh.jobs/acceptUpdateDefinition.response@1",
        "sameAttemptBrokerAllowed": false,
        "completion": "domain-commit"
      },
      "acceptCancelDefinition": {
        "kind": "control",
        "input": "SessionJobsClientCancelDefinitionRequest",
        "output": "CommandHandle",
        "inputTypeId": "agh.jobs/acceptCancelDefinition.request@1",
        "outputTypeId": "agh.jobs/acceptCancelDefinition.response@1",
        "sameAttemptBrokerAllowed": false,
        "completion": "runtime-accepted"
      },
      "clientCommandStatus": {
        "kind": "query",
        "input": "Id",
        "output": "CommandHandle",
        "inputTypeId": "agh.jobs/clientCommandStatus.request@1",
        "outputTypeId": "agh.jobs/clientCommandStatus.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.jobs/authorityFence.request@1",
        "outputTypeId": "agh.jobs/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.jobs/authorityExport.request@1",
        "outputTypeId": "agh.jobs/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.jobs/authorityExportPage.request@1",
        "outputTypeId": "agh.jobs/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.jobs/authorityImport.request@1",
        "outputTypeId": "agh.jobs/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.jobs/authorityVerify.request@1",
        "outputTypeId": "agh.jobs/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.jobs/authorityActivate.request@1",
        "outputTypeId": "agh.jobs/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.jobs/authorityAbort.request@1",
        "outputTypeId": "agh.jobs/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.jobs/authorityProbe.request@1",
        "outputTypeId": "agh.jobs/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.artifacts/reserve.response@1",
        "sameAttemptBrokerAllowed": false,
        "requiredFeature": "artifact-publication.v1"
      },
      "publish": {
        "kind": "action",
        "input": "ArtifactsPublishRequest",
        "output": "ArtifactReservation",
        "inputTypeId": "agh.artifacts/publish.request@1",
        "outputTypeId": "agh.artifacts/publish.response@1",
        "sameAttemptBrokerAllowed": false,
        "requiredFeature": "artifact-publication.v1"
      },
      "revoke": {
        "kind": "action",
        "input": "ArtifactsRevokeRequest",
        "output": "ArtifactReservation",
        "inputTypeId": "agh.artifacts/revoke.request@1",
        "outputTypeId": "agh.artifacts/revoke.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "query": {
        "kind": "query",
        "input": "ArtifactsQueryRequest",
        "output": "ArtifactViewRef",
        "inputTypeId": "agh.artifacts/query.request@1",
        "outputTypeId": "agh.artifacts/query.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "describe": {
        "local": true,
        "localInterface": "ArtifactAccessPort",
        "localMethod": "describe",
        "sameAttemptBrokerAllowed": false,
        "kind": "query",
        "requiredFeature": "artifact-access.v1"
      },
      "openDownload": {
        "local": true,
        "localInterface": "ArtifactAccessPort",
        "localMethod": "openDownload",
        "sameAttemptBrokerAllowed": false,
        "kind": "control",
        "requiredFeature": "artifact-access.v1"
      },
      "readRange": {
        "local": true,
        "localInterface": "ArtifactAccessPort",
        "localMethod": "readRange",
        "sameAttemptBrokerAllowed": false,
        "kind": "query",
        "requiredFeature": "artifact-access.v1"
      },
      "openStream": {
        "local": true,
        "localInterface": "ArtifactAccessPort",
        "localMethod": "openStream",
        "sameAttemptBrokerAllowed": false,
        "kind": "query",
        "requiredFeature": "artifact-access.v1"
      },
      "followDownload": {
        "local": true,
        "localInterface": "ArtifactClient",
        "localMethod": "followDownload",
        "sameAttemptBrokerAllowed": false,
        "clientOnly": true
      },
      "fail": {
        "kind": "action",
        "input": "ArtifactsFailRequest",
        "output": "ArtifactReservation",
        "inputTypeId": "agh.artifacts/fail.request@1",
        "outputTypeId": "agh.artifacts/fail.response@1",
        "requiredFeature": "artifact-publication.v1",
        "sameAttemptBrokerAllowed": false
      },
      "grant": {
        "kind": "action",
        "input": "ArtifactsGrantRequest",
        "output": "ArtifactAccessGrantValue",
        "inputTypeId": "agh.artifacts/grant.request@1",
        "outputTypeId": "agh.artifacts/grant.response@1",
        "requiredFeature": "artifact-publication.v1",
        "sameAttemptBrokerAllowed": false
      },
      "revokeGrant": {
        "kind": "action",
        "input": "ArtifactsRevokeGrantRequest",
        "output": "ArtifactAccessGrantValue",
        "inputTypeId": "agh.artifacts/revokeGrant.request@1",
        "outputTypeId": "agh.artifacts/revokeGrant.response@1",
        "requiredFeature": "artifact-publication.v1",
        "sameAttemptBrokerAllowed": false
      },
      "redeemDownload": {
        "local": true,
        "localInterface": "ArtifactAccessPort",
        "localMethod": "redeemDownload",
        "kind": "query",
        "requiredFeature": "artifact-ticket.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.artifacts/authorityFence.request@1",
        "outputTypeId": "agh.artifacts/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.artifacts/authorityExport.request@1",
        "outputTypeId": "agh.artifacts/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.artifacts/authorityExportPage.request@1",
        "outputTypeId": "agh.artifacts/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.artifacts/authorityImport.request@1",
        "outputTypeId": "agh.artifacts/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.artifacts/authorityVerify.request@1",
        "outputTypeId": "agh.artifacts/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.artifacts/authorityActivate.request@1",
        "outputTypeId": "agh.artifacts/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.artifacts/authorityAbort.request@1",
        "outputTypeId": "agh.artifacts/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.artifacts/authorityProbe.request@1",
        "outputTypeId": "agh.artifacts/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.blob/stage.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "promote": {
        "kind": "action",
        "input": "BlobPromoteRequest",
        "output": "StagedBlobRef",
        "inputTypeId": "agh.blob/promote.request@1",
        "outputTypeId": "agh.blob/promote.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "pin": {
        "kind": "action",
        "input": "BlobPinRequest",
        "output": "BlobRef",
        "inputTypeId": "agh.blob/pin.request@1",
        "outputTypeId": "agh.blob/pin.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "unpin": {
        "kind": "action",
        "input": "BlobUnpinRequest",
        "output": "BlobUnpinResult",
        "inputTypeId": "agh.blob/unpin.request@1",
        "outputTypeId": "agh.blob/unpin.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "gc": {
        "kind": "action",
        "input": "BlobGcRequest",
        "output": "BlobGcResult",
        "inputTypeId": "agh.blob/gc.request@1",
        "outputTypeId": "agh.blob/gc.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "inspect": {
        "kind": "query",
        "input": "BlobInspectRequest",
        "output": "BlobInspectResult",
        "inputTypeId": "agh.blob/inspect.request@1",
        "outputTypeId": "agh.blob/inspect.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "readRange": {
        "kind": "query",
        "local": true,
        "localInterface": "BlobReadPort",
        "localMethod": "readRange",
        "requiredFeature": "blob-read.v1",
        "sameAttemptBrokerAllowed": false
      },
      "openRead": {
        "kind": "query",
        "local": true,
        "localInterface": "BlobReadPort",
        "localMethod": "openRead",
        "requiredFeature": "blob-read.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.blob/authorityFence.request@1",
        "outputTypeId": "agh.blob/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.blob/authorityExport.request@1",
        "outputTypeId": "agh.blob/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.blob/authorityExportPage.request@1",
        "outputTypeId": "agh.blob/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.blob/authorityImport.request@1",
        "outputTypeId": "agh.blob/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.blob/authorityVerify.request@1",
        "outputTypeId": "agh.blob/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.blob/authorityActivate.request@1",
        "outputTypeId": "agh.blob/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.blob/authorityAbort.request@1",
        "outputTypeId": "agh.blob/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.blob/authorityProbe.request@1",
        "outputTypeId": "agh.blob/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.budget/reserve.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "settle": {
        "kind": "control",
        "input": "BudgetSettleRequest",
        "output": "BudgetSettleResult",
        "inputTypeId": "agh.budget/settle.request@1",
        "outputTypeId": "agh.budget/settle.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "reconcile": {
        "kind": "control",
        "input": "BudgetReconcileRequest",
        "output": "BudgetReconcileResult",
        "inputTypeId": "agh.budget/reconcile.request@1",
        "outputTypeId": "agh.budget/reconcile.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "reserveQuota": {
        "kind": "control",
        "input": "BudgetReserveQuotaRequest",
        "output": "QuotaReservation",
        "inputTypeId": "agh.budget/reserveQuota.request@1",
        "outputTypeId": "agh.budget/reserveQuota.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "releaseQuota": {
        "kind": "control",
        "input": "BudgetReleaseQuotaRequest",
        "output": "QuotaReservation",
        "inputTypeId": "agh.budget/releaseQuota.request@1",
        "outputTypeId": "agh.budget/releaseQuota.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "readSessionBudget": {
        "kind": "query",
        "input": "SessionBudgetClientReadRequest",
        "output": "SessionBudgetResult",
        "inputTypeId": "agh.budget/readSessionBudget.request@1",
        "outputTypeId": "agh.budget/readSessionBudget.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.budget/authorityFence.request@1",
        "outputTypeId": "agh.budget/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.budget/authorityExport.request@1",
        "outputTypeId": "agh.budget/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.budget/authorityExportPage.request@1",
        "outputTypeId": "agh.budget/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.budget/authorityImport.request@1",
        "outputTypeId": "agh.budget/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.budget/authorityVerify.request@1",
        "outputTypeId": "agh.budget/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.budget/authorityActivate.request@1",
        "outputTypeId": "agh.budget/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.budget/authorityAbort.request@1",
        "outputTypeId": "agh.budget/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.budget/authorityProbe.request@1",
        "outputTypeId": "agh.budget/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.usage/record.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "query": {
        "kind": "query",
        "input": "UsageQueryRequest",
        "output": "UsageQueryResult",
        "inputTypeId": "agh.usage/query.request@1",
        "outputTypeId": "agh.usage/query.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.usage/authorityFence.request@1",
        "outputTypeId": "agh.usage/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.usage/authorityExport.request@1",
        "outputTypeId": "agh.usage/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.usage/authorityExportPage.request@1",
        "outputTypeId": "agh.usage/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.usage/authorityImport.request@1",
        "outputTypeId": "agh.usage/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.usage/authorityVerify.request@1",
        "outputTypeId": "agh.usage/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.usage/authorityActivate.request@1",
        "outputTypeId": "agh.usage/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.usage/authorityAbort.request@1",
        "outputTypeId": "agh.usage/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.usage/authorityProbe.request@1",
        "outputTypeId": "agh.usage/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.pricing/quote.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.pricing/authorityFence.request@1",
        "outputTypeId": "agh.pricing/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.pricing/authorityExport.request@1",
        "outputTypeId": "agh.pricing/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.pricing/authorityExportPage.request@1",
        "outputTypeId": "agh.pricing/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.pricing/authorityImport.request@1",
        "outputTypeId": "agh.pricing/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.pricing/authorityVerify.request@1",
        "outputTypeId": "agh.pricing/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.pricing/authorityActivate.request@1",
        "outputTypeId": "agh.pricing/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.pricing/authorityAbort.request@1",
        "outputTypeId": "agh.pricing/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.pricing/authorityProbe.request@1",
        "outputTypeId": "agh.pricing/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.billing/post.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "refund": {
        "kind": "action",
        "input": "BillingRefundRequest",
        "output": "BillingEntry",
        "inputTypeId": "agh.billing/refund.request@1",
        "outputTypeId": "agh.billing/refund.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "reconcile": {
        "kind": "action",
        "input": "BillingReconcileRequest",
        "output": "BillingEntry",
        "inputTypeId": "agh.billing/reconcile.request@1",
        "outputTypeId": "agh.billing/reconcile.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.billing/authorityFence.request@1",
        "outputTypeId": "agh.billing/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.billing/authorityExport.request@1",
        "outputTypeId": "agh.billing/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.billing/authorityExportPage.request@1",
        "outputTypeId": "agh.billing/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.billing/authorityImport.request@1",
        "outputTypeId": "agh.billing/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.billing/authorityVerify.request@1",
        "outputTypeId": "agh.billing/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.billing/authorityActivate.request@1",
        "outputTypeId": "agh.billing/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.billing/authorityAbort.request@1",
        "outputTypeId": "agh.billing/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.billing/authorityProbe.request@1",
        "outputTypeId": "agh.billing/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.audit/append.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "export": {
        "kind": "action",
        "input": "AuditExportRequest",
        "output": "AuditExportResult",
        "inputTypeId": "agh.audit/export.request@1",
        "outputTypeId": "agh.audit/export.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.audit/authorityFence.request@1",
        "outputTypeId": "agh.audit/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.audit/authorityExport.request@1",
        "outputTypeId": "agh.audit/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.audit/authorityExportPage.request@1",
        "outputTypeId": "agh.audit/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.audit/authorityImport.request@1",
        "outputTypeId": "agh.audit/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.audit/authorityVerify.request@1",
        "outputTypeId": "agh.audit/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.audit/authorityActivate.request@1",
        "outputTypeId": "agh.audit/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.audit/authorityAbort.request@1",
        "outputTypeId": "agh.audit/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.audit/authorityProbe.request@1",
        "outputTypeId": "agh.audit/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.trace/record.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "export": {
        "kind": "action",
        "input": "TelemetryExportRequest",
        "output": "TelemetryExportResult",
        "inputTypeId": "agh.trace/export.request@1",
        "outputTypeId": "agh.trace/export.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.trace/authorityFence.request@1",
        "outputTypeId": "agh.trace/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.trace/authorityExport.request@1",
        "outputTypeId": "agh.trace/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.trace/authorityExportPage.request@1",
        "outputTypeId": "agh.trace/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.trace/authorityImport.request@1",
        "outputTypeId": "agh.trace/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.trace/authorityVerify.request@1",
        "outputTypeId": "agh.trace/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.trace/authorityActivate.request@1",
        "outputTypeId": "agh.trace/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.trace/authorityAbort.request@1",
        "outputTypeId": "agh.trace/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.trace/authorityProbe.request@1",
        "outputTypeId": "agh.trace/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.events/subscribe.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "publish": {
        "kind": "action",
        "input": "EventsPublishRequest",
        "output": "EventsPublishResult",
        "inputTypeId": "agh.events/publish.request@1",
        "outputTypeId": "agh.events/publish.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.events/authorityFence.request@1",
        "outputTypeId": "agh.events/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.events/authorityExport.request@1",
        "outputTypeId": "agh.events/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.events/authorityExportPage.request@1",
        "outputTypeId": "agh.events/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.events/authorityImport.request@1",
        "outputTypeId": "agh.events/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.events/authorityVerify.request@1",
        "outputTypeId": "agh.events/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.events/authorityActivate.request@1",
        "outputTypeId": "agh.events/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.events/authorityAbort.request@1",
        "outputTypeId": "agh.events/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.events/authorityProbe.request@1",
        "outputTypeId": "agh.events/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.projection/snapshot.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "changes": {
        "kind": "query",
        "input": "ProjectionChangesRequest",
        "output": "ProjectionChanges",
        "inputTypeId": "agh.projection/changes.request@1",
        "outputTypeId": "agh.projection/changes.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "command": {
        "kind": "action",
        "input": "DomainCommandRequest",
        "output": "CommandHandle",
        "inputTypeId": "agh.projection/command.request@1",
        "outputTypeId": "agh.projection/command.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "openConversation": {
        "kind": "query",
        "input": "ShellConversationClientOpenRequest",
        "output": "RuntimeConversationWindow",
        "inputTypeId": "agh.projection/openConversation.request@1",
        "outputTypeId": "agh.projection/openConversation.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "conversationHistory": {
        "kind": "query",
        "input": "ShellConversationClientHistoryRequest",
        "output": "RuntimeConversationWindow",
        "inputTypeId": "agh.projection/conversationHistory.request@1",
        "outputTypeId": "agh.projection/conversationHistory.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "acceptCommand": {
        "kind": "control",
        "input": "DomainCommandRequest",
        "output": "CommandHandle",
        "inputTypeId": "agh.projection/acceptCommand.request@1",
        "outputTypeId": "agh.projection/acceptCommand.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "commandStatus": {
        "kind": "query",
        "input": "DomainCommandClientCommandStatusRequest",
        "output": "CommandHandle",
        "inputTypeId": "agh.projection/commandStatus.request@1",
        "outputTypeId": "agh.projection/commandStatus.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "listConversations": {
        "kind": "query",
        "input": "ConversationListRequest",
        "output": "PageConversationSummary",
        "inputTypeId": "agh.projection/listConversations.request@1",
        "outputTypeId": "agh.projection/listConversations.response@1",
        "sameAttemptBrokerAllowed": false,
        "requiredFeature": "client-transport-wire.v2"
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.projection/authorityFence.request@1",
        "outputTypeId": "agh.projection/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.projection/authorityExport.request@1",
        "outputTypeId": "agh.projection/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.projection/authorityExportPage.request@1",
        "outputTypeId": "agh.projection/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.projection/authorityImport.request@1",
        "outputTypeId": "agh.projection/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.projection/authorityVerify.request@1",
        "outputTypeId": "agh.projection/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.projection/authorityActivate.request@1",
        "outputTypeId": "agh.projection/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.projection/authorityAbort.request@1",
        "outputTypeId": "agh.projection/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.projection/authorityProbe.request@1",
        "outputTypeId": "agh.projection/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.transport/handshake.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "connect": {
        "kind": "query",
        "input": "ClientHello",
        "output": "ClientWelcome",
        "inputTypeId": "agh.transport/connect.request@1",
        "outputTypeId": "agh.transport/connect.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "command": {
        "kind": "action",
        "input": "DomainCommandRequest",
        "output": "CommandHandle",
        "inputTypeId": "agh.transport/command.request@1",
        "outputTypeId": "agh.transport/command.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "bootstrap": {
        "kind": "ingress",
        "input": "ClientHello",
        "output": "ClientBootstrapResult",
        "inputTypeId": "agh.transport/bootstrap.request@1",
        "outputTypeId": "agh.transport/bootstrap.response@1",
        "sameAttemptBrokerAllowed": false,
        "requiredFeature": "client-transport-wire.v2"
      },
      "clientQuery": {
        "kind": "query",
        "input": "ClientQueryRequest",
        "output": "ClientQueryReply",
        "inputTypeId": "agh.transport/clientQuery.request@1",
        "outputTypeId": "agh.transport/clientQuery.response@1",
        "sameAttemptBrokerAllowed": false,
        "requiredFeature": "client-transport-wire.v2"
      },
      "clientCommand": {
        "kind": "ingress",
        "input": "ClientCommandRequest",
        "output": "ClientCommandReply",
        "inputTypeId": "agh.transport/clientCommand.request@1",
        "outputTypeId": "agh.transport/clientCommand.response@1",
        "sameAttemptBrokerAllowed": false,
        "requiredFeature": "client-transport-wire.v2"
      },
      "catalogPage": {
        "kind": "query",
        "input": "ClientCatalogPageRequest",
        "output": "ClientCatalogPageResult",
        "inputTypeId": "agh.transport/catalogPage.request@1",
        "outputTypeId": "agh.transport/catalogPage.response@1",
        "sameAttemptBrokerAllowed": false,
        "requiredFeature": "client-transport-wire.v2"
      },
      "subscribe": {
        "kind": "query",
        "input": "ClientSubscribeRequest",
        "output": "ClientSubscribeResult",
        "inputTypeId": "agh.transport/subscribe.request@1",
        "outputTypeId": "agh.transport/subscribe.response@1",
        "sameAttemptBrokerAllowed": false,
        "requiredFeature": "client-transport-wire.v2"
      },
      "readSubscription": {
        "kind": "query",
        "input": "ClientReadSubscriptionRequest",
        "output": "ClientReadSubscriptionResult",
        "inputTypeId": "agh.transport/readSubscription.request@1",
        "outputTypeId": "agh.transport/readSubscription.response@1",
        "sameAttemptBrokerAllowed": false,
        "requiredFeature": "client-transport-wire.v2"
      },
      "closeSubscription": {
        "kind": "control",
        "input": "ClientCloseSubscriptionRequest",
        "output": "ClientCloseSubscriptionResult",
        "inputTypeId": "agh.transport/closeSubscription.request@1",
        "outputTypeId": "agh.transport/closeSubscription.response@1",
        "sameAttemptBrokerAllowed": false,
        "requiredFeature": "client-transport-wire.v2"
      },
      "catalogStatus": {
        "kind": "query",
        "input": "ClientCatalogStatusRequest",
        "output": "ClientCatalogStatusResult",
        "inputTypeId": "agh.transport/catalogStatus.request@1",
        "outputTypeId": "agh.transport/catalogStatus.response@1",
        "sameAttemptBrokerAllowed": false,
        "requiredFeature": "client-transport-wire.v2"
      },
      "streamStatus": {
        "kind": "query",
        "input": "ClientArtifactStreamStatusRequest",
        "output": "ClientArtifactStreamStatusResult",
        "inputTypeId": "agh.transport/streamStatus.request@1",
        "outputTypeId": "agh.transport/streamStatus.response@1",
        "sameAttemptBrokerAllowed": false,
        "requiredFeature": "client-transport-wire.v2"
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.transport/authorityFence.request@1",
        "outputTypeId": "agh.transport/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.transport/authorityExport.request@1",
        "outputTypeId": "agh.transport/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.transport/authorityExportPage.request@1",
        "outputTypeId": "agh.transport/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.transport/authorityImport.request@1",
        "outputTypeId": "agh.transport/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.transport/authorityVerify.request@1",
        "outputTypeId": "agh.transport/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.transport/authorityActivate.request@1",
        "outputTypeId": "agh.transport/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.transport/authorityAbort.request@1",
        "outputTypeId": "agh.transport/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.transport/authorityProbe.request@1",
        "outputTypeId": "agh.transport/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.channel/send.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "reconcile": {
        "kind": "action",
        "input": "ChannelReconcileRequest",
        "output": "ChannelDelivery",
        "inputTypeId": "agh.channel/reconcile.request@1",
        "outputTypeId": "agh.channel/reconcile.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "callback": {
        "kind": "ingress",
        "input": "ChannelCallbackRequest",
        "output": "ChannelCallbackResult",
        "inputTypeId": "agh.channel/callback.request@1",
        "outputTypeId": "agh.channel/callback.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.channel/authorityFence.request@1",
        "outputTypeId": "agh.channel/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.channel/authorityExport.request@1",
        "outputTypeId": "agh.channel/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.channel/authorityExportPage.request@1",
        "outputTypeId": "agh.channel/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.channel/authorityImport.request@1",
        "outputTypeId": "agh.channel/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.channel/authorityVerify.request@1",
        "outputTypeId": "agh.channel/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.channel/authorityActivate.request@1",
        "outputTypeId": "agh.channel/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.channel/authorityAbort.request@1",
        "outputTypeId": "agh.channel/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.channel/authorityProbe.request@1",
        "outputTypeId": "agh.channel/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.package-source/discover.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "resolveMetadata": {
        "kind": "query",
        "input": "PackageSourceResolveMetadataRequest",
        "output": "PackageSourceResolveMetadataResult",
        "inputTypeId": "agh.package-source/resolveMetadata.request@1",
        "outputTypeId": "agh.package-source/resolveMetadata.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "fetch": {
        "kind": "maintenance",
        "input": "PackageSourceFetchRequest",
        "output": "PackageSourceFetchResult",
        "inputTypeId": "agh.package-source/fetch.request@1",
        "outputTypeId": "agh.package-source/fetch.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "refreshCatalog": {
        "kind": "maintenance",
        "input": "PackageSourceRefreshCatalogRequest",
        "output": "PackageSourceRefreshCatalogResult",
        "inputTypeId": "agh.package-source/refreshCatalog.request@1",
        "outputTypeId": "agh.package-source/refreshCatalog.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.package-source/authorityFence.request@1",
        "outputTypeId": "agh.package-source/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.package-source/authorityExport.request@1",
        "outputTypeId": "agh.package-source/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.package-source/authorityExportPage.request@1",
        "outputTypeId": "agh.package-source/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.package-source/authorityImport.request@1",
        "outputTypeId": "agh.package-source/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.package-source/authorityVerify.request@1",
        "outputTypeId": "agh.package-source/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.package-source/authorityActivate.request@1",
        "outputTypeId": "agh.package-source/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.package-source/authorityAbort.request@1",
        "outputTypeId": "agh.package-source/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.package-source/authorityProbe.request@1",
        "outputTypeId": "agh.package-source/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.package-resolver/resolve.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.package-resolver/authorityFence.request@1",
        "outputTypeId": "agh.package-resolver/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.package-resolver/authorityExport.request@1",
        "outputTypeId": "agh.package-resolver/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.package-resolver/authorityExportPage.request@1",
        "outputTypeId": "agh.package-resolver/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.package-resolver/authorityImport.request@1",
        "outputTypeId": "agh.package-resolver/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.package-resolver/authorityVerify.request@1",
        "outputTypeId": "agh.package-resolver/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.package-resolver/authorityActivate.request@1",
        "outputTypeId": "agh.package-resolver/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.package-resolver/authorityAbort.request@1",
        "outputTypeId": "agh.package-resolver/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.package-resolver/authorityProbe.request@1",
        "outputTypeId": "agh.package-resolver/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.package-installer/prepare.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "activate": {
        "kind": "maintenance",
        "input": "PackageInstallerActivateRequest",
        "output": "PackageInstallerActivateResult",
        "inputTypeId": "agh.package-installer/activate.request@1",
        "outputTypeId": "agh.package-installer/activate.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "disable": {
        "kind": "maintenance",
        "input": "PackageInstallerDisableRequest",
        "output": "PackageInstallerDisableResult",
        "inputTypeId": "agh.package-installer/disable.request@1",
        "outputTypeId": "agh.package-installer/disable.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "repair": {
        "kind": "maintenance",
        "input": "PackageInstallerRepairRequest",
        "output": "MigrationReceipt",
        "inputTypeId": "agh.package-installer/repair.request@1",
        "outputTypeId": "agh.package-installer/repair.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "requestChange": {
        "kind": "action",
        "input": "ChangeProposalRequest",
        "output": "ChangeProposal",
        "inputTypeId": "agh.package-installer/requestChange.request@1",
        "outputTypeId": "agh.package-installer/requestChange.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "cancelProposal": {
        "kind": "action",
        "input": "PackageInstallerCancelProposalRequest",
        "output": "ChangeProposal",
        "inputTypeId": "agh.package-installer/cancelProposal.request@1",
        "outputTypeId": "agh.package-installer/cancelProposal.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "proposalStatus": {
        "kind": "query",
        "input": "PackageInstallerProposalStatusRequest",
        "output": "ChangeProposal",
        "inputTypeId": "agh.package-installer/proposalStatus.request@1",
        "outputTypeId": "agh.package-installer/proposalStatus.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "applyResourceChange": {
        "kind": "maintenance",
        "input": "PackageInstallerApplyResourceChangeRequest",
        "output": "PackageInstallerApplyResourceChangeResult",
        "inputTypeId": "agh.package-installer/applyResourceChange.request@1",
        "outputTypeId": "agh.package-installer/applyResourceChange.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.package-installer/authorityFence.request@1",
        "outputTypeId": "agh.package-installer/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.package-installer/authorityExport.request@1",
        "outputTypeId": "agh.package-installer/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.package-installer/authorityExportPage.request@1",
        "outputTypeId": "agh.package-installer/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.package-installer/authorityImport.request@1",
        "outputTypeId": "agh.package-installer/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.package-installer/authorityVerify.request@1",
        "outputTypeId": "agh.package-installer/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.package-installer/authorityActivate.request@1",
        "outputTypeId": "agh.package-installer/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.package-installer/authorityAbort.request@1",
        "outputTypeId": "agh.package-installer/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.package-installer/authorityProbe.request@1",
        "outputTypeId": "agh.package-installer/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.config/read.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "resolve": {
        "kind": "compute",
        "input": "ConfigResolveRequest",
        "output": "ConfigResolveResult",
        "inputTypeId": "agh.config/resolve.request@1",
        "outputTypeId": "agh.config/resolve.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.config/authorityFence.request@1",
        "outputTypeId": "agh.config/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.config/authorityExport.request@1",
        "outputTypeId": "agh.config/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.config/authorityExportPage.request@1",
        "outputTypeId": "agh.config/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.config/authorityImport.request@1",
        "outputTypeId": "agh.config/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.config/authorityVerify.request@1",
        "outputTypeId": "agh.config/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.config/authorityActivate.request@1",
        "outputTypeId": "agh.config/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.config/authorityAbort.request@1",
        "outputTypeId": "agh.config/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.config/authorityProbe.request@1",
        "outputTypeId": "agh.config/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.assembly/plan.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "prepare": {
        "kind": "maintenance",
        "input": "AssemblyPrepareRequest",
        "output": "AssemblyPrepareResult",
        "inputTypeId": "agh.assembly/prepare.request@1",
        "outputTypeId": "agh.assembly/prepare.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "publish": {
        "kind": "maintenance",
        "input": "AssemblyPublishRequest",
        "output": "AssemblyPublishResult",
        "inputTypeId": "agh.assembly/publish.request@1",
        "outputTypeId": "agh.assembly/publish.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "drain": {
        "kind": "maintenance",
        "input": "AssemblyDrainRequest",
        "output": "AssemblyDrainResult",
        "inputTypeId": "agh.assembly/drain.request@1",
        "outputTypeId": "agh.assembly/drain.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.assembly/authorityFence.request@1",
        "outputTypeId": "agh.assembly/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.assembly/authorityExport.request@1",
        "outputTypeId": "agh.assembly/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.assembly/authorityExportPage.request@1",
        "outputTypeId": "agh.assembly/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.assembly/authorityImport.request@1",
        "outputTypeId": "agh.assembly/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.assembly/authorityVerify.request@1",
        "outputTypeId": "agh.assembly/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.assembly/authorityActivate.request@1",
        "outputTypeId": "agh.assembly/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.assembly/authorityAbort.request@1",
        "outputTypeId": "agh.assembly/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.assembly/authorityProbe.request@1",
        "outputTypeId": "agh.assembly/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.migration/inspect.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "prepare": {
        "kind": "maintenance",
        "input": "MigrationPrepareRequest",
        "output": "MigrationPrepareResult",
        "inputTypeId": "agh.migration/prepare.request@1",
        "outputTypeId": "agh.migration/prepare.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "validate": {
        "kind": "maintenance",
        "input": "MigrationValidateRequest",
        "output": "MigrationValidateResult",
        "inputTypeId": "agh.migration/validate.request@1",
        "outputTypeId": "agh.migration/validate.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "cutover": {
        "kind": "maintenance",
        "input": "MigrationCutoverRequest",
        "output": "MigrationReceipt",
        "inputTypeId": "agh.migration/cutover.request@1",
        "outputTypeId": "agh.migration/cutover.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "probe": {
        "kind": "maintenance",
        "input": "MigrationProbeRequest",
        "output": "MigrationReceipt",
        "inputTypeId": "agh.migration/probe.request@1",
        "outputTypeId": "agh.migration/probe.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "abort": {
        "kind": "maintenance",
        "input": "MigrationAbortRequest",
        "output": "MigrationReceipt",
        "inputTypeId": "agh.migration/abort.request@1",
        "outputTypeId": "agh.migration/abort.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.migration/authorityFence.request@1",
        "outputTypeId": "agh.migration/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.migration/authorityExport.request@1",
        "outputTypeId": "agh.migration/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.migration/authorityExportPage.request@1",
        "outputTypeId": "agh.migration/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.migration/authorityImport.request@1",
        "outputTypeId": "agh.migration/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.migration/authorityVerify.request@1",
        "outputTypeId": "agh.migration/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.migration/authorityActivate.request@1",
        "outputTypeId": "agh.migration/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.migration/authorityAbort.request@1",
        "outputTypeId": "agh.migration/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.migration/authorityProbe.request@1",
        "outputTypeId": "agh.migration/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.integrity/verifyPackage.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "canonicalize": {
        "kind": "compute",
        "input": "IntegrityCanonicalizeRequest",
        "output": "IntegrityCanonicalizeResult",
        "inputTypeId": "agh.integrity/canonicalize.request@1",
        "outputTypeId": "agh.integrity/canonicalize.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "verify": {
        "kind": "compute",
        "input": "IntegrityVerifyRequest",
        "output": "IntegrityVerifyResult",
        "inputTypeId": "agh.integrity/verify.request@1",
        "outputTypeId": "agh.integrity/verify.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.integrity/authorityFence.request@1",
        "outputTypeId": "agh.integrity/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.integrity/authorityExport.request@1",
        "outputTypeId": "agh.integrity/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.integrity/authorityExportPage.request@1",
        "outputTypeId": "agh.integrity/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.integrity/authorityImport.request@1",
        "outputTypeId": "agh.integrity/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.integrity/authorityVerify.request@1",
        "outputTypeId": "agh.integrity/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.integrity/authorityActivate.request@1",
        "outputTypeId": "agh.integrity/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.integrity/authorityAbort.request@1",
        "outputTypeId": "agh.integrity/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.integrity/authorityProbe.request@1",
        "outputTypeId": "agh.integrity/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.authority-directory/read.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "transfer": {
        "kind": "maintenance",
        "input": "MigrationRequest",
        "output": "MigrationReceipt",
        "inputTypeId": "agh.authority-directory/transfer.request@1",
        "outputTypeId": "agh.authority-directory/transfer.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "compareAndSwap": {
        "kind": "maintenance",
        "input": "AuthorityDirectoryCompareAndSwapRequest",
        "output": "AuthorityDirectoryCompareAndSwapResult",
        "inputTypeId": "agh.authority-directory/compareAndSwap.request@1",
        "outputTypeId": "agh.authority-directory/compareAndSwap.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.authority-directory/authorityFence.request@1",
        "outputTypeId": "agh.authority-directory/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.authority-directory/authorityExport.request@1",
        "outputTypeId": "agh.authority-directory/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.authority-directory/authorityExportPage.request@1",
        "outputTypeId": "agh.authority-directory/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.authority-directory/authorityImport.request@1",
        "outputTypeId": "agh.authority-directory/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.authority-directory/authorityVerify.request@1",
        "outputTypeId": "agh.authority-directory/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.authority-directory/authorityActivate.request@1",
        "outputTypeId": "agh.authority-directory/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.authority-directory/authorityAbort.request@1",
        "outputTypeId": "agh.authority-directory/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.authority-directory/authorityProbe.request@1",
        "outputTypeId": "agh.authority-directory/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
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
        "outputTypeId": "agh.state/acceptServiceCommand.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "readServiceCommand": {
        "kind": "query",
        "input": "StateStoreControlReadServiceCommandRequest",
        "output": "StateStoreControlReadServiceCommandResult",
        "inputTypeId": "agh.state/readServiceCommand.request@1",
        "outputTypeId": "agh.state/readServiceCommand.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "importConversation": {
        "kind": "control",
        "input": "ConversationImportRequest",
        "output": "ConversationImportResult",
        "inputTypeId": "agh.state/importConversation.request@1",
        "outputTypeId": "agh.state/importConversation.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "probeConversationImport": {
        "kind": "query",
        "input": "Id",
        "output": "StateStoreControlProbeConversationImportResult",
        "inputTypeId": "agh.state/probeConversationImport.request@1",
        "outputTypeId": "agh.state/probeConversationImport.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "open": {
        "kind": "control",
        "input": "StateOpenRequest",
        "output": "StateOpenResult",
        "inputTypeId": "agh.state/open.request@1",
        "outputTypeId": "agh.state/open.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "lease": {
        "kind": "control",
        "input": "StateLeaseRequest",
        "output": "StateLeaseResult",
        "inputTypeId": "agh.state/lease.request@1",
        "outputTypeId": "agh.state/lease.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "createChild": {
        "kind": "control",
        "input": "ChildCreateRequest",
        "output": "StateOpenResult",
        "inputTypeId": "agh.state/createChild.request@1",
        "outputTypeId": "agh.state/createChild.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "admitInvocation": {
        "kind": "control",
        "input": "InvocationAdmission",
        "output": "AdmitInvocationResult",
        "inputTypeId": "agh.state/admitInvocation.request@1",
        "outputTypeId": "agh.state/admitInvocation.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "admitQuery": {
        "kind": "control",
        "input": "QueryAdmission",
        "output": "AdmitQueryResult",
        "inputTypeId": "agh.state/admitQuery.request@1",
        "outputTypeId": "agh.state/admitQuery.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "closeInvocation": {
        "kind": "control",
        "input": "CloseInvocationRequest",
        "output": "CloseInvocationResult",
        "inputTypeId": "agh.state/closeInvocation.request@1",
        "outputTypeId": "agh.state/closeInvocation.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "dispatchAdmission": {
        "kind": "control",
        "input": "DispatchAdmissionRequest",
        "output": "DispatchAdmissionResult",
        "inputTypeId": "agh.state/dispatchAdmission.request@1",
        "outputTypeId": "agh.state/dispatchAdmission.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "probeDispatchAdmission": {
        "kind": "query",
        "input": "Id",
        "output": "DispatchAdmissionProbe",
        "inputTypeId": "agh.state/probeDispatchAdmission.request@1",
        "outputTypeId": "agh.state/probeDispatchAdmission.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "pruneRecordVersions": {
        "kind": "maintenance",
        "input": "PruneRecordVersionsRequest",
        "output": "PruneRecordVersionsResult",
        "inputTypeId": "agh.state/pruneRecordVersions.request@1",
        "outputTypeId": "agh.state/pruneRecordVersions.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "commitControl": {
        "kind": "control",
        "input": "CommitControlRequest",
        "output": "StateCommitReceipt",
        "inputTypeId": "agh.state/commitControl.request@1",
        "outputTypeId": "agh.state/commitControl.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "createRun": {
        "kind": "control",
        "input": "RunAdmission",
        "output": "AdmissionProbe",
        "inputTypeId": "agh.state/createRun.request@1",
        "outputTypeId": "agh.state/createRun.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "probeAdmission": {
        "kind": "query",
        "input": "Id",
        "output": "AdmissionProbe",
        "inputTypeId": "agh.state/probeAdmission.request@1",
        "outputTypeId": "agh.state/probeAdmission.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "cancelPreparedActionAdmission": {
        "kind": "control",
        "input": "StateStoreControlCancelPreparedActionAdmissionRequest",
        "output": "PreparedActionAdmissionProbe",
        "inputTypeId": "agh.state/cancelPreparedActionAdmission.request@1",
        "outputTypeId": "agh.state/cancelPreparedActionAdmission.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "probePreparedActionAdmission": {
        "kind": "query",
        "input": "StateStoreControlProbePreparedActionAdmissionRequest",
        "output": "PreparedActionAdmissionProbe",
        "inputTypeId": "agh.state/probePreparedActionAdmission.request@1",
        "outputTypeId": "agh.state/probePreparedActionAdmission.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "readSessionControl": {
        "kind": "query",
        "input": "StateStoreControlReadSessionControlRequest",
        "output": "SessionControlState",
        "inputTypeId": "agh.state/readSessionControl.request@1",
        "outputTypeId": "agh.state/readSessionControl.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "submitSessionControl": {
        "kind": "control",
        "input": "SessionControlRequest",
        "output": "SessionControlResult",
        "inputTypeId": "agh.state/submitSessionControl.request@1",
        "outputTypeId": "agh.state/submitSessionControl.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "sessionControlStatus": {
        "kind": "control",
        "input": "StateStoreControlSessionControlStatusRequest",
        "output": "StateStoreControlSessionControlStatusResult",
        "inputTypeId": "agh.state/sessionControlStatus.request@1",
        "outputTypeId": "agh.state/sessionControlStatus.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "acceptInbox": {
        "kind": "control",
        "input": "SignalDelivery",
        "output": "SignalIntakeReceipt",
        "inputTypeId": "agh.state/acceptInbox.request@1",
        "outputTypeId": "agh.state/acceptInbox.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "fireTimer": {
        "kind": "control",
        "input": "StateStoreControlFireTimerRequest",
        "output": "SignalIntakeReceipt",
        "inputTypeId": "agh.state/fireTimer.request@1",
        "outputTypeId": "agh.state/fireTimer.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "registerStream": {
        "kind": "control",
        "input": "StreamRegistration",
        "output": "StateStoreControlRegisterStreamResult",
        "inputTypeId": "agh.state/registerStream.request@1",
        "outputTypeId": "agh.state/registerStream.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "appendStream": {
        "kind": "control",
        "input": "StateStoreControlAppendStreamRequest",
        "output": "StateStoreControlAppendStreamResult",
        "inputTypeId": "agh.state/appendStream.request@1",
        "outputTypeId": "agh.state/appendStream.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "claimOutbox": {
        "kind": "control",
        "input": "ClaimOutboxRequest",
        "output": "ClaimOutboxResult",
        "inputTypeId": "agh.state/claimOutbox.request@1",
        "outputTypeId": "agh.state/claimOutbox.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "ackOutbox": {
        "kind": "control",
        "input": "AckOutboxRequest",
        "output": "AckOutboxResult",
        "inputTypeId": "agh.state/ackOutbox.request@1",
        "outputTypeId": "agh.state/ackOutbox.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "failOutbox": {
        "kind": "control",
        "input": "FailOutboxRequest",
        "output": "FailOutboxResult",
        "inputTypeId": "agh.state/failOutbox.request@1",
        "outputTypeId": "agh.state/failOutbox.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "beginReconciliation": {
        "kind": "control",
        "input": "StateStoreControlBeginReconciliationRequest",
        "output": "ReconciliationCheckValue",
        "inputTypeId": "agh.state/beginReconciliation.request@1",
        "outputTypeId": "agh.state/beginReconciliation.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "completeReconciliation": {
        "kind": "control",
        "input": "StateStoreControlCompleteReconciliationRequest",
        "output": "ReconciliationCheckValue",
        "inputTypeId": "agh.state/completeReconciliation.request@1",
        "outputTypeId": "agh.state/completeReconciliation.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "advanceRun": {
        "kind": "control",
        "input": "AdvanceRunRequest",
        "output": "StateCommitReceipt",
        "inputTypeId": "agh.state/advanceRun.request@1",
        "outputTypeId": "agh.state/advanceRun.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "advanceProvider": {
        "kind": "control",
        "input": "AdvanceProviderRequest",
        "output": "StateCommitReceipt",
        "inputTypeId": "agh.state/advanceProvider.request@1",
        "outputTypeId": "agh.state/advanceProvider.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "intakeReceipt": {
        "kind": "control",
        "input": "ReceiptIntakeRequest",
        "output": "ReceiptIntakeResult",
        "inputTypeId": "agh.state/intakeReceipt.request@1",
        "outputTypeId": "agh.state/intakeReceipt.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "publishActionResult": {
        "kind": "control",
        "input": "ResultVisibilityCommit",
        "output": "PublishActionResultResult",
        "inputTypeId": "agh.state/publishActionResult.request@1",
        "outputTypeId": "agh.state/publishActionResult.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "probeActionResult": {
        "kind": "query",
        "input": "ProbeActionResultRequest",
        "output": "ProbeActionResultResult",
        "inputTypeId": "agh.state/probeActionResult.request@1",
        "outputTypeId": "agh.state/probeActionResult.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "acceptBridgeChild": {
        "kind": "control",
        "input": "LegacyBridgeRequest",
        "output": "StateStoreControlAcceptBridgeChildResult",
        "inputTypeId": "agh.state/acceptBridgeChild.request@1",
        "outputTypeId": "agh.state/acceptBridgeChild.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "probeBridgeChild": {
        "kind": "query",
        "input": "StateStoreControlProbeBridgeChildRequest",
        "output": "StateStoreControlProbeBridgeChildResult",
        "inputTypeId": "agh.state/probeBridgeChild.request@1",
        "outputTypeId": "agh.state/probeBridgeChild.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "beginMigration": {
        "kind": "control",
        "input": "StateStoreControlBeginMigrationRequest",
        "output": "MigrationToken",
        "inputTypeId": "agh.state/beginMigration.request@1",
        "outputTypeId": "agh.state/beginMigration.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "commitMigratedRun": {
        "kind": "control",
        "input": "StateStoreControlCommitMigratedRunRequest",
        "output": "StateCommitReceipt",
        "inputTypeId": "agh.state/commitMigratedRun.request@1",
        "outputTypeId": "agh.state/commitMigratedRun.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "abortMigration": {
        "kind": "control",
        "input": "StateStoreControlAbortMigrationRequest",
        "output": "StateCommitReceipt",
        "inputTypeId": "agh.state/abortMigration.request@1",
        "outputTypeId": "agh.state/abortMigration.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "probeMigration": {
        "kind": "query",
        "input": "Id",
        "output": "MigrationProbe",
        "inputTypeId": "agh.state/probeMigration.request@1",
        "outputTypeId": "agh.state/probeMigration.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "cancelAdmission": {
        "kind": "control",
        "input": "StateCancelAdmissionRequest",
        "output": "AdmissionProbe",
        "inputTypeId": "agh.state/cancelAdmission.request@1",
        "outputTypeId": "agh.state/cancelAdmission.response@1",
        "sameAttemptBrokerAllowed": false
      },
      "deadLetters": {
        "kind": "query",
        "input": "OutboxDeadLettersRequest",
        "output": "PageOutboxDeadLetterItem",
        "inputTypeId": "agh.state/deadLetters.request@1",
        "outputTypeId": "agh.state/deadLetters.response@1",
        "requiredFeature": "outbox-administration.v1",
        "sameAttemptBrokerAllowed": false
      },
      "redriveOutbox": {
        "kind": "control",
        "input": "OutboxRedriveRequest",
        "output": "OutboxRedriveResult",
        "inputTypeId": "agh.state/redriveOutbox.request@1",
        "outputTypeId": "agh.state/redriveOutbox.response@1",
        "requiredFeature": "outbox-administration.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityFence": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlFenceRequest",
        "output": "AuthorityFence",
        "inputTypeId": "agh.state/authorityFence.request@1",
        "outputTypeId": "agh.state/authorityFence.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportRequest",
        "output": "AuthorityExport",
        "inputTypeId": "agh.state/authorityExport.request@1",
        "outputTypeId": "agh.state/authorityExport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityExportPage": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlExportPageRequest",
        "output": "AuthorityTransferControlExportPageResult",
        "inputTypeId": "agh.state/authorityExportPage.request@1",
        "outputTypeId": "agh.state/authorityExportPage.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityImport": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlImportRequest",
        "output": "AuthorityTransferControlImportResult",
        "inputTypeId": "agh.state/authorityImport.request@1",
        "outputTypeId": "agh.state/authorityImport.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityVerify": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlVerifyRequest",
        "output": "MigrationValidation",
        "inputTypeId": "agh.state/authorityVerify.request@1",
        "outputTypeId": "agh.state/authorityVerify.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityActivate": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlActivateRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.state/authorityActivate.request@1",
        "outputTypeId": "agh.state/authorityActivate.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityAbort": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlAbortRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.state/authorityAbort.request@1",
        "outputTypeId": "agh.state/authorityAbort.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      },
      "authorityProbe": {
        "kind": "maintenance",
        "input": "AuthorityTransferControlProbeRequest",
        "output": "AuthorityTransferProbe",
        "inputTypeId": "agh.state/authorityProbe.request@1",
        "outputTypeId": "agh.state/authorityProbe.response@1",
        "requiredFeature": "authority-transfer.v1",
        "sameAttemptBrokerAllowed": false
      }
    }
  },
  "agh.ui-registry": {
    "major": 1,
    "methods": {
      "register": {
        "local": true,
        "localInterface": "UIRegistry",
        "localMethod": "register",
        "sameAttemptBrokerAllowed": false
      },
      "resolve": {
        "local": true,
        "localInterface": "UIRegistry",
        "localMethod": "resolve",
        "sameAttemptBrokerAllowed": false
      },
      "bindRenderer": {
        "local": true,
        "localInterface": "UIRegistryHost",
        "localMethod": "bindRenderer",
        "sameAttemptBrokerAllowed": false
      }
    }
  },
  "agh.renderer": {
    "major": 1,
    "methods": {
      "component": {
        "local": true,
        "localInterface": "WebRendererDefinition",
        "localMethod": "component",
        "sameAttemptBrokerAllowed": false
      },
      "format": {
        "local": true,
        "localInterface": "TextRenderer",
        "localMethod": "format",
        "sameAttemptBrokerAllowed": false
      },
      "encode": {
        "local": true,
        "localInterface": "IMRenderer",
        "localMethod": "encode",
        "sameAttemptBrokerAllowed": false
      },
      "present": {
        "local": true,
        "localInterface": "RendererHandle",
        "localMethod": "present",
        "sameAttemptBrokerAllowed": false
      },
      "dispose": {
        "local": true,
        "localInterface": "RendererHandle",
        "localMethod": "dispose",
        "sameAttemptBrokerAllowed": false
      },
      "domain": {
        "local": true,
        "localInterface": "ClientPresentation",
        "localMethod": "domain",
        "sameAttemptBrokerAllowed": false
      },
      "legacySlot": {
        "local": true,
        "localInterface": "ClientPresentation",
        "localMethod": "legacySlot",
        "sameAttemptBrokerAllowed": false
      }
    }
  },
  "agh.shell": {
    "major": 1,
    "methods": {
      "mount": {
        "local": true,
        "localInterface": "ShellProvider",
        "localMethod": "mount",
        "sameAttemptBrokerAllowed": false
      },
      "update": {
        "local": true,
        "localInterface": "ShellProvider",
        "localMethod": "update",
        "sameAttemptBrokerAllowed": false
      },
      "exportState": {
        "local": true,
        "localInterface": "ShellProvider",
        "localMethod": "exportState",
        "sameAttemptBrokerAllowed": false
      },
      "importState": {
        "local": true,
        "localInterface": "ShellProvider",
        "localMethod": "importState",
        "sameAttemptBrokerAllowed": false
      },
      "stopAdmission": {
        "local": true,
        "localInterface": "ShellProvider",
        "localMethod": "stopAdmission",
        "sameAttemptBrokerAllowed": false
      },
      "dispose": {
        "local": true,
        "localInterface": "ShellProvider",
        "localMethod": "dispose",
        "sameAttemptBrokerAllowed": false
      },
      "create": {
        "local": true,
        "localInterface": "ShellConversationClient",
        "localMethod": "create",
        "sameAttemptBrokerAllowed": false
      },
      "open": {
        "local": true,
        "localInterface": "ShellConversationClient",
        "localMethod": "open",
        "sameAttemptBrokerAllowed": false
      },
      "history": {
        "local": true,
        "localInterface": "ShellConversationClient",
        "localMethod": "history",
        "sameAttemptBrokerAllowed": false
      },
      "submit": {
        "local": true,
        "localInterface": "ShellConversationClient",
        "localMethod": "submit",
        "sameAttemptBrokerAllowed": false
      },
      "cancel": {
        "local": true,
        "localInterface": "ShellConversationClient",
        "localMethod": "cancel",
        "sameAttemptBrokerAllowed": false
      },
      "query": {
        "local": true,
        "localInterface": "ShellDomainClient",
        "localMethod": "query",
        "sameAttemptBrokerAllowed": false
      },
      "navigate": {
        "local": true,
        "localInterface": "ShellServices",
        "localMethod": "navigate",
        "sameAttemptBrokerAllowed": false
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
export const RuntimeAuthorityTransferAPI = Object.freeze({"feature": "authority-transfer.v1", "contracts": Object.freeze(["agh.agents", "agh.artifacts", "agh.assembly", "agh.audit", "agh.authority-directory", "agh.billing", "agh.blob", "agh.budget", "agh.channel", "agh.compaction", "agh.config", "agh.context", "agh.effects", "agh.embedding", "agh.events", "agh.exec", "agh.files", "agh.identity", "agh.integrity", "agh.interaction", "agh.jobs", "agh.loop", "agh.mcp", "agh.media", "agh.memory", "agh.migration", "agh.model", "agh.model-adapter", "agh.network", "agh.package-installer", "agh.package-resolver", "agh.package-source", "agh.policy", "agh.pricing", "agh.projection", "agh.recovery", "agh.resources", "agh.retrieval", "agh.routing", "agh.sandbox", "agh.scheduler", "agh.secrets", "agh.state", "agh.supervisor", "agh.tools", "agh.trace", "agh.transport", "agh.usage", "agh.workspace"] as const), "methods": Object.freeze({"fence": Object.freeze({"backendMethod": "authorityFence", "input": "AuthorityTransferControlFenceRequest", "output": "AuthorityFence"} as const), "export": Object.freeze({"backendMethod": "authorityExport", "input": "AuthorityTransferControlExportRequest", "output": "AuthorityExport"} as const), "exportPage": Object.freeze({"backendMethod": "authorityExportPage", "input": "AuthorityTransferControlExportPageRequest", "output": "AuthorityTransferControlExportPageResult"} as const), "import": Object.freeze({"backendMethod": "authorityImport", "input": "AuthorityTransferControlImportRequest", "output": "AuthorityTransferControlImportResult"} as const), "verify": Object.freeze({"backendMethod": "authorityVerify", "input": "AuthorityTransferControlVerifyRequest", "output": "MigrationValidation"} as const), "activate": Object.freeze({"backendMethod": "authorityActivate", "input": "AuthorityTransferControlActivateRequest", "output": "AuthorityTransferProbe"} as const), "abort": Object.freeze({"backendMethod": "authorityAbort", "input": "AuthorityTransferControlAbortRequest", "output": "AuthorityTransferProbe"} as const), "probe": Object.freeze({"backendMethod": "authorityProbe", "input": "AuthorityTransferControlProbeRequest", "output": "AuthorityTransferProbe"} as const)} as const)} as const)
export const RuntimeEventsOutboxAPI = Object.freeze({"feature": "outbox-administration.v1", "contracts": Object.freeze(["agh.state"] as const), "localInterface": "EventsOutboxControl", "methods": Object.freeze({"deadLetters": Object.freeze({"kind": "query", "input": "OutboxDeadLettersRequest", "output": "PageOutboxDeadLetterItem"} as const), "redriveOutbox": Object.freeze({"kind": "control", "input": "OutboxRedriveRequest", "output": "OutboxRedriveResult"} as const)} as const)} as const)
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
export const RuntimeAuthorCodecPolicy = Object.freeze({"maxInlineBytes": 65536, "payload": Object.freeze({"maxCanonicalJsonBytes": 1048576, "maxDepth": 64, "maxMembers": 10000} as const)} as const)
export const RuntimeHttpHeaderPolicy = Object.freeze({"request": Object.freeze(["accept", "accept-language", "cache-control", "content-type", "if-match", "if-modified-since", "if-none-match", "if-unmodified-since", "range", "user-agent", "x-request-id"] as const), "response": Object.freeze(["cache-control", "content-type", "content-length", "content-encoding", "content-range", "date", "etag", "last-modified", "location", "retry-after", "vary", "x-request-id"] as const)} as const)
export const RuntimeApprovalIntentPolicy = Object.freeze({"algorithm": "jcs-sha256", "fields": Object.freeze(["actionRef", "inputDigest", "policyDecisionRef", "scope", "allowedResponders", "allowedGrantScopes", "expiresAt", "risk"] as const), "setFields": Object.freeze(["allowedResponders", "allowedGrantScopes"] as const), "setOrder": "utf8", "defaultAllowedGrantScopes": Object.freeze(["once"] as const), "answerSchema": "ApprovalAnswer", "riskMutableByHook": false} as const)
export const MAX_AUTHOR_INLINE_BYTES = RuntimeAuthorCodecPolicy.maxInlineBytes
