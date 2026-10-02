// generated from schema/runtime by tools/gen-runtime.ts — do not edit
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
export const RuntimeSchemaRefs = freeze({
  "RuntimeCommitData": {
    "typeId": "agh.runtime/state-commit@1",
    "revision": 1,
    "digest": "633cc1e6742cc39bdb77840fa3c6b5400d26cd521a382e7181f47a30a580fe2f"
  },
  "RuntimeFormatData": {
    "typeId": "agh.runtime/format@1",
    "revision": 1,
    "digest": "e1afdd22b9e3e474975689edd75c23890cdd00d74a13cafbf899d7791d4575c6"
  },
  "StandardToolOutput": {
    "typeId": "agh.tool/standard-output@1",
    "revision": 1,
    "digest": "0dee52b9f005dbb71aa0aedf7aaa0d4e076331824acbaf43aff4ccb369653b6c"
  },
  "SimplePromptPayload": {
    "typeId": "agh.sdk/simple-loop-instructions@1",
    "revision": 2,
    "digest": "2c68acefd4b1c1b1f2a9d5a08b73550096712a0a1bdfe49df37bdbab18b7ad8d"
  },
  "SimpleLoopOutput": {
    "typeId": "agh.sdk/simple-loop-output@1",
    "revision": 1,
    "digest": "8925a13f043f7ec3d0cb3c0e55a780628536f73164b403307b6e8625410b8b68"
  },
  "SimpleLoopCheckpoint": {
    "typeId": "agh.sdk/simple-loop-state@1",
    "revision": 1,
    "digest": "d62a39ba091a55e342189388421ebaf40991adbc1bb8f06720276f4b52f6bdeb"
  },
  "ProviderResponseEvidence": {
    "typeId": "agh.model/provider-response@1",
    "revision": 1,
    "digest": "95eec4c2c0500f407f7a26b0a2e6556ed916f43ea6404576fe6d60af8862bc67"
  },
  "UploadResult": {
    "typeId": "agh.blob/upload-result@1",
    "revision": 1,
    "digest": "ee32970914785b1fe8ffe7e811fb01194e591dab613648a3c4cd3a9d5666b2dc"
  },
  "LoopQualityInput": {
    "typeId": "agh.loop/quality-input@1",
    "revision": 1,
    "digest": "1b1e408e6095bb28f8dc35f8f3281b147ca84a0fe1d3cd646ffe06ce9fae30fc"
  },
  "LoopQualityVerdict": {
    "typeId": "agh.loop/quality-verdict@1",
    "revision": 1,
    "digest": "984331ec677784f4fbc63a8b02193ed77c29e14c5100bb8a5f6af5a9be97f4df"
  },
  "ToolResult": {
    "typeId": "agh.tools/result@1",
    "revision": 2,
    "digest": "ace5ea77b690e419b18b3eaac58371b7ed9c9453da1abc077cfe229c3ffa326f"
  },
  "ToolModelResult": {
    "typeId": "agh.tools/model-result@1",
    "revision": 2,
    "digest": "89fe22d4c797976f693021e8584ac80bd1096d9ef21776d21e81139c960084f8"
  },
  "SimpleStepView": {
    "typeId": "agh.sdk/simple-step-view@1",
    "revision": 2,
    "digest": "4f9343b645c8ab7e07b3e8cd6be6aa7aacdabe0a451c2300173fe35f026cdc1d"
  },
  "SimpleObservation": {
    "typeId": "agh.sdk/simple-observation@1",
    "revision": 2,
    "digest": "4f31a0bcbdbd929d45a48ab12b0b66ceefb9f07e6849dd4dfe239177b17828e3"
  },
  "SimpleDecisionObservation": {
    "typeId": "agh.sdk/simple-decision-observation@1",
    "revision": 1,
    "digest": "b8d55fea2d30fc43ec0d7ab3f27b780ed52b2c51b5f7b5eb64bca6f5ab665ca9"
  },
  "SimpleModelRequest": {
    "typeId": "agh.sdk/simple-model-request@1",
    "revision": 1,
    "digest": "c23778e6b3b0935da5846cd3167376d0ee4833819b20ac33a437e7d874ba3c01"
  },
  "SimpleStepDecision": {
    "typeId": "agh.sdk/simple-step-decision@1",
    "revision": 1,
    "digest": "2a98ae63638001cbcfdc9bc788769d7b04343a7d1ca85e1ff48e5f6a127185cd"
  },
  "ControlledHttpHeaders": {
    "typeId": "agh.network/http-headers@1",
    "revision": 1,
    "digest": "abb7fd3ae47a5ef439ce579b57dc8b8debbd0a5ce7ded494450ed92d2d43f936"
  },
  "ClientModuleCredentialBinding": {
    "typeId": "agh.transport/module-credential-binding@1",
    "revision": 1,
    "digest": "201d62750007f10ba46a89a4cbb445a2d1c82cddb5612829acd0df0e703e56ef"
  },
  "TransportAuthenticationEvidence": {
    "typeId": "agh.identity/transport-evidence@1",
    "revision": 1,
    "digest": "1ebc4a62d579bc1b1d0ecee617ab27f685125ab8483fe3f227b561f81666a909"
  },
  "TransportCredentialEnvelope": {
    "typeId": "agh.identity/transport-credential@1",
    "revision": 1,
    "digest": "738f12544b5f0391981bb39f7f34030f81fd5305853f407cc55584a011a7e668"
  },
  "TransportEvidenceProof": {
    "typeId": "agh.identity/transport-proof@1",
    "revision": 1,
    "digest": "2d8d77049d11168d7a7eed78c5faab1fcc973731bedcc4282b8cbae63043be63"
  },
  "ArtifactContentDescriptor": {
    "typeId": "agh.artifacts/content-descriptor@1",
    "revision": 1,
    "digest": "a743dfe953caebd2b79d25e3404aca873258108c56d69157fbb449593824c76c"
  },
  "ArtifactAccessGrantValue": {
    "typeId": "agh.artifacts/access-grant@1",
    "revision": 1,
    "digest": "57263631cab60f81dd9931f6e7599a8753ab82a574d36f905f5b8c681199e836"
  },
  "ArtifactRedeemDownloadRequest": {
    "typeId": "agh.artifacts/redeem-download-request@1",
    "revision": 1,
    "digest": "342aa76aee3a9dec58317a9ba30ee3763e4799dd1f1919d969ccea3173cda6c3"
  },
  "ArtifactDownloadPresentation": {
    "typeId": "agh.artifacts/download-presentation@1",
    "revision": 1,
    "digest": "27110220d16938df10c0fd12002565fd6b9f7d8ceb425b554090dedac2a08ff9"
  },
  "ArtifactDownloadMetadata": {
    "typeId": "agh.artifacts/download-metadata@1",
    "revision": 1,
    "digest": "e4da1d57c21757dd34b75a13eaf2de4ba5b81cd54b692113da3de99d7b416925"
  },
  "LegacyArtifactMappingValue": {
    "typeId": "agh.artifacts/legacy-mapping@1",
    "revision": 1,
    "digest": "fe2ce3aea45b6065b1316c90000902a81b4351652a39ad2ecc60d4216146702d"
  },
  "ApprovalAnswer": {
    "typeId": "agh.interaction/approval-answer@1",
    "revision": 1,
    "digest": "9ec6aa6d8d5f8d24f5faeb7440651fe0d45493667e6917ec946c1e9751f31f60"
  },
  "CommandRuntimeAcceptanceResult": {
    "typeId": "agh.domain/command-runtime-acceptance-result@1",
    "revision": 1,
    "digest": "ebd9e9b26695e2988d9ec99070b7a04cefb2f2580ebc4ed09b9e092fc93b6b36"
  },
  "LegacyIdentityCredentialEnvelope": {
    "typeId": "agh.identity/legacy-credential@1",
    "revision": 1,
    "digest": "a02bcd806a9c7595003df4ebd0f31c87692a7426134fdb754663a4248f7315b0"
  },
  "LegacyIdentityTransportEvidence": {
    "typeId": "agh.identity/legacy-transport-evidence@1",
    "revision": 1,
    "digest": "f77fa83bf34c029241371d5b1ed81ab3764069f4b145ce62c389810961fd8470"
  }
} as const)
export const RuntimeMethodSchemaRefs = freeze({
  "agh.loop": {
    "start": {
      "input": {
        "typeId": "agh.loop/start.request@1",
        "revision": 1,
        "digest": "690f4e97bf1fb0729193d7604ddb76ff5fcfd3f1f38057c9d2c3dd9b2faf4da6"
      },
      "output": {
        "typeId": "agh.loop/start.response@1",
        "revision": 1,
        "digest": "f8adbe929d3fe55732e6c2152a13ae36f83dda449614113dd9436ae55f48cd94"
      }
    },
    "resume": {
      "input": {
        "typeId": "agh.loop/resume.request@1",
        "revision": 1,
        "digest": "690f4e97bf1fb0729193d7604ddb76ff5fcfd3f1f38057c9d2c3dd9b2faf4da6"
      },
      "output": {
        "typeId": "agh.loop/resume.response@1",
        "revision": 1,
        "digest": "f8adbe929d3fe55732e6c2152a13ae36f83dda449614113dd9436ae55f48cd94"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.loop/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.loop/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.loop/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.loop/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.loop/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.loop/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.loop/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.loop/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.loop/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.loop/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.loop/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.loop/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.loop/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.loop/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.loop/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.loop/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.context": {
    "view": {
      "input": {
        "typeId": "agh.context/view.request@1",
        "revision": 2,
        "digest": "c5ef6b8db71f0db14b4c7523495bbe34e641fd0adcfe680283c1f48197dc8c81"
      },
      "output": {
        "typeId": "agh.context/view.response@1",
        "revision": 2,
        "digest": "1f097d5c7c399fab7ee23c8080c7f55bd5b0b48447e8eef7b3291becb779bd8e"
      }
    },
    "prepareView": {
      "input": {
        "typeId": "agh.context/prepareView.request@1",
        "revision": 2,
        "digest": "3f9451de767f1c7255ac0b72b3c37ad73a2d12c644a758eea788f933b71471c4"
      },
      "output": {
        "typeId": "agh.context/prepareView.response@1",
        "revision": 2,
        "digest": "1f097d5c7c399fab7ee23c8080c7f55bd5b0b48447e8eef7b3291becb779bd8e"
      }
    },
    "refresh": {
      "input": {
        "typeId": "agh.context/refresh.request@1",
        "revision": 2,
        "digest": "60b9a61d3483afc6a23608bae5b2c8c2d9d3dd9a8fdd1107dfd22549d14b533f"
      },
      "output": {
        "typeId": "agh.context/refresh.response@1",
        "revision": 2,
        "digest": "4c0b6016bbac12594de429bc918426d366bf942508db434d17e2297764f20a53"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.context/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.context/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.context/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.context/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.context/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.context/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.context/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.context/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.context/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.context/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.context/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.context/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.context/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.context/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.context/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.context/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.compaction": {
    "plan": {
      "input": {
        "typeId": "agh.compaction/plan.request@1",
        "revision": 2,
        "digest": "9c0161cad2613cc391131a66457901a30ed46c0e36208de794661248f27f1289"
      },
      "output": {
        "typeId": "agh.compaction/plan.response@1",
        "revision": 2,
        "digest": "d9e28333f69bebc277313f826fc167a21618206220edb8f756e28ec9c38d5138"
      }
    },
    "preparePlan": {
      "input": {
        "typeId": "agh.compaction/preparePlan.request@1",
        "revision": 2,
        "digest": "d042d22c6b5a039b7883a616db7cc191503c05ad09fd9230f74eb51cb9a8a394"
      },
      "output": {
        "typeId": "agh.compaction/preparePlan.response@1",
        "revision": 2,
        "digest": "d9e28333f69bebc277313f826fc167a21618206220edb8f756e28ec9c38d5138"
      }
    },
    "execute": {
      "input": {
        "typeId": "agh.compaction/execute.request@1",
        "revision": 2,
        "digest": "c99b15fd671a2ad32bd9fc1950e72c9a2a96bc4e1ce8d22722c073eb0d40c5dc"
      },
      "output": {
        "typeId": "agh.compaction/execute.response@1",
        "revision": 2,
        "digest": "e636e1ee76208fb182480020690b36da398cb6f1bdf848d6c6b8593be730e0e4"
      }
    },
    "apply": {
      "input": {
        "typeId": "agh.compaction/apply.request@1",
        "revision": 2,
        "digest": "a7123e8db78edaede995947aa9dfff8481ff18bd5992379ce99f08e01744a119"
      },
      "output": {
        "typeId": "agh.compaction/apply.response@1",
        "revision": 1,
        "digest": "94df74fd0e2223b293b6976db1df62cbddd0184809c4c3499d7b6a97e0d68f9b"
      }
    },
    "expand": {
      "input": {
        "typeId": "agh.compaction/expand.request@1",
        "revision": 1,
        "digest": "b97fa64be6a9645066f7c1ee4cea7b08cfd294f9bf0a6692b132e11d19840980"
      },
      "output": {
        "typeId": "agh.compaction/expand.response@1",
        "revision": 2,
        "digest": "f02e85efe05b87e3bd85e33792080a3808d4b068eb50c20ee247be28e09a36a5"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.compaction/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.compaction/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.compaction/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.compaction/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.compaction/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.compaction/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.compaction/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.compaction/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.compaction/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.compaction/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.compaction/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.compaction/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.compaction/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.compaction/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.compaction/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.compaction/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.model": {
    "prepare": {
      "input": {
        "typeId": "agh.model/prepare.request@1",
        "revision": 2,
        "digest": "ed7cd1500864b2b22834d4a7520f3ba6009669fbdb8f297d035d49754e3d921f"
      },
      "output": {
        "typeId": "agh.model/prepare.response@1",
        "revision": 1,
        "digest": "4a2cff6b814ab8feba50f2b30b3fcadb3a75b3cf4a3454f486c6ea63c8cde09f"
      }
    },
    "prepareRequest": {
      "input": {
        "typeId": "agh.model/prepareRequest.request@1",
        "revision": 2,
        "digest": "d33b7dec5c950ba8ca4fe33a5a38bdb7d86aa45a7adc040164b610422d71fdbf"
      },
      "output": {
        "typeId": "agh.model/prepareRequest.response@1",
        "revision": 1,
        "digest": "a54fc2e3917329988ef91e1c99edc902d4197b39648a7f82edfb9f6837b1ecf3"
      }
    },
    "infer": {
      "input": {
        "typeId": "agh.model/infer.request@1",
        "revision": 1,
        "digest": "e427552d1932e2658025bedfc4bd906838a2b439a647ea698951fe1736bab80a"
      },
      "output": {
        "typeId": "agh.model/infer.response@1",
        "revision": 1,
        "digest": "4e84d87bfb76f3e7b24d7357e243619eda1b940a58bbb722d77d5feed065de2b"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.model/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.model/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.model/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.model/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.model/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.model/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.model/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.model/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.model/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.model/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.model/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.model/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.model/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.model/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.model/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.model/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.routing": {
    "select": {
      "input": {
        "typeId": "agh.routing/select.request@1",
        "revision": 1,
        "digest": "1b3cca4a21f8c820dbf4a49eb452a8698cdda7c69f93fea368fd8db405a63ebc"
      },
      "output": {
        "typeId": "agh.routing/select.response@1",
        "revision": 1,
        "digest": "7a503fe7e1e224dde093732d7be6ad5f89de4be741b3da238a3a3f811d60cec9"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.routing/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.routing/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.routing/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.routing/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.routing/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.routing/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.routing/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.routing/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.routing/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.routing/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.routing/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.routing/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.routing/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.routing/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.routing/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.routing/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.media": {
    "prepare": {
      "input": {
        "typeId": "agh.media/prepare.request@1",
        "revision": 2,
        "digest": "43cd7a648fc74e9bec85ff65bccf75fcbfe10a88d2022b04a8e18e8da7e06d12"
      },
      "output": {
        "typeId": "agh.media/prepare.response@1",
        "revision": 2,
        "digest": "0a04739d812686c0785abc3b3a90f34f78163af414276c0bae04d959be8127f9"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.media/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.media/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.media/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.media/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.media/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.media/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.media/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.media/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.media/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.media/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.media/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.media/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.media/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.media/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.media/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.media/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.model-adapter": {
    "invoke": {
      "input": {
        "typeId": "agh.model-adapter/invoke.request@1",
        "revision": 1,
        "digest": "a53b6fc13a1fece473ac45c92617e9cbadb19dd76800d6a6632983361c2fe531"
      },
      "output": {
        "typeId": "agh.model-adapter/invoke.response@1",
        "revision": 1,
        "digest": "4e84d87bfb76f3e7b24d7357e243619eda1b940a58bbb722d77d5feed065de2b"
      }
    },
    "reconcile": {
      "input": {
        "typeId": "agh.model-adapter/reconcile.request@1",
        "revision": 1,
        "digest": "d2ac1773b13042f713fbe29d7f523ca1fcaf0da057ec695e75ea17aabdc0b24b"
      },
      "output": {
        "typeId": "agh.model-adapter/reconcile.response@1",
        "revision": 1,
        "digest": "359955a377b57cecb90bbe9af8045a78a5dde6bfd086cd90bd45850b6a869e6b"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.model-adapter/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.model-adapter/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.model-adapter/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.model-adapter/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.model-adapter/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.model-adapter/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.model-adapter/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.model-adapter/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.model-adapter/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.model-adapter/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.model-adapter/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.model-adapter/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.model-adapter/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.model-adapter/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.model-adapter/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.model-adapter/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.resources": {
    "list": {
      "input": {
        "typeId": "agh.resources/list.request@1",
        "revision": 1,
        "digest": "bfb7c35a0bba275e384c261ec0d18c58c4467848c907d3db4fe4ab496665a038"
      },
      "output": {
        "typeId": "agh.resources/list.response@1",
        "revision": 2,
        "digest": "86ba89aa8389cc709bcd1d85143339e509dcac89afe5ca2cff9dec22b13c4d9e"
      }
    },
    "describe": {
      "input": {
        "typeId": "agh.resources/describe.request@1",
        "revision": 1,
        "digest": "dc453df7c7ee535f2eaf1140f24a4ece63cd290ad39b2c24300abd28e9d6c7b6"
      },
      "output": {
        "typeId": "agh.resources/describe.response@1",
        "revision": 2,
        "digest": "4286028b76def79f1eb6b3ebf947d952788bdee7ea0116338d458c07ccf8bd5b"
      }
    },
    "register": {
      "input": {
        "typeId": "agh.resources/register.request@1",
        "revision": 2,
        "digest": "2ec03bd8a9c2b6bdaf4bdea1a6f6509c622d50d68c974f26c4e646f3d0a96cc2"
      },
      "output": {
        "typeId": "agh.resources/register.response@1",
        "revision": 1,
        "digest": "2ac51656c9f8615612b4223163106ef0608309a4e9e6fd663a1416c98be385dd"
      }
    },
    "remove": {
      "input": {
        "typeId": "agh.resources/remove.request@1",
        "revision": 1,
        "digest": "c6cd31d284aff07e8de3436a77cb91d325ceeb72221e22c6d4e904f2534a0c6d"
      },
      "output": {
        "typeId": "agh.resources/remove.response@1",
        "revision": 1,
        "digest": "2c110d3b33999717ca44fc546b86e001dd096e44a0205a36a1a9945d50e33e12"
      }
    },
    "retain": {
      "input": {
        "typeId": "agh.resources/retain.request@1",
        "revision": 2,
        "digest": "e113b3b16d3aaf1223b8ec0f78b9dbdb9b61e4963a033c7c5278182d92b9430d"
      },
      "output": {
        "typeId": "agh.resources/retain.response@1",
        "revision": 1,
        "digest": "2c766c166e663010edc0efd2739a2c86e706be28bc4bbdc3554da8a992354a83"
      }
    },
    "release": {
      "input": {
        "typeId": "agh.resources/release.request@1",
        "revision": 1,
        "digest": "f771d00d48033101d06aa9157aedee8c90cebeec6dce267f2ebeb0b0ff391bf7"
      },
      "output": {
        "typeId": "agh.resources/release.response@1",
        "revision": 1,
        "digest": "eded2718b304b0dff19a4edcb771283501ddc30206e3aedc7ace0cc05cffc8d8"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.resources/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.resources/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.resources/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.resources/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.resources/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.resources/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.resources/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.resources/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.resources/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.resources/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.resources/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.resources/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.resources/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.resources/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.resources/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.resources/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.mcp": {
    "connect": {
      "input": {
        "typeId": "agh.mcp/connect.request@1",
        "revision": 1,
        "digest": "903896a9ed8b4de2d0573f066213bad3389cc7022b034760531d878040ed4d48"
      },
      "output": {
        "typeId": "agh.mcp/connect.response@1",
        "revision": 1,
        "digest": "a8914451d92752b816551f0362607bf7a42cdcb9bce6eb497a08142d1a35c81a"
      }
    },
    "prepareConnection": {
      "input": {
        "typeId": "agh.mcp/prepareConnection.request@1",
        "revision": 1,
        "digest": "c6d02f8515b96710ce3302504b886d8fbc087711a59300ce98f2ad674a911b94"
      },
      "output": {
        "typeId": "agh.mcp/prepareConnection.response@1",
        "revision": 1,
        "digest": "903896a9ed8b4de2d0573f066213bad3389cc7022b034760531d878040ed4d48"
      }
    },
    "call": {
      "input": {
        "typeId": "agh.mcp/call.request@1",
        "revision": 1,
        "digest": "e7547e1898e094e88fab0016dbeba976de85231fe5e466d1df2a7c3dc968fa1b"
      },
      "output": {
        "typeId": "agh.mcp/call.response@1",
        "revision": 1,
        "digest": "c5372a2d0de02af31f6cfd624ee81f1d4b9a5d087d650f48e9562a1a129d1235"
      }
    },
    "read": {
      "input": {
        "typeId": "agh.mcp/read.request@1",
        "revision": 1,
        "digest": "ccf87db85839395a73aad7404f44feb004d63f0d36909f1e01d100e2c934c678"
      },
      "output": {
        "typeId": "agh.mcp/read.response@1",
        "revision": 1,
        "digest": "22e75558dd181df78b5390e0e5f7e97cc1dc75b54551198ef3f7ca31a9a2cba5"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.mcp/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.mcp/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.mcp/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.mcp/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.mcp/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.mcp/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.mcp/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.mcp/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.mcp/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.mcp/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.mcp/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.mcp/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.mcp/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.mcp/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.mcp/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.mcp/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.tools": {
    "describe": {
      "input": {
        "typeId": "agh.tools/describe.request@1",
        "revision": 1,
        "digest": "23bb80d259990c89b13cc29dca61d56bb50cec6f65d1bdf6b20d8b68f2b54d23"
      },
      "output": {
        "typeId": "agh.tools/describe.response@1",
        "revision": 1,
        "digest": "65a051d280840e832f97dc28ca590046dcedf7d540468143568f2c25e834332d"
      }
    },
    "inspect": {
      "input": {
        "typeId": "agh.tools/inspect.request@1",
        "revision": 1,
        "digest": "5f8da058f9d257946b1d2cb68af9801bc1f17ab6c8a8bdeaaec97f0d0039b3c7"
      },
      "output": {
        "typeId": "agh.tools/inspect.response@1",
        "revision": 1,
        "digest": "fbe941982e42f8e5a888b3c5c41258b5ffbfaeaaff490d65682f5cdac625c1d5"
      }
    },
    "classify": {
      "input": {
        "typeId": "agh.tools/classify.request@1",
        "revision": 1,
        "digest": "d988933c03553d2c0865ae2f154afa0747f17566a15b26340aed47d520e9fe19"
      },
      "output": {
        "typeId": "agh.tools/classify.response@1",
        "revision": 1,
        "digest": "583389a983591f6fd02737bcdb52e94705be03d5ff9042848b8f495b53d11c34"
      }
    },
    "catalog": {
      "input": {
        "typeId": "agh.tools/catalog.request@1",
        "revision": 1,
        "digest": "adaa27f2262b514aab296f9cbe3550ed7fa994055eb30ac78e9ef12b06b5b916"
      },
      "output": {
        "typeId": "agh.tools/catalog.response@1",
        "revision": 1,
        "digest": "622e714ec9953f34e55db5142d291492b56ccd5a689a132767d6165ddf394fba"
      }
    },
    "updatePlan": {
      "input": {
        "typeId": "agh.tools/updatePlan.request@1",
        "revision": 1,
        "digest": "a6c13e2b71c7d254b596d6ef90e1eddde18183247a04f7cec1a67f250fff52ed"
      },
      "output": {
        "typeId": "agh.tools/updatePlan.response@1",
        "revision": 1,
        "digest": "90729a5ab29c8380867e14c788d18a57b26a6e87fd6a5206c6b35a9cd16c79a6"
      }
    },
    "requestCompaction": {
      "input": {
        "typeId": "agh.tools/requestCompaction.request@1",
        "revision": 1,
        "digest": "6240578da8f69774b7ae9a9242fbd1fbe2ac2faea246918d1becca71e134f6e7"
      },
      "output": {
        "typeId": "agh.tools/requestCompaction.response@1",
        "revision": 1,
        "digest": "9c731d9406aeac4e406911410e8a20220dee164c70976861a9661124a74706e6"
      }
    },
    "invoke": {
      "input": {
        "typeId": "agh.tools/invoke.request@1",
        "revision": 1,
        "digest": "fdd83033fc342bf695aab003a8202fab5ca911b8db65af83a9fe8b4a576f751f"
      },
      "output": {
        "typeId": "agh.tools/invoke.response@1",
        "revision": 2,
        "digest": "ace5ea77b690e419b18b3eaac58371b7ed9c9453da1abc077cfe229c3ffa326f"
      }
    },
    "cancel": {
      "input": {
        "typeId": "agh.tools/cancel.request@1",
        "revision": 1,
        "digest": "d7ffd6afb2ae4089c1cc2c0c8103b48bd615409e2fd13474743616203f850e41"
      },
      "output": {
        "typeId": "agh.tools/cancel.response@1",
        "revision": 1,
        "digest": "ce716c2257da0b1e318ade267be70a7e005c6829fc615e92f35d39a4d458b0f1"
      }
    },
    "reconcile": {
      "input": {
        "typeId": "agh.tools/reconcile.request@1",
        "revision": 1,
        "digest": "17d73bfeb69894805f7836d702a1a40e38205d0fe2953c9a2e279c4c1fb96fd1"
      },
      "output": {
        "typeId": "agh.tools/reconcile.response@1",
        "revision": 1,
        "digest": "359955a377b57cecb90bbe9af8045a78a5dde6bfd086cd90bd45850b6a869e6b"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.tools/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.tools/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.tools/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.tools/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.tools/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.tools/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.tools/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.tools/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.tools/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.tools/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.tools/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.tools/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.tools/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.tools/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.tools/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.tools/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.memory": {
    "remember": {
      "input": {
        "typeId": "agh.memory/remember.request@1",
        "revision": 2,
        "digest": "f5f556a552a1ce3e8ebaf4d73dc8ebfae32a2f72475be1de9f3f0194db4fe135"
      },
      "output": {
        "typeId": "agh.memory/remember.response@1",
        "revision": 1,
        "digest": "89a89ba6793ae85a66327cd2e936368f0ba390c62cfdf4649fd281fd8a9a49d9"
      }
    },
    "forget": {
      "input": {
        "typeId": "agh.memory/forget.request@1",
        "revision": 1,
        "digest": "f3d91dea2ad552891d4b650cd40c174fbf4c3b1833f1928f68e95d7d61c61e33"
      },
      "output": {
        "typeId": "agh.memory/forget.response@1",
        "revision": 2,
        "digest": "b9c667bb02ea4a7de496ed8d4c31aff87b159b32f5a55a42569a0020ee53b567"
      }
    },
    "get": {
      "input": {
        "typeId": "agh.memory/get.request@1",
        "revision": 1,
        "digest": "7eb83bd1a1a9fc604e41f40c1d0679441dec79ad0d8fec2d335382698777f00d"
      },
      "output": {
        "typeId": "agh.memory/get.response@1",
        "revision": 2,
        "digest": "14e371fd35e19e74399d28ae4307398ece23d0acd7ec88fcac65b5bd16e33978"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.memory/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.memory/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.memory/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.memory/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.memory/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.memory/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.memory/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.memory/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.memory/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.memory/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.memory/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.memory/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.memory/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.memory/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.memory/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.memory/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.retrieval": {
    "search": {
      "input": {
        "typeId": "agh.retrieval/search.request@1",
        "revision": 1,
        "digest": "5cdd92e92ec4a0103e864a36f1cebb86dc0bc03a91d640a320a7c94e81a56688"
      },
      "output": {
        "typeId": "agh.retrieval/search.response@1",
        "revision": 2,
        "digest": "32a2b3fe73d448d5e76b4048cc459398cb4765e8fb2b8a8ff638faca56fbb873"
      }
    },
    "searchRemote": {
      "input": {
        "typeId": "agh.retrieval/searchRemote.request@1",
        "revision": 1,
        "digest": "48604527c6054932654e187ac9d83cc555fd6243d187ce19c5c3695b772a5762"
      },
      "output": {
        "typeId": "agh.retrieval/searchRemote.response@1",
        "revision": 2,
        "digest": "2a8e176e6317ba7b6c377a99edb0eca637cfed23ddcf013137904c9d63f61c9d"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.retrieval/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.retrieval/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.retrieval/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.retrieval/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.retrieval/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.retrieval/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.retrieval/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.retrieval/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.retrieval/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.retrieval/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.retrieval/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.retrieval/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.retrieval/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.retrieval/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.retrieval/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.retrieval/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.embedding": {
    "encode": {
      "input": {
        "typeId": "agh.embedding/encode.request@1",
        "revision": 1,
        "digest": "e4868aca6cf2972875fe836f92f83b663089d483eec0aac3bdefb6c78bb28c75"
      },
      "output": {
        "typeId": "agh.embedding/encode.response@1",
        "revision": 1,
        "digest": "baa082aeadf93e03267add3c2b4431a464de75408778d0b6a245b124c66666db"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.embedding/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.embedding/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.embedding/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.embedding/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.embedding/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.embedding/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.embedding/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.embedding/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.embedding/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.embedding/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.embedding/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.embedding/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.embedding/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.embedding/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.embedding/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.embedding/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.identity": {
    "authenticate": {
      "input": {
        "typeId": "agh.identity/authenticate.request@1",
        "revision": 1,
        "digest": "067398e2952ff51892e7160e7a0b8abe8faa0813bf8c54a84e898e48c40579c1"
      },
      "output": {
        "typeId": "agh.identity/authenticate.response@1",
        "revision": 1,
        "digest": "3c32b4c474b2d9593075d375a53e2da632d26afb715ac4f339b0f36b3fb702de"
      }
    },
    "resolve": {
      "input": {
        "typeId": "agh.identity/resolve.request@1",
        "revision": 1,
        "digest": "37e7dad40915c121ce2382ee31701da0f5c7268e90b6f1ac27aa622d79ac9441"
      },
      "output": {
        "typeId": "agh.identity/resolve.response@1",
        "revision": 1,
        "digest": "3c32b4c474b2d9593075d375a53e2da632d26afb715ac4f339b0f36b3fb702de"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.identity/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.identity/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.identity/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.identity/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.identity/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.identity/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.identity/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.identity/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.identity/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.identity/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.identity/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.identity/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.identity/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.identity/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.identity/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.identity/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.policy": {
    "evaluate": {
      "input": {
        "typeId": "agh.policy/evaluate.request@1",
        "revision": 2,
        "digest": "9478c788fa590d5c491a8400afa4f181c25b1f5971b5f81e7e905d490880e034"
      },
      "output": {
        "typeId": "agh.policy/evaluate.response@1",
        "revision": 2,
        "digest": "5629493829cfdbab449b6a7a132293f4b81a1c82c3565b6d65fc8cda64100590"
      }
    },
    "listGrants": {
      "input": {
        "typeId": "agh.policy/listGrants.request@1",
        "revision": 1,
        "digest": "0d812f2550955511014e156f35bfbc27924a57c90416bad4c76a0b5010bb59cf"
      },
      "output": {
        "typeId": "agh.policy/listGrants.response@1",
        "revision": 1,
        "digest": "a043e664c3f614bf695b18921b8fefa0965a16c9147c3f199bc28a383054e20a"
      }
    },
    "revokeGrant": {
      "input": {
        "typeId": "agh.policy/revokeGrant.request@1",
        "revision": 1,
        "digest": "3a357f416124900d0fb3df6c53e012ee7b5a277875532d4931ec1dd0e03834f2"
      },
      "output": {
        "typeId": "agh.policy/revokeGrant.response@1",
        "revision": 1,
        "digest": "d45300fd5e2150c3ce1337664ffd72f8b223b697d8ed7ac448bcd86f2e7f933a"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.policy/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.policy/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.policy/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.policy/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.policy/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.policy/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.policy/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.policy/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.policy/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.policy/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.policy/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.policy/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.policy/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.policy/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.policy/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.policy/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.effects": {
    "runHooks": {
      "input": {
        "typeId": "agh.effects/runHooks.request@1",
        "revision": 1,
        "digest": "0f5e90748af5f438a5f21de8ca6d71f36e87cc8cbda62926687a97a913457a73"
      },
      "output": {
        "typeId": "agh.effects/runHooks.response@1",
        "revision": 1,
        "digest": "1537f6c5d6ab6deab90d3ccb4ece3766829e7f1470c601c95d7637739eaa0495"
      }
    },
    "dispatch": {
      "input": {
        "typeId": "agh.effects/dispatch.request@1",
        "revision": 1,
        "digest": "0fce823cb715bcf4f3f6141996cc7d67a23f149955a1597c986cec4976789266"
      },
      "output": {
        "typeId": "agh.effects/dispatch.response@1",
        "revision": 1,
        "digest": "668f122df67a7d5c0d8bf04edc077900c3d9760c499dd451f3e96fb801ac8a8c"
      }
    },
    "reconcile": {
      "input": {
        "typeId": "agh.effects/reconcile.request@1",
        "revision": 1,
        "digest": "b306926b6d4cf31415a0cb1947fb7beec9a632577a208f1a6fb9264e69b70965"
      },
      "output": {
        "typeId": "agh.effects/reconcile.response@1",
        "revision": 1,
        "digest": "eebe8d22d77111acb972f36e7d80c46a2cf2cdf21b922b56aa75fecc6e77e431"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.effects/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.effects/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.effects/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.effects/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.effects/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.effects/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.effects/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.effects/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.effects/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.effects/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.effects/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.effects/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.effects/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.effects/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.effects/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.effects/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.workspace": {
    "acquire": {
      "input": {
        "typeId": "agh.workspace/acquire.request@1",
        "revision": 1,
        "digest": "9a3d56f609886d481a7f3064599c13ba5d646ceaa46f0754510ee4f05a21b6c7"
      },
      "output": {
        "typeId": "agh.workspace/acquire.response@1",
        "revision": 1,
        "digest": "484b6c35ff5d4ca2c72381dd8133c3eda39135c538d780a717eb62e3e4cff5a5"
      }
    },
    "release": {
      "input": {
        "typeId": "agh.workspace/release.request@1",
        "revision": 1,
        "digest": "f04d8601f0bea4d46b798589c0459cae72e99b888d69f5d1dd6cee25b8c32ba4"
      },
      "output": {
        "typeId": "agh.workspace/release.response@1",
        "revision": 1,
        "digest": "f06fa246a3199c5ca58951ad4cab51ad6f7dfe68cb7e4913895ae7cd4aa278cb"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.workspace/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.workspace/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.workspace/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.workspace/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.workspace/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.workspace/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.workspace/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.workspace/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.workspace/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.workspace/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.workspace/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.workspace/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.workspace/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.workspace/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.workspace/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.workspace/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.files": {
    "read": {
      "input": {
        "typeId": "agh.files/read.request@1",
        "revision": 1,
        "digest": "f51120346ff398c8337cf2fe7c6b0e5a9a6ec6b9001780ec0946c603d6f561d7"
      },
      "output": {
        "typeId": "agh.files/read.response@1",
        "revision": 1,
        "digest": "92414bb1d33f15ee9f61ac580b75246114f4e6d1637a1f487f9bddbc86dd03b4"
      }
    },
    "write": {
      "input": {
        "typeId": "agh.files/write.request@1",
        "revision": 1,
        "digest": "cd5b65d5c5e44045de77812ed044030f255e6e998b98ba6a880222569ce5e810"
      },
      "output": {
        "typeId": "agh.files/write.response@1",
        "revision": 1,
        "digest": "0b11f9e453d86bafb7629cd4071c28a8acb44db10d8877d4e67abc57772306b6"
      }
    },
    "list": {
      "input": {
        "typeId": "agh.files/list.request@1",
        "revision": 1,
        "digest": "d95b64ee4530825d69ed29de02e9f6f0d14b63af0334038408eabb505775acdb"
      },
      "output": {
        "typeId": "agh.files/list.response@1",
        "revision": 1,
        "digest": "f8bb6a01732c9b3f8aeda56389f8881f586e2eee4644548089e0d4a43ce71d58"
      }
    },
    "stat": {
      "input": {
        "typeId": "agh.files/stat.request@1",
        "revision": 1,
        "digest": "83b21f5b33298bc31024630d1d33b46018547d4edb054f78eb29556bfd69f3e4"
      },
      "output": {
        "typeId": "agh.files/stat.response@1",
        "revision": 1,
        "digest": "510ed3eb32262959b93dd3a84d1951a3864b81b372668b30dc8776e36160cee2"
      }
    },
    "verifyPolicy": {
      "input": {
        "typeId": "agh.files/verifyPolicy.request@1",
        "revision": 1,
        "digest": "96a77765c0c3db527e5911bb2a4b2e5904fc3088dac4e17ddc2347b56992082c"
      },
      "output": {
        "typeId": "agh.files/verifyPolicy.response@1",
        "revision": 1,
        "digest": "a36d28b9d476d1a12169cdb1f4d949228ac0e1443626e7410e37746fbd89e45c"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.files/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.files/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.files/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.files/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.files/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.files/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.files/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.files/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.files/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.files/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.files/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.files/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.files/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.files/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.files/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.files/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.sandbox": {
    "create": {
      "input": {
        "typeId": "agh.sandbox/create.request@1",
        "revision": 1,
        "digest": "d215b7f41a15e64212e360ba48884bb62256efc94ac5be5085c9bad7510c9228"
      },
      "output": {
        "typeId": "agh.sandbox/create.response@1",
        "revision": 1,
        "digest": "5ff06d8efc815c59fe1ff7af1df1d00b30be9ebf7f8590f5bb442ff7eb4a88af"
      }
    },
    "stop": {
      "input": {
        "typeId": "agh.sandbox/stop.request@1",
        "revision": 1,
        "digest": "e71214b581fd1743920b24bc4fffb5fb00d55cab6aabd2bf73e42db600c03c24"
      },
      "output": {
        "typeId": "agh.sandbox/stop.response@1",
        "revision": 1,
        "digest": "c4242c35eed5912f9967487df66179eb551cb6472655aa5be033981beb1ed528"
      }
    },
    "inspect": {
      "input": {
        "typeId": "agh.sandbox/inspect.request@1",
        "revision": 1,
        "digest": "0b667d89b390ad42360fbac0dacfc301a7282196ebc4f7112cf9e43f67ec0bae"
      },
      "output": {
        "typeId": "agh.sandbox/inspect.response@1",
        "revision": 1,
        "digest": "77c8ef765cb012f55a7f84a689ee2f6946ac480f407016f5de806588a83d2c1d"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.sandbox/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.sandbox/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.sandbox/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.sandbox/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.sandbox/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.sandbox/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.sandbox/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.sandbox/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.sandbox/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.sandbox/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.sandbox/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.sandbox/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.sandbox/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.sandbox/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.sandbox/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.sandbox/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.exec": {
    "run": {
      "input": {
        "typeId": "agh.exec/run.request@1",
        "revision": 1,
        "digest": "002834e288b2d0913f6b0f8a369d1f55cff3e8e1cb39a1b29f8443d5473f1001"
      },
      "output": {
        "typeId": "agh.exec/run.response@1",
        "revision": 1,
        "digest": "30b6860ca2feee8835734165c9fbed751f6b6333ead01d236de761d346da40c2"
      }
    },
    "reconcile": {
      "input": {
        "typeId": "agh.exec/reconcile.request@1",
        "revision": 1,
        "digest": "715e067c7e547905508e191c51ee2e04ae6cbf5b7a2ed7a2ca93ea85fd9085ee"
      },
      "output": {
        "typeId": "agh.exec/reconcile.response@1",
        "revision": 1,
        "digest": "359955a377b57cecb90bbe9af8045a78a5dde6bfd086cd90bd45850b6a869e6b"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.exec/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.exec/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.exec/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.exec/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.exec/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.exec/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.exec/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.exec/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.exec/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.exec/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.exec/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.exec/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.exec/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.exec/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.exec/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.exec/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.network": {
    "request": {
      "input": {
        "typeId": "agh.network/request.request@1",
        "revision": 1,
        "digest": "2daf00f84c3bb1c51f7d1c5a54b1d76da096d0edf3b7d2acc6be92b3dd029e8b"
      },
      "output": {
        "typeId": "agh.network/request.response@1",
        "revision": 1,
        "digest": "b4b0555d8e4876c35cf29a872bda9f2bc62838be14ecfc912899f8adce4f9f3d"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.network/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.network/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.network/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.network/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.network/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.network/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.network/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.network/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.network/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.network/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.network/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.network/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.network/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.network/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.network/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.network/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.secrets": {
    "resolve": {
      "input": {
        "typeId": "agh.secrets/resolve.request@1",
        "revision": 1,
        "digest": "b2fef3ce2fe7ee16e237f9a9476e0ec3e5d2df083251b1a0115e45baba0c6925"
      },
      "output": {
        "typeId": "agh.secrets/resolve.response@1",
        "revision": 1,
        "digest": "b7965d2d778557d776a0332199795bb39638846c793af89c7c6a742a429adddb"
      }
    },
    "rotate": {
      "input": {
        "typeId": "agh.secrets/rotate.request@1",
        "revision": 1,
        "digest": "3c544ab307e40e12237cd6b07b30bb2f1b22c19a4877287f1fb1a89d43f9058b"
      },
      "output": {
        "typeId": "agh.secrets/rotate.response@1",
        "revision": 1,
        "digest": "8d3af0c81e931cfeaed003e6087ceae701c0c7b4ca18019dcee0d19bc6250c39"
      }
    },
    "revoke": {
      "input": {
        "typeId": "agh.secrets/revoke.request@1",
        "revision": 1,
        "digest": "bb02f4c8eca97dffc16dbc89c1869b34f623ee1a8ebf246e34c5fe157694f680"
      },
      "output": {
        "typeId": "agh.secrets/revoke.response@1",
        "revision": 1,
        "digest": "4bfde14fbe8bbe99b9aa381cab60ea6bede913650abe2da438ab08c199de3add"
      }
    },
    "refresh": {
      "input": {
        "typeId": "agh.secrets/refresh.request@1",
        "revision": 1,
        "digest": "97e091743bb00812c6b324a9225ef011645b1d855327f258ce083f29bf86afd5"
      },
      "output": {
        "typeId": "agh.secrets/refresh.response@1",
        "revision": 1,
        "digest": "f96548449db4f3ebe2055f81e70b5392197ea2a3c4a3c9d9e1f683d4d98ce92e"
      }
    },
    "exchange": {
      "input": {
        "typeId": "agh.secrets/exchange.request@1",
        "revision": 1,
        "digest": "5a3774492f220ba0e636e2dab5990ba463ca1b465291fe691751d8097eff7259"
      },
      "output": {
        "typeId": "agh.secrets/exchange.response@1",
        "revision": 1,
        "digest": "f96548449db4f3ebe2055f81e70b5392197ea2a3c4a3c9d9e1f683d4d98ce92e"
      }
    },
    "acceptCallback": {
      "input": {
        "typeId": "agh.secrets/acceptCallback.request@1",
        "revision": 1,
        "digest": "e902591c7860c4c766813068a072437c854661cc18c23f3d0638fc053aeeb1ed"
      },
      "output": {
        "typeId": "agh.secrets/acceptCallback.response@1",
        "revision": 1,
        "digest": "85f2ba9cb40ba00cc20e6e03872c6cdc43c131cb69864e468bf0d8cc634278a5"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.secrets/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.secrets/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.secrets/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.secrets/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.secrets/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.secrets/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.secrets/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.secrets/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.secrets/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.secrets/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.secrets/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.secrets/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.secrets/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.secrets/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.secrets/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.secrets/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.interaction": {
    "request": {
      "input": {
        "typeId": "agh.interaction/request.request@1",
        "revision": 2,
        "digest": "d8127dd98147c1de2db4b4b561a746987817eae85d02418d8a90f9f59597ebc4"
      },
      "output": {
        "typeId": "agh.interaction/request.response@1",
        "revision": 2,
        "digest": "7088a1976345431f62eac608ce327920a76de6a893026a0ac6ff982ed0c8f759"
      }
    },
    "respond": {
      "input": {
        "typeId": "agh.interaction/respond.request@1",
        "revision": 1,
        "digest": "4e778e9542761b4e98ba28f80587a31c1629b42c374cd98083587bed68fa15b4"
      },
      "output": {
        "typeId": "agh.interaction/respond.response@1",
        "revision": 2,
        "digest": "8b213d930c397458602ecadc43393e82ec469148e05ec3beba58d85272c4a7bb"
      }
    },
    "expire": {
      "input": {
        "typeId": "agh.interaction/expire.request@1",
        "revision": 2,
        "digest": "29b43b28e7b14d922639f1fa84b590062db099a2451489252f6335c6ac817b51"
      },
      "output": {
        "typeId": "agh.interaction/expire.response@1",
        "revision": 2,
        "digest": "7088a1976345431f62eac608ce327920a76de6a893026a0ac6ff982ed0c8f759"
      }
    },
    "cancel": {
      "input": {
        "typeId": "agh.interaction/cancel.request@1",
        "revision": 2,
        "digest": "7b687a9e432136ded37a83c468830821f5cf27aa222105a4028957f9ce2cae7b"
      },
      "output": {
        "typeId": "agh.interaction/cancel.response@1",
        "revision": 2,
        "digest": "7088a1976345431f62eac608ce327920a76de6a893026a0ac6ff982ed0c8f759"
      }
    },
    "read": {
      "input": {
        "typeId": "agh.interaction/read.request@1",
        "revision": 1,
        "digest": "d6e106c62195165b73a5d3867a15a9cfb1821f408c1b23dc14fbc859f56b4a24"
      },
      "output": {
        "typeId": "agh.interaction/read.response@1",
        "revision": 2,
        "digest": "7088a1976345431f62eac608ce327920a76de6a893026a0ac6ff982ed0c8f759"
      }
    },
    "pending": {
      "input": {
        "typeId": "agh.interaction/pending.request@1",
        "revision": 1,
        "digest": "a5e65bce47d3d1cdb93a982ea86988290b35576537ae3df66709748712a54237"
      },
      "output": {
        "typeId": "agh.interaction/pending.response@1",
        "revision": 2,
        "digest": "a9746b9a0b9ab612fd746857a522336cc911e595a835f109308cf3819c0626da"
      }
    },
    "responseStatus": {
      "input": {
        "typeId": "agh.interaction/responseStatus.request@1",
        "revision": 1,
        "digest": "d6e106c62195165b73a5d3867a15a9cfb1821f408c1b23dc14fbc859f56b4a24"
      },
      "output": {
        "typeId": "agh.interaction/responseStatus.response@1",
        "revision": 2,
        "digest": "8b213d930c397458602ecadc43393e82ec469148e05ec3beba58d85272c4a7bb"
      }
    },
    "acceptResponse": {
      "input": {
        "typeId": "agh.interaction/acceptResponse.request@1",
        "revision": 1,
        "digest": "7b2fa9d6e8cab96b134ecf94164bf846b2f422d5ae69734a3778ad22a6edfba0"
      },
      "output": {
        "typeId": "agh.interaction/acceptResponse.response@1",
        "revision": 2,
        "digest": "8b213d930c397458602ecadc43393e82ec469148e05ec3beba58d85272c4a7bb"
      }
    },
    "respondApproval": {
      "input": {
        "typeId": "agh.interaction/respondApproval.request@1",
        "revision": 2,
        "digest": "81cc1e2040e97632a5d0467a100b54cec8c5bbe2e28bafc217d1ca16c5a459e3"
      },
      "output": {
        "typeId": "agh.interaction/respondApproval.response@1",
        "revision": 2,
        "digest": "8b213d930c397458602ecadc43393e82ec469148e05ec3beba58d85272c4a7bb"
      }
    },
    "formLink": {
      "input": {
        "typeId": "agh.interaction/formLink.request@1",
        "revision": 1,
        "digest": "1ca21ad0eb3669b38a56483ba9e40186c88715969a72bff26cfb94b5bcb5d8ba"
      },
      "output": {
        "typeId": "agh.interaction/formLink.response@1",
        "revision": 1,
        "digest": "c662eb1402318a9882e501ffe67522300dc9f5fec9367c624774cc83f827d1c7"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.interaction/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.interaction/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.interaction/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.interaction/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.interaction/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.interaction/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.interaction/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.interaction/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.interaction/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.interaction/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.interaction/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.interaction/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.interaction/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.interaction/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.interaction/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.interaction/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.recovery": {
    "inspect": {
      "input": {
        "typeId": "agh.recovery/inspect.request@1",
        "revision": 1,
        "digest": "32c9461eae5ec1b74b038dce494ed5973e1e7961cf24bb65c724f6485172e83e"
      },
      "output": {
        "typeId": "agh.recovery/inspect.response@1",
        "revision": 1,
        "digest": "8cbf2cd175ad260b63896cb6882ea919a986885859ba88bd91761adfe1235964"
      }
    },
    "restore": {
      "input": {
        "typeId": "agh.recovery/restore.request@1",
        "revision": 1,
        "digest": "1ea7e43b9fe87a72640f5eaaa0184f32bb5e7f50d10fd642af5f0be11c3d7a66"
      },
      "output": {
        "typeId": "agh.recovery/restore.response@1",
        "revision": 1,
        "digest": "76bb0ebcdf05fc4eed63df8634d13124cbabfbbe0be014e5ba5ae78fbd4076d6"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.recovery/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.recovery/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.recovery/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.recovery/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.recovery/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.recovery/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.recovery/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.recovery/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.recovery/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.recovery/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.recovery/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.recovery/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.recovery/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.recovery/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.recovery/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.recovery/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.supervisor": {
    "admit": {
      "input": {
        "typeId": "agh.supervisor/admit.request@1",
        "revision": 1,
        "digest": "11df8f9dd26952247fd2a9a7881681e319343f076712488fcefdf1e30ca50658"
      },
      "output": {
        "typeId": "agh.supervisor/admit.response@1",
        "revision": 1,
        "digest": "244a5dbd16aabf529aca11e2de759edd4255a43752167f65409b684f17c112c0"
      }
    },
    "admitServiceCommand": {
      "input": {
        "typeId": "agh.supervisor/admitServiceCommand.request@1",
        "revision": 1,
        "digest": "a63d6a32faf0e2b5753eb3a4e0b3164471c92b10776b6fc9f8d3dbf8e988f592"
      },
      "output": {
        "typeId": "agh.supervisor/admitServiceCommand.response@1",
        "revision": 1,
        "digest": "c4ae81f80a68a578d2c9977728c0dcbad38dc931dec6241c7dc1e90a6e7b26f6"
      }
    },
    "signal": {
      "input": {
        "typeId": "agh.supervisor/signal.request@1",
        "revision": 1,
        "digest": "924c7acd438d998cd55fd7f43a51a64e919d3f230542e095e5b0eaf235c0eb8d"
      },
      "output": {
        "typeId": "agh.supervisor/signal.response@1",
        "revision": 1,
        "digest": "ccca3efb0ff3f93c12a5f894ec40137cef66e3d7eb42e560a6a47f7057bcded4"
      }
    },
    "cancel": {
      "input": {
        "typeId": "agh.supervisor/cancel.request@1",
        "revision": 1,
        "digest": "6ec3a5ed4e2dd9fdf5cb672f9ff2bb2d6df161dc3ded56504f3f4fdef1b082cc"
      },
      "output": {
        "typeId": "agh.supervisor/cancel.response@1",
        "revision": 1,
        "digest": "b5dc567f0a2cd79ebcc2d339cddaf4c588932b13aac40f1120eac8311ac889ce"
      }
    },
    "sessionParameters": {
      "input": {
        "typeId": "agh.supervisor/sessionParameters.request@1",
        "revision": 1,
        "digest": "99b054598f51d83878c00b267e7f422074589307db4a57ffa7b655a77e7a6da2"
      },
      "output": {
        "typeId": "agh.supervisor/sessionParameters.response@1",
        "revision": 1,
        "digest": "5c5edc4afa7c3168f5653fe2eb87f62e671effd6f99a1ec8659a55124bf1fc2b"
      }
    },
    "inspect": {
      "input": {
        "typeId": "agh.supervisor/inspect.request@1",
        "revision": 1,
        "digest": "d61655ebb0c563efc5c6f57680ec20e0c798abd53b8b48fee01819eba0cce946"
      },
      "output": {
        "typeId": "agh.supervisor/inspect.response@1",
        "revision": 2,
        "digest": "d1def92081d5fc5bca747cff7b2f6281ebaa085bdca9818a17a367cfc06f1d63"
      }
    },
    "serviceCommandStatus": {
      "input": {
        "typeId": "agh.supervisor/serviceCommandStatus.request@1",
        "revision": 1,
        "digest": "dc46db01fb5d8be4b216b2e9564f62a9bcc7d23c400e22fdb48899a8faee6954"
      },
      "output": {
        "typeId": "agh.supervisor/serviceCommandStatus.response@1",
        "revision": 1,
        "digest": "1f381f1735de1b9a41140c8fda0d4631a3def1ec83c8bf86df1813e545171feb"
      }
    },
    "actionReceipt": {
      "input": {
        "typeId": "agh.supervisor/actionReceipt.request@1",
        "revision": 1,
        "digest": "ee2c61593fad979ff0d31ccddfa92a25dab7580220cc5a008311f66d2fd2e014"
      },
      "output": {
        "typeId": "agh.supervisor/actionReceipt.response@1",
        "revision": 1,
        "digest": "a38e9239711080504c9f50dcd37ce5fb75f5a1e628d9910715a3ac68b421ef7d"
      }
    },
    "createConversation": {
      "input": {
        "typeId": "agh.supervisor/createConversation.request@1",
        "revision": 1,
        "digest": "6ad862cfe82c1dce22b96ed1fa7c214e06802f6ecccc36a8bd24975e22cd8a90"
      },
      "output": {
        "typeId": "agh.supervisor/createConversation.response@1",
        "revision": 1,
        "digest": "6a60bfdad6f9e48c3504e2f9974b68a933b7ae8fb03128674aeccf602150b302"
      }
    },
    "submitConversation": {
      "input": {
        "typeId": "agh.supervisor/submitConversation.request@1",
        "revision": 1,
        "digest": "de1b9d7e18a3d89c21050cceba0f78f38afda77460baaaf829a409cfabd7922f"
      },
      "output": {
        "typeId": "agh.supervisor/submitConversation.response@1",
        "revision": 2,
        "digest": "929d381b5dd6e3eb47cb01f4f2b01a3da679ffbd4721ebeb349451dfde5b8821"
      }
    },
    "cancelConversation": {
      "input": {
        "typeId": "agh.supervisor/cancelConversation.request@1",
        "revision": 1,
        "digest": "49db42d563b66952aee95a56f4cea3eedb7429c5b78894637a8ad8f296edac38"
      },
      "output": {
        "typeId": "agh.supervisor/cancelConversation.response@1",
        "revision": 2,
        "digest": "929d381b5dd6e3eb47cb01f4f2b01a3da679ffbd4721ebeb349451dfde5b8821"
      }
    },
    "conversationCommandStatus": {
      "input": {
        "typeId": "agh.supervisor/conversationCommandStatus.request@1",
        "revision": 1,
        "digest": "a14a7cd9dce0b8ac7fe43475da3c37ab03281480c2cdb90e3d6f5a148baca734"
      },
      "output": {
        "typeId": "agh.supervisor/conversationCommandStatus.response@1",
        "revision": 2,
        "digest": "929d381b5dd6e3eb47cb01f4f2b01a3da679ffbd4721ebeb349451dfde5b8821"
      }
    },
    "readSessionControl": {
      "input": {
        "typeId": "agh.supervisor/readSessionControl.request@1",
        "revision": 1,
        "digest": "d6e106c62195165b73a5d3867a15a9cfb1821f408c1b23dc14fbc859f56b4a24"
      },
      "output": {
        "typeId": "agh.supervisor/readSessionControl.response@1",
        "revision": 1,
        "digest": "dd578e1341ed6a90e57cf959f846c03419532b53ff5eddbc3b9a6cc54b55eec7"
      }
    },
    "submitSessionControl": {
      "input": {
        "typeId": "agh.supervisor/submitSessionControl.request@1",
        "revision": 1,
        "digest": "764414d1b6fb20e808bfb760a0a2e35339713962bbcdd8f25f4485cb85af6083"
      },
      "output": {
        "typeId": "agh.supervisor/submitSessionControl.response@1",
        "revision": 1,
        "digest": "91a5721999a1b75ac0de59da54c3d6daabc2569883f123f086b087379a51e791"
      }
    },
    "sessionControlStatus": {
      "input": {
        "typeId": "agh.supervisor/sessionControlStatus.request@1",
        "revision": 1,
        "digest": "f505a79b699f163f5cad371fbf1d4e12e30550d7cd91126ec0e59d94702e6cb8"
      },
      "output": {
        "typeId": "agh.supervisor/sessionControlStatus.response@1",
        "revision": 1,
        "digest": "91a5721999a1b75ac0de59da54c3d6daabc2569883f123f086b087379a51e791"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.supervisor/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.supervisor/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.supervisor/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.supervisor/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.supervisor/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.supervisor/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.supervisor/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.supervisor/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.supervisor/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.supervisor/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.supervisor/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.supervisor/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.supervisor/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.supervisor/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.supervisor/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.supervisor/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.scheduler": {
    "enqueue": {
      "input": {
        "typeId": "agh.scheduler/enqueue.request@1",
        "revision": 1,
        "digest": "d17a0f456258b9a850c541a452edf54152f9ac37fc9dd57040e984ff59ae658c"
      },
      "output": {
        "typeId": "agh.scheduler/enqueue.response@1",
        "revision": 1,
        "digest": "465492590374d56f51242c24020b843324ce11dbd283dfde81af8ab8691c2b3f"
      }
    },
    "claim": {
      "input": {
        "typeId": "agh.scheduler/claim.request@1",
        "revision": 1,
        "digest": "cc15290e141ba96595d8f926b37d801149737e5662c09e88184ab6613dadb652"
      },
      "output": {
        "typeId": "agh.scheduler/claim.response@1",
        "revision": 1,
        "digest": "c06889b82a85172c51a95a31b8effb7ce1757fa5cca763287763871f450930ff"
      }
    },
    "ack": {
      "input": {
        "typeId": "agh.scheduler/ack.request@1",
        "revision": 1,
        "digest": "56288c5ee00a2dbf41f23394b1343c059aaec15988edd530be0558ffdefc2bd2"
      },
      "output": {
        "typeId": "agh.scheduler/ack.response@1",
        "revision": 1,
        "digest": "f25981f6870b4ac8f55c927577ff6df9daadb022e9c023f8a6295dc1939c5f52"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.scheduler/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.scheduler/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.scheduler/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.scheduler/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.scheduler/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.scheduler/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.scheduler/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.scheduler/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.scheduler/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.scheduler/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.scheduler/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.scheduler/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.scheduler/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.scheduler/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.scheduler/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.scheduler/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.agents": {
    "spawn": {
      "input": {
        "typeId": "agh.agents/spawn.request@1",
        "revision": 1,
        "digest": "9234374e37767cdffb564e13120265f9df3f60615c169de34f948c39deb5be0a"
      },
      "output": {
        "typeId": "agh.agents/spawn.response@1",
        "revision": 1,
        "digest": "4916e19534c92276328f8936a3bb18838db5594e5579fc895a988664242b5e61"
      }
    },
    "send": {
      "input": {
        "typeId": "agh.agents/send.request@1",
        "revision": 1,
        "digest": "69e3fc19f7811d2c2c0e915ef81108dca3f2b8fd14ba4dd2b1467f34c9656862"
      },
      "output": {
        "typeId": "agh.agents/send.response@1",
        "revision": 1,
        "digest": "d6cb0b8c28cbac7adaaa859ee03b89b57c0c0f288d3b6dfd6a1009b547449aa3"
      }
    },
    "resume": {
      "input": {
        "typeId": "agh.agents/resume.request@1",
        "revision": 1,
        "digest": "48a9bf0d996fee5fb50f860b8e345f7e7b5ed385bf0691f457453b5e4c0078e0"
      },
      "output": {
        "typeId": "agh.agents/resume.response@1",
        "revision": 1,
        "digest": "7ad6dc6c038023f9c95eaf39f1f6488babf19e1b89a2d37efb217f070f4362f1"
      }
    },
    "cancel": {
      "input": {
        "typeId": "agh.agents/cancel.request@1",
        "revision": 1,
        "digest": "d2abbb6ef3bb8a948d540b518b9d8f4432e5d4fac5e446ec14979e1d9185d0f1"
      },
      "output": {
        "typeId": "agh.agents/cancel.response@1",
        "revision": 1,
        "digest": "83bb9c490bb3ae5c04d03c417c7396b6008e593339c6cdc11742be7aae236e73"
      }
    },
    "retire": {
      "input": {
        "typeId": "agh.agents/retire.request@1",
        "revision": 1,
        "digest": "f02fe9d49446d40bf5ba4470f7ff0a26c454fce109b130161cf87cf371e93819"
      },
      "output": {
        "typeId": "agh.agents/retire.response@1",
        "revision": 1,
        "digest": "8b0b41a611a7942a4f299571fbdcc5381ed875b0b9a7805d9cb226d702744ef8"
      }
    },
    "inspect": {
      "input": {
        "typeId": "agh.agents/inspect.request@1",
        "revision": 1,
        "digest": "a7b0ed071c18861878ccd2e82fc2cf489cc58cef28c1af43e078f1b388b3fe94"
      },
      "output": {
        "typeId": "agh.agents/inspect.response@1",
        "revision": 1,
        "digest": "03a025c9ea642c10c91b9565053f27e7ed66e68a6e3ac8366e42698cdc5c562a"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.agents/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.agents/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.agents/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.agents/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.agents/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.agents/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.agents/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.agents/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.agents/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.agents/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.agents/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.agents/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.agents/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.agents/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.agents/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.agents/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.jobs": {
    "requestCreate": {
      "input": {
        "typeId": "agh.jobs/requestCreate.request@1",
        "revision": 1,
        "digest": "a9882e39b71e95c996636b00c33bdd296d0ba6167fa69dd4f53beb0fa5aacc52"
      },
      "output": {
        "typeId": "agh.jobs/requestCreate.response@1",
        "revision": 1,
        "digest": "205a535022b8b081214af70db8ccac4cbd6204e4cedfccc22544ffb180e08d6c"
      }
    },
    "requestUpdate": {
      "input": {
        "typeId": "agh.jobs/requestUpdate.request@1",
        "revision": 1,
        "digest": "cc783ba79589965be1618eab435e4c87cc507b7b617917e60c07c2af334e30e7"
      },
      "output": {
        "typeId": "agh.jobs/requestUpdate.response@1",
        "revision": 1,
        "digest": "205a535022b8b081214af70db8ccac4cbd6204e4cedfccc22544ffb180e08d6c"
      }
    },
    "requestCancel": {
      "input": {
        "typeId": "agh.jobs/requestCancel.request@1",
        "revision": 1,
        "digest": "f1a42de6e4db2d6455ec562c1390ed12ef8b94dce2680a4047629b990de05f22"
      },
      "output": {
        "typeId": "agh.jobs/requestCancel.response@1",
        "revision": 1,
        "digest": "073b40ccabd353e7e42e733fe8991fe2799067b32748ef9f52156ab729d65d00"
      }
    },
    "requestReserveDetached": {
      "input": {
        "typeId": "agh.jobs/requestReserveDetached.request@1",
        "revision": 1,
        "digest": "c6c7cfa1d585be40c3ef57e4d41c8a900badf92c1e9d9b2fa7973d147380c2cd"
      },
      "output": {
        "typeId": "agh.jobs/requestReserveDetached.response@1",
        "revision": 1,
        "digest": "07e080072be1354dd58158200efd18fe690ced74d61a8926b307f3d43c486f43"
      }
    },
    "claimOccurrence": {
      "input": {
        "typeId": "agh.jobs/claimOccurrence.request@1",
        "revision": 1,
        "digest": "5e2ec24b2ba284e53e4b58c6a303b0a2e3415ec98ff7cb7e02503d7b177cdaf1"
      },
      "output": {
        "typeId": "agh.jobs/claimOccurrence.response@1",
        "revision": 1,
        "digest": "f60bc2e32002809227fd61a0469662168d6e7ec96e5b238dd5139bb8cd0671f6"
      }
    },
    "completeOccurrence": {
      "input": {
        "typeId": "agh.jobs/completeOccurrence.request@1",
        "revision": 1,
        "digest": "53ec52d6a097fb55fc3e36b6e887514e5dc26abf96c231786ff3f6f3b103cfd1"
      },
      "output": {
        "typeId": "agh.jobs/completeOccurrence.response@1",
        "revision": 1,
        "digest": "f60bc2e32002809227fd61a0469662168d6e7ec96e5b238dd5139bb8cd0671f6"
      }
    },
    "reserveDetached": {
      "input": {
        "typeId": "agh.jobs/reserveDetached.request@1",
        "revision": 1,
        "digest": "f30d12af1e635cf46c5f94629f26d8607cbe5e5f8f4e9f32f403b101e7dd02cb"
      },
      "output": {
        "typeId": "agh.jobs/reserveDetached.response@1",
        "revision": 1,
        "digest": "07e080072be1354dd58158200efd18fe690ced74d61a8926b307f3d43c486f43"
      }
    },
    "attachDetached": {
      "input": {
        "typeId": "agh.jobs/attachDetached.request@1",
        "revision": 1,
        "digest": "c78d426eeef2713819956e17779d4d8917e28f6b7dd88027a97a02cefa0e7902"
      },
      "output": {
        "typeId": "agh.jobs/attachDetached.response@1",
        "revision": 1,
        "digest": "07e080072be1354dd58158200efd18fe690ced74d61a8926b307f3d43c486f43"
      }
    },
    "cancelDetached": {
      "input": {
        "typeId": "agh.jobs/cancelDetached.request@1",
        "revision": 1,
        "digest": "bdef8220c53031f8b1e2455c32a5f62b979dd17f2d05f4ebca8384223543aadd"
      },
      "output": {
        "typeId": "agh.jobs/cancelDetached.response@1",
        "revision": 1,
        "digest": "07e080072be1354dd58158200efd18fe690ced74d61a8926b307f3d43c486f43"
      }
    },
    "inspect": {
      "input": {
        "typeId": "agh.jobs/inspect.request@1",
        "revision": 1,
        "digest": "20f3d0214b084354efd11dc217cdb7a6de1879fabb092536916f1dd55d5e1b46"
      },
      "output": {
        "typeId": "agh.jobs/inspect.response@1",
        "revision": 1,
        "digest": "b59e3c74e54d59f5868e6ed19a3bfba3c8908442e9d06ff3ddf1512d28e9b0f2"
      }
    },
    "createDefinition": {
      "input": {
        "typeId": "agh.jobs/createDefinition.request@1",
        "revision": 1,
        "digest": "0620cc18eb9e0fcae0d752c11d9359093278a6588968d1cadaf502d021b5b7b9"
      },
      "output": {
        "typeId": "agh.jobs/createDefinition.response@1",
        "revision": 1,
        "digest": "205a535022b8b081214af70db8ccac4cbd6204e4cedfccc22544ffb180e08d6c"
      }
    },
    "updateDefinition": {
      "input": {
        "typeId": "agh.jobs/updateDefinition.request@1",
        "revision": 1,
        "digest": "2240115890972e4bd7700fbd4ba5c00aad3c1eb90fad5f763f0efeb304a0171c"
      },
      "output": {
        "typeId": "agh.jobs/updateDefinition.response@1",
        "revision": 1,
        "digest": "205a535022b8b081214af70db8ccac4cbd6204e4cedfccc22544ffb180e08d6c"
      }
    },
    "cancelDefinition": {
      "input": {
        "typeId": "agh.jobs/cancelDefinition.request@1",
        "revision": 1,
        "digest": "eec96b6fdd90dcf63e47de87304a0db5cab1964cc44bfa6c8f8c5f962ab23bec"
      },
      "output": {
        "typeId": "agh.jobs/cancelDefinition.response@1",
        "revision": 1,
        "digest": "073b40ccabd353e7e42e733fe8991fe2799067b32748ef9f52156ab729d65d00"
      }
    },
    "enqueueClientJob": {
      "input": {
        "typeId": "agh.jobs/enqueueClientJob.request@1",
        "revision": 1,
        "digest": "e372f65483beec5eb6f4876ee2ad1c61f29e5667e24635767c40f054e528757c"
      },
      "output": {
        "typeId": "agh.jobs/enqueueClientJob.response@1",
        "revision": 1,
        "digest": "e854a8e55149e7055c76eb10a6891ab0dc1551577e8357fa4e3106a57e1fee61"
      }
    },
    "pollClientJob": {
      "input": {
        "typeId": "agh.jobs/pollClientJob.request@1",
        "revision": 1,
        "digest": "2d9b839c50060d97992610870908fdb9ee5eda15d1c669273e56c4d8cc68ced4"
      },
      "output": {
        "typeId": "agh.jobs/pollClientJob.response@1",
        "revision": 1,
        "digest": "2d930e37b9bfc597fdd0f6a709ce34798d50ed616eb7a6fee6de6178be822f36"
      }
    },
    "cancelClientJob": {
      "input": {
        "typeId": "agh.jobs/cancelClientJob.request@1",
        "revision": 1,
        "digest": "32153ce7aecfd17e168c521425227d54586a48616fa330056e468c4f418bc781"
      },
      "output": {
        "typeId": "agh.jobs/cancelClientJob.response@1",
        "revision": 1,
        "digest": "9036910dfe8d106f9fd2a45308a5cf328b74c7a56e3e8f1c498ba8e3ea34b20a"
      }
    },
    "acceptCreateDefinition": {
      "input": {
        "typeId": "agh.jobs/acceptCreateDefinition.request@1",
        "revision": 1,
        "digest": "ca80e3becef407b60758a0e320c4129329b19fa7e030f346d20b28dfb1461f35"
      },
      "output": {
        "typeId": "agh.jobs/acceptCreateDefinition.response@1",
        "revision": 2,
        "digest": "929d381b5dd6e3eb47cb01f4f2b01a3da679ffbd4721ebeb349451dfde5b8821"
      }
    },
    "acceptUpdateDefinition": {
      "input": {
        "typeId": "agh.jobs/acceptUpdateDefinition.request@1",
        "revision": 1,
        "digest": "26da41473d491983f8fdf34a051ada9685b5990a2757ebdc101450f2adc9010a"
      },
      "output": {
        "typeId": "agh.jobs/acceptUpdateDefinition.response@1",
        "revision": 2,
        "digest": "929d381b5dd6e3eb47cb01f4f2b01a3da679ffbd4721ebeb349451dfde5b8821"
      }
    },
    "acceptCancelDefinition": {
      "input": {
        "typeId": "agh.jobs/acceptCancelDefinition.request@1",
        "revision": 1,
        "digest": "44cb6e39f1b2c437d5a07c7775af8b03f394d67441ce0f9a761b1c6078fe2e10"
      },
      "output": {
        "typeId": "agh.jobs/acceptCancelDefinition.response@1",
        "revision": 2,
        "digest": "929d381b5dd6e3eb47cb01f4f2b01a3da679ffbd4721ebeb349451dfde5b8821"
      }
    },
    "clientCommandStatus": {
      "input": {
        "typeId": "agh.jobs/clientCommandStatus.request@1",
        "revision": 1,
        "digest": "d6e106c62195165b73a5d3867a15a9cfb1821f408c1b23dc14fbc859f56b4a24"
      },
      "output": {
        "typeId": "agh.jobs/clientCommandStatus.response@1",
        "revision": 2,
        "digest": "929d381b5dd6e3eb47cb01f4f2b01a3da679ffbd4721ebeb349451dfde5b8821"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.jobs/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.jobs/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.jobs/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.jobs/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.jobs/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.jobs/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.jobs/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.jobs/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.jobs/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.jobs/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.jobs/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.jobs/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.jobs/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.jobs/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.jobs/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.jobs/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.artifacts": {
    "reserve": {
      "input": {
        "typeId": "agh.artifacts/reserve.request@1",
        "revision": 2,
        "digest": "b21b2ff0c503820368416b9f2959fa729249d298c3d853aa3754b3b747b2ae25"
      },
      "output": {
        "typeId": "agh.artifacts/reserve.response@1",
        "revision": 2,
        "digest": "9171a270cca08d98c9b7de1ce4093cfe07995e6e68cc73f78b7b41e424bfed62"
      }
    },
    "publish": {
      "input": {
        "typeId": "agh.artifacts/publish.request@1",
        "revision": 2,
        "digest": "b846d0417776b34f0ce93048167933b4f312727f893ccf1f45ff3201d5d5e155"
      },
      "output": {
        "typeId": "agh.artifacts/publish.response@1",
        "revision": 2,
        "digest": "9171a270cca08d98c9b7de1ce4093cfe07995e6e68cc73f78b7b41e424bfed62"
      }
    },
    "revoke": {
      "input": {
        "typeId": "agh.artifacts/revoke.request@1",
        "revision": 2,
        "digest": "a01331a036df851cafef3b300a29770dcaa8b7f9408f7981f79d5d3baf1c7296"
      },
      "output": {
        "typeId": "agh.artifacts/revoke.response@1",
        "revision": 2,
        "digest": "9171a270cca08d98c9b7de1ce4093cfe07995e6e68cc73f78b7b41e424bfed62"
      }
    },
    "query": {
      "input": {
        "typeId": "agh.artifacts/query.request@1",
        "revision": 2,
        "digest": "ef827a55398535ac79e6f612eed4d8c4a8274008482fb816be47f293c67f5dff"
      },
      "output": {
        "typeId": "agh.artifacts/query.response@1",
        "revision": 2,
        "digest": "e4916c42776731836615dcd422e75f084707111791c1427afdeb970a27765d07"
      }
    },
    "fail": {
      "input": {
        "typeId": "agh.artifacts/fail.request@1",
        "revision": 1,
        "digest": "85bbdf18d1401feca97ca1f7e81e0962a1cae9cceed1b184aecbc0eb2382eb22"
      },
      "output": {
        "typeId": "agh.artifacts/fail.response@1",
        "revision": 2,
        "digest": "9171a270cca08d98c9b7de1ce4093cfe07995e6e68cc73f78b7b41e424bfed62"
      }
    },
    "grant": {
      "input": {
        "typeId": "agh.artifacts/grant.request@1",
        "revision": 1,
        "digest": "bc12dc24cc4d57fdf57c4bff8b82dda93c4403f274ab34f0fbc40c495f73245d"
      },
      "output": {
        "typeId": "agh.artifacts/grant.response@1",
        "revision": 1,
        "digest": "57263631cab60f81dd9931f6e7599a8753ab82a574d36f905f5b8c681199e836"
      }
    },
    "revokeGrant": {
      "input": {
        "typeId": "agh.artifacts/revokeGrant.request@1",
        "revision": 1,
        "digest": "a40d869759beab4399cbc4de55880e9936c8ec258c68d96d6faa338013677969"
      },
      "output": {
        "typeId": "agh.artifacts/revokeGrant.response@1",
        "revision": 1,
        "digest": "57263631cab60f81dd9931f6e7599a8753ab82a574d36f905f5b8c681199e836"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.artifacts/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.artifacts/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.artifacts/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.artifacts/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.artifacts/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.artifacts/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.artifacts/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.artifacts/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.artifacts/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.artifacts/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.artifacts/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.artifacts/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.artifacts/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.artifacts/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.artifacts/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.artifacts/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.blob": {
    "stage": {
      "input": {
        "typeId": "agh.blob/stage.request@1",
        "revision": 1,
        "digest": "c22641350d1b59aab4592e5b55563b124f6360d9af1d4a5453f6f36af8041b7a"
      },
      "output": {
        "typeId": "agh.blob/stage.response@1",
        "revision": 1,
        "digest": "e0f3c07e1d76b7f0750747702d62e8e41fd6626d5f5c331e74fe47a0ae352298"
      }
    },
    "promote": {
      "input": {
        "typeId": "agh.blob/promote.request@1",
        "revision": 1,
        "digest": "99b6443ff9e03ccec9166ac5746f50f8f3ffd17208a561f21c428c3cf516e7b5"
      },
      "output": {
        "typeId": "agh.blob/promote.response@1",
        "revision": 1,
        "digest": "719b925b9ec98d0c51210cb6534243fc39b78c097c53998abfc767c29235591c"
      }
    },
    "pin": {
      "input": {
        "typeId": "agh.blob/pin.request@1",
        "revision": 2,
        "digest": "108e050145c2f45050001eea22a278341875b1aa398f5cf66503dc75e16c29cf"
      },
      "output": {
        "typeId": "agh.blob/pin.response@1",
        "revision": 1,
        "digest": "7ad391b0f8815faa35dedd098b787aed58fb0e3211a7135b47f8f9bb427c1a0e"
      }
    },
    "unpin": {
      "input": {
        "typeId": "agh.blob/unpin.request@1",
        "revision": 1,
        "digest": "76e839542124f29bf2b0d911dfd475c742a8915ae2992164438ae61a64386591"
      },
      "output": {
        "typeId": "agh.blob/unpin.response@1",
        "revision": 1,
        "digest": "1dc3f433c534cadc544a2fef04365833feb6d5b1d785874a1d8822c452aed403"
      }
    },
    "gc": {
      "input": {
        "typeId": "agh.blob/gc.request@1",
        "revision": 1,
        "digest": "7d5951d8675ab595147a30e3ff7e51541b2848e01189ca6402f4e9e4e58c0e72"
      },
      "output": {
        "typeId": "agh.blob/gc.response@1",
        "revision": 2,
        "digest": "25c19a73e93d8076dda61b15f4f895ef9b1d99ec87227fbe07a971b95a19fba6"
      }
    },
    "inspect": {
      "input": {
        "typeId": "agh.blob/inspect.request@1",
        "revision": 2,
        "digest": "6d725767b9e28153bacf557140aa789d562d636909999438d6f825242d9c82f7"
      },
      "output": {
        "typeId": "agh.blob/inspect.response@1",
        "revision": 2,
        "digest": "7bb4e5ead8701c25166b3130d1332faa57c219590de29127b143cfdf8f99bbce"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.blob/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.blob/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.blob/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.blob/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.blob/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.blob/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.blob/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.blob/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.blob/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.blob/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.blob/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.blob/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.blob/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.blob/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.blob/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.blob/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.budget": {
    "reserve": {
      "input": {
        "typeId": "agh.budget/reserve.request@1",
        "revision": 1,
        "digest": "f2dca280f622ad7583b9033916ef7ebf1659fcb3cc122d8e89db99bfdc9ef545"
      },
      "output": {
        "typeId": "agh.budget/reserve.response@1",
        "revision": 1,
        "digest": "ce946bec49f4dcfc1c7120bf77681fb1229276377004ec3b7377962361b5964f"
      }
    },
    "settle": {
      "input": {
        "typeId": "agh.budget/settle.request@1",
        "revision": 1,
        "digest": "9c045202057a5413ec7a9d67733c55847163e2d31dd9f120c1bed6021565752c"
      },
      "output": {
        "typeId": "agh.budget/settle.response@1",
        "revision": 1,
        "digest": "2794eccf245aa5fbcbf8bd4fb04117e506acf4defa6ffebe2cf8ed255881f5a9"
      }
    },
    "reconcile": {
      "input": {
        "typeId": "agh.budget/reconcile.request@1",
        "revision": 1,
        "digest": "6d7a26775145b5c1fb27b38b3dd8a020500c3fd7cb6757802239d3c897a1c674"
      },
      "output": {
        "typeId": "agh.budget/reconcile.response@1",
        "revision": 1,
        "digest": "b6f76f2e779abc5be9a0ea926206d21723b0f7aa6b7408878b832f02c8afdbe1"
      }
    },
    "reserveQuota": {
      "input": {
        "typeId": "agh.budget/reserveQuota.request@1",
        "revision": 1,
        "digest": "189211e44b7ba11800ffc52da31bb32e10eccede7acfa22b1d1c7ccd89d67f78"
      },
      "output": {
        "typeId": "agh.budget/reserveQuota.response@1",
        "revision": 1,
        "digest": "b525b9aff57619f557fc174990b1af67c81f074d33a9a4631f5aa6205910d2c2"
      }
    },
    "releaseQuota": {
      "input": {
        "typeId": "agh.budget/releaseQuota.request@1",
        "revision": 1,
        "digest": "3c23d793aea6e2c6d9a343db6342d04720198c86b0e13bde7d739b2513d90738"
      },
      "output": {
        "typeId": "agh.budget/releaseQuota.response@1",
        "revision": 1,
        "digest": "b525b9aff57619f557fc174990b1af67c81f074d33a9a4631f5aa6205910d2c2"
      }
    },
    "readSessionBudget": {
      "input": {
        "typeId": "agh.budget/readSessionBudget.request@1",
        "revision": 1,
        "digest": "1f20b66f3973787ae202cb06931f984e50531a6a398265ba6e73ed9bec085a2c"
      },
      "output": {
        "typeId": "agh.budget/readSessionBudget.response@1",
        "revision": 1,
        "digest": "36429eae7be4034af7735a0774200e9a568de0842f9d3a1353cef527f62f51de"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.budget/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.budget/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.budget/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.budget/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.budget/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.budget/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.budget/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.budget/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.budget/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.budget/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.budget/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.budget/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.budget/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.budget/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.budget/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.budget/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.usage": {
    "record": {
      "input": {
        "typeId": "agh.usage/record.request@1",
        "revision": 1,
        "digest": "f234d2a7f79f81b4890fe8da34cfdca66dd3a9d5a031c52d386fc57d66b130de"
      },
      "output": {
        "typeId": "agh.usage/record.response@1",
        "revision": 1,
        "digest": "7d6b47649a2e3abe44dfea49f8734dcce1c89bf5379a470413fe8c721c3c2e8f"
      }
    },
    "query": {
      "input": {
        "typeId": "agh.usage/query.request@1",
        "revision": 1,
        "digest": "d89039b82d21d145a01ed8e6490da8222139ff8d55179d22a401adff0e39f126"
      },
      "output": {
        "typeId": "agh.usage/query.response@1",
        "revision": 1,
        "digest": "7f4fc56d3377fc672fdb3dbd513d6031f3927376144825ce72b2c83665b6c284"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.usage/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.usage/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.usage/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.usage/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.usage/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.usage/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.usage/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.usage/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.usage/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.usage/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.usage/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.usage/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.usage/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.usage/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.usage/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.usage/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.pricing": {
    "quote": {
      "input": {
        "typeId": "agh.pricing/quote.request@1",
        "revision": 1,
        "digest": "ebbefcfb8c969d6cf583c8dcf8b0ddeab991ee0ad1c6461ce4c2adebe86a07a7"
      },
      "output": {
        "typeId": "agh.pricing/quote.response@1",
        "revision": 1,
        "digest": "2f38b616b3e9878828c1e4a10483791a0624765272570aa40fc9f4bf21e8f457"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.pricing/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.pricing/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.pricing/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.pricing/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.pricing/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.pricing/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.pricing/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.pricing/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.pricing/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.pricing/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.pricing/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.pricing/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.pricing/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.pricing/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.pricing/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.pricing/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.billing": {
    "post": {
      "input": {
        "typeId": "agh.billing/post.request@1",
        "revision": 1,
        "digest": "0a32a5d19ad31ece962527c743d48cd68abff8e819d929eefb245bc96fb171b5"
      },
      "output": {
        "typeId": "agh.billing/post.response@1",
        "revision": 1,
        "digest": "72adef9830f6a8a8a9ad80096723a0ccfbd3bcfc5255b531b2b92d8010ec485b"
      }
    },
    "refund": {
      "input": {
        "typeId": "agh.billing/refund.request@1",
        "revision": 1,
        "digest": "4503186b1a65a56e1e4d29da65a69f1753a1bc94a15d61a1ff942dfad147c66a"
      },
      "output": {
        "typeId": "agh.billing/refund.response@1",
        "revision": 1,
        "digest": "72adef9830f6a8a8a9ad80096723a0ccfbd3bcfc5255b531b2b92d8010ec485b"
      }
    },
    "reconcile": {
      "input": {
        "typeId": "agh.billing/reconcile.request@1",
        "revision": 1,
        "digest": "d9a2994e3b9751280eb2a6d2840056f3da763a49d83763f4067f3596bf2bedfb"
      },
      "output": {
        "typeId": "agh.billing/reconcile.response@1",
        "revision": 1,
        "digest": "72adef9830f6a8a8a9ad80096723a0ccfbd3bcfc5255b531b2b92d8010ec485b"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.billing/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.billing/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.billing/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.billing/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.billing/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.billing/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.billing/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.billing/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.billing/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.billing/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.billing/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.billing/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.billing/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.billing/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.billing/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.billing/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.audit": {
    "append": {
      "input": {
        "typeId": "agh.audit/append.request@1",
        "revision": 2,
        "digest": "53c965b796897cc516ec8194fbf16ce000d3d658e91c90e9b3eea3024c571007"
      },
      "output": {
        "typeId": "agh.audit/append.response@1",
        "revision": 1,
        "digest": "71abbbd20cbe4a56f007957c9aed55fa0b8198c69b2b11c20f57fe5d134c218a"
      }
    },
    "export": {
      "input": {
        "typeId": "agh.audit/export.request@1",
        "revision": 1,
        "digest": "8af4812946f458229034f0302e974e01d4022f9e440e7f40d2bfb20d68d284cb"
      },
      "output": {
        "typeId": "agh.audit/export.response@1",
        "revision": 1,
        "digest": "1786056f7fedb8d3ac734aad4922e63e8a50de8c01527a94061024801470c8c5"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.audit/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.audit/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.audit/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.audit/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.audit/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.audit/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.audit/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.audit/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.audit/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.audit/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.audit/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.audit/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.audit/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.audit/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.audit/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.audit/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.trace": {
    "record": {
      "input": {
        "typeId": "agh.trace/record.request@1",
        "revision": 1,
        "digest": "10e94bfaf34b8889870dd22582168b7b6619e83901e974535ce9fc61f95e6011"
      },
      "output": {
        "typeId": "agh.trace/record.response@1",
        "revision": 1,
        "digest": "b624f23e2983c57a88ae43a095852e8f56035e3993d3aae7aaa77a5762e0cb0a"
      }
    },
    "export": {
      "input": {
        "typeId": "agh.trace/export.request@1",
        "revision": 1,
        "digest": "6293dbefa1ad3bc72ba29bff217646eeadd3dff8455815e4bfcc33790e5b3fb8"
      },
      "output": {
        "typeId": "agh.trace/export.response@1",
        "revision": 1,
        "digest": "cc42d91e39bbb3d8719e946efbfd652b8dc92b2995445b5bd11a1556c2e03c59"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.trace/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.trace/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.trace/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.trace/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.trace/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.trace/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.trace/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.trace/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.trace/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.trace/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.trace/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.trace/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.trace/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.trace/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.trace/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.trace/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.events": {
    "subscribe": {
      "input": {
        "typeId": "agh.events/subscribe.request@1",
        "revision": 1,
        "digest": "691f90057297932baedcd9f6587ef64aeb443e7af8077c381d7ab01b3dba5eda"
      },
      "output": {
        "typeId": "agh.events/subscribe.response@1",
        "revision": 2,
        "digest": "c154d0683822602de5982a4568cd814fd761a1cfc2a79e1c2e9bdf7214f58f2b"
      }
    },
    "publish": {
      "input": {
        "typeId": "agh.events/publish.request@1",
        "revision": 2,
        "digest": "dd1bfef40ea4e76327662c73df06e4b3df6db19ecbbad17d8ee67c3736d937cd"
      },
      "output": {
        "typeId": "agh.events/publish.response@1",
        "revision": 2,
        "digest": "25f5f39bf862cca140428d4262ce8d340b58d54d622f8def053ab3b10c34816a"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.events/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.events/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.events/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.events/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.events/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.events/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.events/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.events/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.events/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.events/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.events/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.events/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.events/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.events/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.events/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.events/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.projection": {
    "snapshot": {
      "input": {
        "typeId": "agh.projection/snapshot.request@1",
        "revision": 2,
        "digest": "f0b8e82c8603393731298b360c07aba115d295b5a2789a9f4c428ea3e4878538"
      },
      "output": {
        "typeId": "agh.projection/snapshot.response@1",
        "revision": 2,
        "digest": "4f0f62b590a18a021400174b39f7345928a282e98e30e6e2a538f9b56201c490"
      }
    },
    "changes": {
      "input": {
        "typeId": "agh.projection/changes.request@1",
        "revision": 2,
        "digest": "b7b634ce0a40f2c67b132cb16e536f5c5f290ec30386cac78e13392860a0cd18"
      },
      "output": {
        "typeId": "agh.projection/changes.response@1",
        "revision": 2,
        "digest": "f48653e83edcfc72429e3dbabcf5e5360a744bf771b61fa3318d41ed3bd5e8ac"
      }
    },
    "command": {
      "input": {
        "typeId": "agh.projection/command.request@1",
        "revision": 2,
        "digest": "72d8a731f3ad0c671ca3faf25be8bf5614ed5ab7342e943d4abb320303d47d30"
      },
      "output": {
        "typeId": "agh.projection/command.response@1",
        "revision": 2,
        "digest": "929d381b5dd6e3eb47cb01f4f2b01a3da679ffbd4721ebeb349451dfde5b8821"
      }
    },
    "openConversation": {
      "input": {
        "typeId": "agh.projection/openConversation.request@1",
        "revision": 1,
        "digest": "76f4718bd972faedd2e4dce5f173aac8511ac460f4abe8e4aad08e6066db50b9"
      },
      "output": {
        "typeId": "agh.projection/openConversation.response@1",
        "revision": 2,
        "digest": "1400444d5cf61d19bd3b51c6c562e455c05d4f6e253e45fd35c0122645b81aa6"
      }
    },
    "conversationHistory": {
      "input": {
        "typeId": "agh.projection/conversationHistory.request@1",
        "revision": 1,
        "digest": "c3156fde5078205f6f78dcf05614223cc53255edacf40ed17ce0f85f0de72b16"
      },
      "output": {
        "typeId": "agh.projection/conversationHistory.response@1",
        "revision": 2,
        "digest": "1400444d5cf61d19bd3b51c6c562e455c05d4f6e253e45fd35c0122645b81aa6"
      }
    },
    "acceptCommand": {
      "input": {
        "typeId": "agh.projection/acceptCommand.request@1",
        "revision": 2,
        "digest": "72d8a731f3ad0c671ca3faf25be8bf5614ed5ab7342e943d4abb320303d47d30"
      },
      "output": {
        "typeId": "agh.projection/acceptCommand.response@1",
        "revision": 2,
        "digest": "929d381b5dd6e3eb47cb01f4f2b01a3da679ffbd4721ebeb349451dfde5b8821"
      }
    },
    "commandStatus": {
      "input": {
        "typeId": "agh.projection/commandStatus.request@1",
        "revision": 1,
        "digest": "8d5196489ca39d04bc4f347335192e264405593e88752036947b566a0379404b"
      },
      "output": {
        "typeId": "agh.projection/commandStatus.response@1",
        "revision": 2,
        "digest": "929d381b5dd6e3eb47cb01f4f2b01a3da679ffbd4721ebeb349451dfde5b8821"
      }
    },
    "listConversations": {
      "input": {
        "typeId": "agh.projection/listConversations.request@1",
        "revision": 1,
        "digest": "3eb1e43554b238192b5ba7f17324c0046a2a9a228c4c3d695c281406ac227c56"
      },
      "output": {
        "typeId": "agh.projection/listConversations.response@1",
        "revision": 1,
        "digest": "212c3b53bba1635da190f3c3208637f4717f41e1e4f54df49519c967a820d508"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.projection/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.projection/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.projection/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.projection/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.projection/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.projection/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.projection/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.projection/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.projection/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.projection/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.projection/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.projection/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.projection/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.projection/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.projection/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.projection/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.transport": {
    "handshake": {
      "input": {
        "typeId": "agh.transport/handshake.request@1",
        "revision": 1,
        "digest": "9ca5858a8a03bf60008666286849c5f1e96bc03aa47ef753e93dbeee10c78ab7"
      },
      "output": {
        "typeId": "agh.transport/handshake.response@1",
        "revision": 2,
        "digest": "3308c7f51a798499456253ce65df166980d6b4ff178a48cb66d2503325527771"
      }
    },
    "connect": {
      "input": {
        "typeId": "agh.transport/connect.request@1",
        "revision": 1,
        "digest": "9ca5858a8a03bf60008666286849c5f1e96bc03aa47ef753e93dbeee10c78ab7"
      },
      "output": {
        "typeId": "agh.transport/connect.response@1",
        "revision": 2,
        "digest": "3308c7f51a798499456253ce65df166980d6b4ff178a48cb66d2503325527771"
      }
    },
    "command": {
      "input": {
        "typeId": "agh.transport/command.request@1",
        "revision": 2,
        "digest": "72d8a731f3ad0c671ca3faf25be8bf5614ed5ab7342e943d4abb320303d47d30"
      },
      "output": {
        "typeId": "agh.transport/command.response@1",
        "revision": 2,
        "digest": "929d381b5dd6e3eb47cb01f4f2b01a3da679ffbd4721ebeb349451dfde5b8821"
      }
    },
    "bootstrap": {
      "input": {
        "typeId": "agh.transport/bootstrap.request@1",
        "revision": 1,
        "digest": "9ca5858a8a03bf60008666286849c5f1e96bc03aa47ef753e93dbeee10c78ab7"
      },
      "output": {
        "typeId": "agh.transport/bootstrap.response@1",
        "revision": 2,
        "digest": "61ef9ed99a358ae647aa04df9a1a9cb799135e98fd6c3874b432358e4f2b34fe"
      }
    },
    "clientQuery": {
      "input": {
        "typeId": "agh.transport/clientQuery.request@1",
        "revision": 2,
        "digest": "3aba19dc3450cadcf2ab573af7184374c64ca3af27f4912206d3ce39684bab54"
      },
      "output": {
        "typeId": "agh.transport/clientQuery.response@1",
        "revision": 2,
        "digest": "e0da862164edb4c68ee81d70b3106379e403e63186bc1587c43cdd43c002b626"
      }
    },
    "clientCommand": {
      "input": {
        "typeId": "agh.transport/clientCommand.request@1",
        "revision": 2,
        "digest": "8b4896a06b682248a8d282ed8444ca875fae46a9376a6a250f7c99288e78313c"
      },
      "output": {
        "typeId": "agh.transport/clientCommand.response@1",
        "revision": 2,
        "digest": "e4d3a5b4d6bec3b3d4658cbb20f38183be476182775ea149ae1ad2dbab139b53"
      }
    },
    "catalogPage": {
      "input": {
        "typeId": "agh.transport/catalogPage.request@1",
        "revision": 1,
        "digest": "b94de8a83df41db687d526b560d45ca7870069981c6464ad37fcfb7c291f1319"
      },
      "output": {
        "typeId": "agh.transport/catalogPage.response@1",
        "revision": 2,
        "digest": "8dacd168d85595d5fc945aa80fb709f87690d2152f0fb19ff588ce518cc3ec23"
      }
    },
    "subscribe": {
      "input": {
        "typeId": "agh.transport/subscribe.request@1",
        "revision": 2,
        "digest": "5effa6de7440ea5af26e3ec587a0abc6c89cbc1006b04467e8677b0962aa9c52"
      },
      "output": {
        "typeId": "agh.transport/subscribe.response@1",
        "revision": 2,
        "digest": "6d1d78c6d478357d0706882b60912bc0db68b2364e6695d3a440a185ed477023"
      }
    },
    "readSubscription": {
      "input": {
        "typeId": "agh.transport/readSubscription.request@1",
        "revision": 1,
        "digest": "4e2299a0c407f1235ed2237603d4e993133d511324698e0390c56939d8066739"
      },
      "output": {
        "typeId": "agh.transport/readSubscription.response@1",
        "revision": 2,
        "digest": "10685c4fe8b49535dad34a62ffda575d743d99800b3b33d1ae4b4c0f9702a851"
      }
    },
    "closeSubscription": {
      "input": {
        "typeId": "agh.transport/closeSubscription.request@1",
        "revision": 1,
        "digest": "5a2fc2757c5181c403436edf33495d42ca6036856049cf8167035d45a5a30002"
      },
      "output": {
        "typeId": "agh.transport/closeSubscription.response@1",
        "revision": 1,
        "digest": "ee43f1e03ebe470c499febafcadf28a6e4cdf1d024e0db9fac9aee1ab7b9aef7"
      }
    },
    "catalogStatus": {
      "input": {
        "typeId": "agh.transport/catalogStatus.request@1",
        "revision": 1,
        "digest": "925db2d3538409b10a9c435b964fac61a96377d13f2cbc0fe41aadb6b54f61aa"
      },
      "output": {
        "typeId": "agh.transport/catalogStatus.response@1",
        "revision": 1,
        "digest": "e397a671265839b8f7f551e150b804a6bcfbab35816ea38341e48048db6325ba"
      }
    },
    "streamStatus": {
      "input": {
        "typeId": "agh.transport/streamStatus.request@1",
        "revision": 1,
        "digest": "c9655d3cf73680e046d2fef9c29423ea493440e5473d8b7ac177e335b0f2c538"
      },
      "output": {
        "typeId": "agh.transport/streamStatus.response@1",
        "revision": 1,
        "digest": "391dd0d9bc67a9db594952a0853ad72e016023fd970cb23dd738c6ccad371190"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.transport/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.transport/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.transport/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.transport/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.transport/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.transport/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.transport/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.transport/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.transport/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.transport/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.transport/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.transport/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.transport/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.transport/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.transport/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.transport/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.channel": {
    "send": {
      "input": {
        "typeId": "agh.channel/send.request@1",
        "revision": 2,
        "digest": "ce9116918346f97ff0b4ea46a9d343e266b1d7641674e0ae474a9dc1ecfd1100"
      },
      "output": {
        "typeId": "agh.channel/send.response@1",
        "revision": 1,
        "digest": "fdd3c8ebd992d25ccb00a8d0d276f2cc6b5e3ddcc0c933042c515a8d4591f351"
      }
    },
    "reconcile": {
      "input": {
        "typeId": "agh.channel/reconcile.request@1",
        "revision": 1,
        "digest": "4a4a4731015379f5176fa8a76c68268310751812a6bf2c2900b48d07a484aba4"
      },
      "output": {
        "typeId": "agh.channel/reconcile.response@1",
        "revision": 1,
        "digest": "fdd3c8ebd992d25ccb00a8d0d276f2cc6b5e3ddcc0c933042c515a8d4591f351"
      }
    },
    "callback": {
      "input": {
        "typeId": "agh.channel/callback.request@1",
        "revision": 1,
        "digest": "eba23c06380e9ae803375cff809df7e4b90e2f8e545068d3603500aecad81fc9"
      },
      "output": {
        "typeId": "agh.channel/callback.response@1",
        "revision": 1,
        "digest": "a2d83fb52846ef3d4029d427ad2fd846fc263584501fd4482345d2a8bc4660d2"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.channel/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.channel/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.channel/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.channel/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.channel/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.channel/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.channel/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.channel/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.channel/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.channel/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.channel/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.channel/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.channel/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.channel/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.channel/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.channel/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.package-source": {
    "discover": {
      "input": {
        "typeId": "agh.package-source/discover.request@1",
        "revision": 1,
        "digest": "b74b38dbd4632fc650a32c9ef11b0c65328c2ea44578a26e1f546d78a3b84732"
      },
      "output": {
        "typeId": "agh.package-source/discover.response@1",
        "revision": 1,
        "digest": "96b8bfc920e5435169a9f7d011ed67793e25f4c9ad47e6ba2775de6bb5b4900e"
      }
    },
    "resolveMetadata": {
      "input": {
        "typeId": "agh.package-source/resolveMetadata.request@1",
        "revision": 1,
        "digest": "74bcfe88b5b5f4bc8f52d9930780afd3733a5b6e92938ccbd8e2b19484a37f82"
      },
      "output": {
        "typeId": "agh.package-source/resolveMetadata.response@1",
        "revision": 1,
        "digest": "ab57aa696881b50161c1a13557725c298026fd37f04b655fc95c7656e0a2a439"
      }
    },
    "fetch": {
      "input": {
        "typeId": "agh.package-source/fetch.request@1",
        "revision": 1,
        "digest": "bba249bb96236036a3cfedd4bcccfeb624182c48aca836d77af95854a4fd1cce"
      },
      "output": {
        "typeId": "agh.package-source/fetch.response@1",
        "revision": 1,
        "digest": "99defb5d9e5ffd7a48afbc0d84bd7f58aa01aded77fa58840abfdfc5e51685d7"
      }
    },
    "refreshCatalog": {
      "input": {
        "typeId": "agh.package-source/refreshCatalog.request@1",
        "revision": 1,
        "digest": "61d271b08419219661745da5e5ce97bca54f5b8f062d481a63f51ee2a7ecfeec"
      },
      "output": {
        "typeId": "agh.package-source/refreshCatalog.response@1",
        "revision": 1,
        "digest": "17153d2ea52db6c508366d6322889f81f0856ed74c98e6030f0e312d1129a39b"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.package-source/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.package-source/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.package-source/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.package-source/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.package-source/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.package-source/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.package-source/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.package-source/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.package-source/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.package-source/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.package-source/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.package-source/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.package-source/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.package-source/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.package-source/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.package-source/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.package-resolver": {
    "resolve": {
      "input": {
        "typeId": "agh.package-resolver/resolve.request@1",
        "revision": 1,
        "digest": "e84f5eddcf80c5b6688293f7e26d406aaec8db93d42b10c305f387f84d07a371"
      },
      "output": {
        "typeId": "agh.package-resolver/resolve.response@1",
        "revision": 1,
        "digest": "69906703d64c1576d955497cf4fd23699c394663f4cafa15d596eeff2a0a8d74"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.package-resolver/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.package-resolver/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.package-resolver/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.package-resolver/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.package-resolver/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.package-resolver/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.package-resolver/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.package-resolver/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.package-resolver/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.package-resolver/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.package-resolver/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.package-resolver/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.package-resolver/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.package-resolver/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.package-resolver/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.package-resolver/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.package-installer": {
    "prepare": {
      "input": {
        "typeId": "agh.package-installer/prepare.request@1",
        "revision": 1,
        "digest": "8c8e907ad5f204ff276d4352838968b1c87dc54ce10af2a431d634074191da62"
      },
      "output": {
        "typeId": "agh.package-installer/prepare.response@1",
        "revision": 1,
        "digest": "4d0848e578c045e68936a9a93ba67cca95c66b21dd310cf759976f5c5db3eb31"
      }
    },
    "activate": {
      "input": {
        "typeId": "agh.package-installer/activate.request@1",
        "revision": 1,
        "digest": "16d0fe4083bde7284993b759a9017644fd40c99fad6ec93c7e17f27c63a16c6f"
      },
      "output": {
        "typeId": "agh.package-installer/activate.response@1",
        "revision": 1,
        "digest": "cd632a4f1bd4d6f119ee8864cc860f88714c78cc69c0f7b8437de92d1b824aaa"
      }
    },
    "disable": {
      "input": {
        "typeId": "agh.package-installer/disable.request@1",
        "revision": 1,
        "digest": "5802d265b32abe203d26e87636f5b0a6f3fd64d1966661d2e8444fb6fede954b"
      },
      "output": {
        "typeId": "agh.package-installer/disable.response@1",
        "revision": 1,
        "digest": "8279cce2eecfb057665ff3fac15edcd41e7cec0c5dd4e9eb0f945030f0415391"
      }
    },
    "repair": {
      "input": {
        "typeId": "agh.package-installer/repair.request@1",
        "revision": 1,
        "digest": "732d6b9070d8cbdc5c69914cc94335a1d18ebfed18c8bc9b2a0befca837a6c1c"
      },
      "output": {
        "typeId": "agh.package-installer/repair.response@1",
        "revision": 1,
        "digest": "f5ffd2df0579b4139254cceee14018c119583b788c3591c794c270c0e6b02413"
      }
    },
    "requestChange": {
      "input": {
        "typeId": "agh.package-installer/requestChange.request@1",
        "revision": 1,
        "digest": "5d726c61126810f3edab99c8c798932e8827349f73c7e9d9e2079c8c1f7d0943"
      },
      "output": {
        "typeId": "agh.package-installer/requestChange.response@1",
        "revision": 1,
        "digest": "ccc63cc81c4af18776b74b58c4be4ef352b18a6b1155c92237956f446986118a"
      }
    },
    "cancelProposal": {
      "input": {
        "typeId": "agh.package-installer/cancelProposal.request@1",
        "revision": 1,
        "digest": "958b908b4679a777253957894b370e4ad39c2d45fa9e91921055c9906c56f213"
      },
      "output": {
        "typeId": "agh.package-installer/cancelProposal.response@1",
        "revision": 1,
        "digest": "ccc63cc81c4af18776b74b58c4be4ef352b18a6b1155c92237956f446986118a"
      }
    },
    "proposalStatus": {
      "input": {
        "typeId": "agh.package-installer/proposalStatus.request@1",
        "revision": 1,
        "digest": "714171851a51e2ee519c1d9d3a3def820fa45085d5b0face75d01b570af1b0ba"
      },
      "output": {
        "typeId": "agh.package-installer/proposalStatus.response@1",
        "revision": 1,
        "digest": "ccc63cc81c4af18776b74b58c4be4ef352b18a6b1155c92237956f446986118a"
      }
    },
    "applyResourceChange": {
      "input": {
        "typeId": "agh.package-installer/applyResourceChange.request@1",
        "revision": 1,
        "digest": "dd3d9e5ce6270fc4da66816bad719c550201d4fa480c6a40f215cfc02af959f1"
      },
      "output": {
        "typeId": "agh.package-installer/applyResourceChange.response@1",
        "revision": 1,
        "digest": "8aff5e79d9d91524424ea5879e20b93c35bcbeb719f2fcdfc6fbaa7f3d84a808"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.package-installer/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.package-installer/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.package-installer/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.package-installer/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.package-installer/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.package-installer/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.package-installer/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.package-installer/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.package-installer/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.package-installer/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.package-installer/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.package-installer/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.package-installer/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.package-installer/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.package-installer/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.package-installer/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.config": {
    "read": {
      "input": {
        "typeId": "agh.config/read.request@1",
        "revision": 1,
        "digest": "f4a932a316561ff1ba6d03f053940dba8c0cda44c4e24cf974289e1e554b9444"
      },
      "output": {
        "typeId": "agh.config/read.response@1",
        "revision": 1,
        "digest": "5089c50bc6df3720223fbf9faf2b8911cd82860c0631d7b449598aae668e960f"
      }
    },
    "resolve": {
      "input": {
        "typeId": "agh.config/resolve.request@1",
        "revision": 1,
        "digest": "40ba67e833af515ef44a7f6324968a450da7c6afda876c19a7e92458cd5768df"
      },
      "output": {
        "typeId": "agh.config/resolve.response@1",
        "revision": 1,
        "digest": "997cc645aa6b9cd953e8cf81bdc84a2d8801ece0409ab8742fb920af5526cd30"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.config/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.config/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.config/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.config/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.config/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.config/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.config/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.config/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.config/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.config/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.config/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.config/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.config/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.config/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.config/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.config/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.assembly": {
    "plan": {
      "input": {
        "typeId": "agh.assembly/plan.request@1",
        "revision": 1,
        "digest": "a6b9f7c08fe89d4fe65a461345ccd37b1c49225bc1c765f1502fe51c7761dc18"
      },
      "output": {
        "typeId": "agh.assembly/plan.response@1",
        "revision": 1,
        "digest": "f8f3f4594a10efb4733e7552178df2eb3288c8c3553713161b7e26255ceaaa56"
      }
    },
    "prepare": {
      "input": {
        "typeId": "agh.assembly/prepare.request@1",
        "revision": 1,
        "digest": "bc3320afdca4e2cec1ea9bd799b999ba263c5a45df079b98ed267bc31eb74229"
      },
      "output": {
        "typeId": "agh.assembly/prepare.response@1",
        "revision": 1,
        "digest": "0ef5734a2282a7d27ecffaaaa848a1b74a67231958e983c0dcf91243ad8a3cf4"
      }
    },
    "publish": {
      "input": {
        "typeId": "agh.assembly/publish.request@1",
        "revision": 1,
        "digest": "7906bb23ac6d7618e08d5a4722f48f9f37e458847802d48edc264c6833d4f2c5"
      },
      "output": {
        "typeId": "agh.assembly/publish.response@1",
        "revision": 1,
        "digest": "5753068746704ce86d630a58385eb3a5d330e9b05bcb6b0c835b00f6b3d71ecd"
      }
    },
    "drain": {
      "input": {
        "typeId": "agh.assembly/drain.request@1",
        "revision": 1,
        "digest": "b844c59da393244ff8587af4359b35bebaa8c673cd4f9bad0592a2c7c0efe41f"
      },
      "output": {
        "typeId": "agh.assembly/drain.response@1",
        "revision": 2,
        "digest": "6c15841415322f38ef1155a27e8a7289f2f6f2981905cdf78697e2f2a6930c10"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.assembly/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.assembly/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.assembly/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.assembly/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.assembly/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.assembly/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.assembly/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.assembly/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.assembly/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.assembly/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.assembly/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.assembly/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.assembly/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.assembly/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.assembly/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.assembly/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.migration": {
    "inspect": {
      "input": {
        "typeId": "agh.migration/inspect.request@1",
        "revision": 1,
        "digest": "6154918ee135ff1937664ab19dd0463fb13fbe009feb85daf67569048d070c25"
      },
      "output": {
        "typeId": "agh.migration/inspect.response@1",
        "revision": 1,
        "digest": "b5f812b9fe4fa98bdbc6f4e4604d8b361f27f58a8505ea9452c54c540cc23a2b"
      }
    },
    "prepare": {
      "input": {
        "typeId": "agh.migration/prepare.request@1",
        "revision": 1,
        "digest": "b535ec9f362b189162b0eeae5c2d388ba3f2e57177e5f18b35c432317aad16bb"
      },
      "output": {
        "typeId": "agh.migration/prepare.response@1",
        "revision": 1,
        "digest": "4b72a8445c75b6aba9de4cf818a7c5885ffda16e9bdb3f7e5e1f28ac51b4689b"
      }
    },
    "validate": {
      "input": {
        "typeId": "agh.migration/validate.request@1",
        "revision": 1,
        "digest": "5876c8e6be7bc2cf24993d2537586f404a6d1f3dfa16619653216a20f585d0d9"
      },
      "output": {
        "typeId": "agh.migration/validate.response@1",
        "revision": 1,
        "digest": "283a35c7fccbcfd23292d5cec5e706ee2cce1996d781e0d0fe8e5bba2cf0f17e"
      }
    },
    "cutover": {
      "input": {
        "typeId": "agh.migration/cutover.request@1",
        "revision": 1,
        "digest": "6b2156e441f777466f5d05c9cada5e13627b7f770867288270390b8ce37d386e"
      },
      "output": {
        "typeId": "agh.migration/cutover.response@1",
        "revision": 1,
        "digest": "f5ffd2df0579b4139254cceee14018c119583b788c3591c794c270c0e6b02413"
      }
    },
    "probe": {
      "input": {
        "typeId": "agh.migration/probe.request@1",
        "revision": 1,
        "digest": "d9385044653b246ddab759ed4649521bac6af68fb76a3f65658d216751bae859"
      },
      "output": {
        "typeId": "agh.migration/probe.response@1",
        "revision": 1,
        "digest": "f5ffd2df0579b4139254cceee14018c119583b788c3591c794c270c0e6b02413"
      }
    },
    "abort": {
      "input": {
        "typeId": "agh.migration/abort.request@1",
        "revision": 1,
        "digest": "52bd7fe31660e2800a514acca3eae293ac354022c9adcd886cc1ce0c4136aa5b"
      },
      "output": {
        "typeId": "agh.migration/abort.response@1",
        "revision": 1,
        "digest": "f5ffd2df0579b4139254cceee14018c119583b788c3591c794c270c0e6b02413"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.migration/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.migration/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.migration/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.migration/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.migration/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.migration/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.migration/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.migration/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.migration/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.migration/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.migration/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.migration/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.migration/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.migration/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.migration/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.migration/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.integrity": {
    "verifyPackage": {
      "input": {
        "typeId": "agh.integrity/verifyPackage.request@1",
        "revision": 1,
        "digest": "49ec85b3f6981133bd2b4242efb50083d78dc793bad30a732de7793f1876c72f"
      },
      "output": {
        "typeId": "agh.integrity/verifyPackage.response@1",
        "revision": 1,
        "digest": "5e05e7faae36739ddadb32f7af87eb503e9c259adc1a9fcd8afff41385d60976"
      }
    },
    "canonicalize": {
      "input": {
        "typeId": "agh.integrity/canonicalize.request@1",
        "revision": 1,
        "digest": "0e4605ca7d201cbfcc6c2f26a5ec4b2aa09e882559e1c79c0222a3647c91b1dd"
      },
      "output": {
        "typeId": "agh.integrity/canonicalize.response@1",
        "revision": 1,
        "digest": "be3af6ce94fca2a61988c4f498f03388a1e538f21cd087416282699166e0430b"
      }
    },
    "verify": {
      "input": {
        "typeId": "agh.integrity/verify.request@1",
        "revision": 1,
        "digest": "db2493718c7f653fd0aae8ae9a38f3f686b0f4796cd8c31f507b59197f6713e6"
      },
      "output": {
        "typeId": "agh.integrity/verify.response@1",
        "revision": 1,
        "digest": "4b4aafe4055dd6cacb90b5ee42a62f984e511eb04dc30cd486e508e1352f42a1"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.integrity/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.integrity/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.integrity/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.integrity/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.integrity/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.integrity/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.integrity/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.integrity/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.integrity/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.integrity/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.integrity/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.integrity/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.integrity/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.integrity/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.integrity/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.integrity/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.authority-directory": {
    "read": {
      "input": {
        "typeId": "agh.authority-directory/read.request@1",
        "revision": 1,
        "digest": "7da4b489565674944ddd5f0360c71bca105f0474ad36e075f1119590f28f5ce6"
      },
      "output": {
        "typeId": "agh.authority-directory/read.response@1",
        "revision": 1,
        "digest": "6636d5c80c2787f466ebdb3c6e64c06ca247f233028847d0b6d637dbdc4385c9"
      }
    },
    "transfer": {
      "input": {
        "typeId": "agh.authority-directory/transfer.request@1",
        "revision": 1,
        "digest": "6154918ee135ff1937664ab19dd0463fb13fbe009feb85daf67569048d070c25"
      },
      "output": {
        "typeId": "agh.authority-directory/transfer.response@1",
        "revision": 1,
        "digest": "f5ffd2df0579b4139254cceee14018c119583b788c3591c794c270c0e6b02413"
      }
    },
    "compareAndSwap": {
      "input": {
        "typeId": "agh.authority-directory/compareAndSwap.request@1",
        "revision": 1,
        "digest": "279fd18c8df0ba491c9de311f030666d5507d405da25339622994d90c2bf8529"
      },
      "output": {
        "typeId": "agh.authority-directory/compareAndSwap.response@1",
        "revision": 1,
        "digest": "921ea28843b2b721f810b8040b54103c355c67de3e773262d146484ad4db8abc"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.authority-directory/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.authority-directory/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.authority-directory/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.authority-directory/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.authority-directory/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.authority-directory/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.authority-directory/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.authority-directory/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.authority-directory/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.authority-directory/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.authority-directory/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.authority-directory/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.authority-directory/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.authority-directory/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.authority-directory/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.authority-directory/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.state": {
    "acceptServiceCommand": {
      "input": {
        "typeId": "agh.state/acceptServiceCommand.request@1",
        "revision": 1,
        "digest": "a63d6a32faf0e2b5753eb3a4e0b3164471c92b10776b6fc9f8d3dbf8e988f592"
      },
      "output": {
        "typeId": "agh.state/acceptServiceCommand.response@1",
        "revision": 1,
        "digest": "c4ae81f80a68a578d2c9977728c0dcbad38dc931dec6241c7dc1e90a6e7b26f6"
      }
    },
    "readServiceCommand": {
      "input": {
        "typeId": "agh.state/readServiceCommand.request@1",
        "revision": 1,
        "digest": "dc46db01fb5d8be4b216b2e9564f62a9bcc7d23c400e22fdb48899a8faee6954"
      },
      "output": {
        "typeId": "agh.state/readServiceCommand.response@1",
        "revision": 1,
        "digest": "0fb6a150d1bb8a8d65eacb646449d80b18785e9f0ea181a83de43292ad700cf7"
      }
    },
    "importConversation": {
      "input": {
        "typeId": "agh.state/importConversation.request@1",
        "revision": 1,
        "digest": "6031a97d09b42a43d86fbb88a5699bd2c43fdd8debcc9c6853c3d5aaa046ab19"
      },
      "output": {
        "typeId": "agh.state/importConversation.response@1",
        "revision": 1,
        "digest": "bc8b1d4ee5a643fcdb0e46c75e097f63678586a4b0ea49c54dd9bf5314003524"
      }
    },
    "probeConversationImport": {
      "input": {
        "typeId": "agh.state/probeConversationImport.request@1",
        "revision": 1,
        "digest": "d6e106c62195165b73a5d3867a15a9cfb1821f408c1b23dc14fbc859f56b4a24"
      },
      "output": {
        "typeId": "agh.state/probeConversationImport.response@1",
        "revision": 1,
        "digest": "c05366ecb9720e103326b45abd3787de7a93f69392e8cf2d083dcd99a55a5b12"
      }
    },
    "open": {
      "input": {
        "typeId": "agh.state/open.request@1",
        "revision": 1,
        "digest": "a118a3b6df158ca900026deb4bf5f4eb3645efbd7e6a698b37dd5b0ef8cb807a"
      },
      "output": {
        "typeId": "agh.state/open.response@1",
        "revision": 1,
        "digest": "15c88b218e25a2919e112f7178640ba977320fc93dbb721d7fb03d57f4361bbc"
      }
    },
    "lease": {
      "input": {
        "typeId": "agh.state/lease.request@1",
        "revision": 1,
        "digest": "2f454d160da00c2518e7c6dc529bbb9aa31b07a0fdf1a049d7a41ab9c35121df"
      },
      "output": {
        "typeId": "agh.state/lease.response@1",
        "revision": 1,
        "digest": "2f48a53ac5c9dba37ea4211d0c3e15bf2328635925bd47b6004982846605b8f0"
      }
    },
    "createChild": {
      "input": {
        "typeId": "agh.state/createChild.request@1",
        "revision": 1,
        "digest": "438acb75d203b46c6f44dac44fad1d68ba1c599f00ae069bbf9f6922abd2b632"
      },
      "output": {
        "typeId": "agh.state/createChild.response@1",
        "revision": 1,
        "digest": "15c88b218e25a2919e112f7178640ba977320fc93dbb721d7fb03d57f4361bbc"
      }
    },
    "admitInvocation": {
      "input": {
        "typeId": "agh.state/admitInvocation.request@1",
        "revision": 1,
        "digest": "aa6e3ebceb2ccd1f06c4ad4f2005f727a4c7342eeee48f76592600fa0239e664"
      },
      "output": {
        "typeId": "agh.state/admitInvocation.response@1",
        "revision": 1,
        "digest": "08edfd17236f51bf9c518955860ec8480ce2de3783abe25e7b4129c46d20c5b7"
      }
    },
    "admitQuery": {
      "input": {
        "typeId": "agh.state/admitQuery.request@1",
        "revision": 1,
        "digest": "537fb2b5e6f53a4186875b7e99fcb5fe19735582ae0791e4ca3831d3d833f02a"
      },
      "output": {
        "typeId": "agh.state/admitQuery.response@1",
        "revision": 1,
        "digest": "f0d3cf629d19d2907ec35328901a9b0b7fa40585ad9cbde348006c043b122ca4"
      }
    },
    "closeInvocation": {
      "input": {
        "typeId": "agh.state/closeInvocation.request@1",
        "revision": 1,
        "digest": "993930134b78a6f6535aeb94386715dedd813bf2b9335f253eab3fe76cdf1609"
      },
      "output": {
        "typeId": "agh.state/closeInvocation.response@1",
        "revision": 1,
        "digest": "3766ddf1f102000235742077fa6afde01e9b9017c0cef92085e481223c8f6264"
      }
    },
    "dispatchAdmission": {
      "input": {
        "typeId": "agh.state/dispatchAdmission.request@1",
        "revision": 1,
        "digest": "c5eda7fe266e9d1409d033e1ceb87891d7fc7ceb658109c345e5f1dcb26a9c52"
      },
      "output": {
        "typeId": "agh.state/dispatchAdmission.response@1",
        "revision": 1,
        "digest": "d8230551ee769b7706990a78e52c326b8f19c94f7f59a29fdfc9e80d294a1d99"
      }
    },
    "probeDispatchAdmission": {
      "input": {
        "typeId": "agh.state/probeDispatchAdmission.request@1",
        "revision": 1,
        "digest": "d6e106c62195165b73a5d3867a15a9cfb1821f408c1b23dc14fbc859f56b4a24"
      },
      "output": {
        "typeId": "agh.state/probeDispatchAdmission.response@1",
        "revision": 1,
        "digest": "f622e95fffa7bee61d1e2499decd936e9a7e418e639c8b8b956006fd19b00c66"
      }
    },
    "pruneRecordVersions": {
      "input": {
        "typeId": "agh.state/pruneRecordVersions.request@1",
        "revision": 1,
        "digest": "57e51d13a37e53da6000f8ebfa5ba5e156e0bd739c823dcb98dac8e5d5462dc1"
      },
      "output": {
        "typeId": "agh.state/pruneRecordVersions.response@1",
        "revision": 1,
        "digest": "c5fb475ac4e934c1ee48074f5bd36480ce459914d4ae57b149898b504ad83f51"
      }
    },
    "commitControl": {
      "input": {
        "typeId": "agh.state/commitControl.request@1",
        "revision": 2,
        "digest": "070faf98aa947dda8877675cc1a03cee07fae80825ba30c0f99ebf7334e6fb11"
      },
      "output": {
        "typeId": "agh.state/commitControl.response@1",
        "revision": 1,
        "digest": "7f68fdb4ca567284017b99257c5de088030cb10048efaa7cae91100335354617"
      }
    },
    "createRun": {
      "input": {
        "typeId": "agh.state/createRun.request@1",
        "revision": 1,
        "digest": "5b973a423e6768d9b5d7960dc935191f9f8c3605f9042370a8d029e5a0b1081a"
      },
      "output": {
        "typeId": "agh.state/createRun.response@1",
        "revision": 1,
        "digest": "8c3dcea5b56382d396774dd64fc9f71c93781d9d26937ed6e3b2cf2155b40d06"
      }
    },
    "probeAdmission": {
      "input": {
        "typeId": "agh.state/probeAdmission.request@1",
        "revision": 1,
        "digest": "d6e106c62195165b73a5d3867a15a9cfb1821f408c1b23dc14fbc859f56b4a24"
      },
      "output": {
        "typeId": "agh.state/probeAdmission.response@1",
        "revision": 1,
        "digest": "8c3dcea5b56382d396774dd64fc9f71c93781d9d26937ed6e3b2cf2155b40d06"
      }
    },
    "cancelPreparedActionAdmission": {
      "input": {
        "typeId": "agh.state/cancelPreparedActionAdmission.request@1",
        "revision": 1,
        "digest": "aee77bdd9016baa7690bc6281e3ef41bf295e63118c7e984c31204fb52ae7af0"
      },
      "output": {
        "typeId": "agh.state/cancelPreparedActionAdmission.response@1",
        "revision": 1,
        "digest": "5e292aea94bccdabec4788e7114cc597d3d941e068db8396d7363d890353fd55"
      }
    },
    "probePreparedActionAdmission": {
      "input": {
        "typeId": "agh.state/probePreparedActionAdmission.request@1",
        "revision": 1,
        "digest": "01bd4ae99d7a55fac6a99d6870b165f1837e5aa6687d644040f34e8c6eadd3cd"
      },
      "output": {
        "typeId": "agh.state/probePreparedActionAdmission.response@1",
        "revision": 1,
        "digest": "5e292aea94bccdabec4788e7114cc597d3d941e068db8396d7363d890353fd55"
      }
    },
    "readSessionControl": {
      "input": {
        "typeId": "agh.state/readSessionControl.request@1",
        "revision": 1,
        "digest": "c90c925977b1884f5981722864f990090aa2f274f4b1b76834e453e3fa8bbd2f"
      },
      "output": {
        "typeId": "agh.state/readSessionControl.response@1",
        "revision": 1,
        "digest": "dd578e1341ed6a90e57cf959f846c03419532b53ff5eddbc3b9a6cc54b55eec7"
      }
    },
    "submitSessionControl": {
      "input": {
        "typeId": "agh.state/submitSessionControl.request@1",
        "revision": 1,
        "digest": "764414d1b6fb20e808bfb760a0a2e35339713962bbcdd8f25f4485cb85af6083"
      },
      "output": {
        "typeId": "agh.state/submitSessionControl.response@1",
        "revision": 1,
        "digest": "91a5721999a1b75ac0de59da54c3d6daabc2569883f123f086b087379a51e791"
      }
    },
    "sessionControlStatus": {
      "input": {
        "typeId": "agh.state/sessionControlStatus.request@1",
        "revision": 1,
        "digest": "a2e2915335bae57c50e08b9a49adb9918e2eeb3d28e1e63a47202fddea73e241"
      },
      "output": {
        "typeId": "agh.state/sessionControlStatus.response@1",
        "revision": 1,
        "digest": "1ee94f812a4c8c3339f5dc9cf7035b7fcf444f0151c877896638728cd42c0fba"
      }
    },
    "acceptInbox": {
      "input": {
        "typeId": "agh.state/acceptInbox.request@1",
        "revision": 2,
        "digest": "152539e288aab20270463a2c67518d010e7e3b1a1cd42b28cff558d463c75cf4"
      },
      "output": {
        "typeId": "agh.state/acceptInbox.response@1",
        "revision": 1,
        "digest": "60a1ec6c91cb110e6bfd7950c0f4c1fafa9a41dbbe6c836dbf8ffb0ecd736e4d"
      }
    },
    "fireTimer": {
      "input": {
        "typeId": "agh.state/fireTimer.request@1",
        "revision": 1,
        "digest": "a282f93567f12e6b778473467eac6f7451079f4d93847c2a333ca8c56bb10430"
      },
      "output": {
        "typeId": "agh.state/fireTimer.response@1",
        "revision": 1,
        "digest": "60a1ec6c91cb110e6bfd7950c0f4c1fafa9a41dbbe6c836dbf8ffb0ecd736e4d"
      }
    },
    "registerStream": {
      "input": {
        "typeId": "agh.state/registerStream.request@1",
        "revision": 1,
        "digest": "6baf42080b30a2041f23b59b10c9a995fbb9f6bde0cc142b6c0594ccb1438389"
      },
      "output": {
        "typeId": "agh.state/registerStream.response@1",
        "revision": 1,
        "digest": "21800ccbfbde8b27d9b420f3591719216adeb6eb315187ddeba13179f5aa336f"
      }
    },
    "appendStream": {
      "input": {
        "typeId": "agh.state/appendStream.request@1",
        "revision": 1,
        "digest": "7a8d570a4c7d3142afc9c44cbf4fed1e6b5b0f532f3e37dc52063b43648a846c"
      },
      "output": {
        "typeId": "agh.state/appendStream.response@1",
        "revision": 1,
        "digest": "c1d72eba61f9aa5911cb73e52c8b633b263a0bb2dea544e9a9b44c54915c4759"
      }
    },
    "claimOutbox": {
      "input": {
        "typeId": "agh.state/claimOutbox.request@1",
        "revision": 1,
        "digest": "d3e31be44bdc15727114e766d02c30dd3f25641722a16249926f3b19307b3eca"
      },
      "output": {
        "typeId": "agh.state/claimOutbox.response@1",
        "revision": 2,
        "digest": "6dc5a51cfe465b171839073118c72941725e8f573815999bf693e9115ffdd40b"
      }
    },
    "ackOutbox": {
      "input": {
        "typeId": "agh.state/ackOutbox.request@1",
        "revision": 1,
        "digest": "0e59aaf13fd1aa426ccdf117ca6cf9655be34d7a4c968ccc7fa5344ab36f4a8e"
      },
      "output": {
        "typeId": "agh.state/ackOutbox.response@1",
        "revision": 1,
        "digest": "9e64df088e8786dc94d0cd4d9165da5313f78e62196b13d2e7d775850b38a8a1"
      }
    },
    "failOutbox": {
      "input": {
        "typeId": "agh.state/failOutbox.request@1",
        "revision": 1,
        "digest": "4bddca129c98aaa5245d6249069d0286c8b5c62f4768d60e5471ae9f82f12a76"
      },
      "output": {
        "typeId": "agh.state/failOutbox.response@1",
        "revision": 1,
        "digest": "dbc5f91c69594bee04984e2b7f6a2ad50dd60caa2b8b454ea741cffa51d1362c"
      }
    },
    "beginReconciliation": {
      "input": {
        "typeId": "agh.state/beginReconciliation.request@1",
        "revision": 1,
        "digest": "3c8f51bc3af2224feb448d6a589a70f9f3b2c2e8b7be0fbd2c8d1ba204a2957b"
      },
      "output": {
        "typeId": "agh.state/beginReconciliation.response@1",
        "revision": 1,
        "digest": "dcf57abfead374ae45c0eb4c9f494cf51c2e4582d7600966f76ee1cc8fd2a3e3"
      }
    },
    "completeReconciliation": {
      "input": {
        "typeId": "agh.state/completeReconciliation.request@1",
        "revision": 1,
        "digest": "ef19c945768662c70bd78b097c96b34ff0669c536096b58cd02be5ea82be0e8a"
      },
      "output": {
        "typeId": "agh.state/completeReconciliation.response@1",
        "revision": 1,
        "digest": "dcf57abfead374ae45c0eb4c9f494cf51c2e4582d7600966f76ee1cc8fd2a3e3"
      }
    },
    "advanceRun": {
      "input": {
        "typeId": "agh.state/advanceRun.request@1",
        "revision": 1,
        "digest": "566da8564043c36e77b7b2c8edada16a4cad089fb9de282a2154656f50bfbd54"
      },
      "output": {
        "typeId": "agh.state/advanceRun.response@1",
        "revision": 1,
        "digest": "7f68fdb4ca567284017b99257c5de088030cb10048efaa7cae91100335354617"
      }
    },
    "advanceProvider": {
      "input": {
        "typeId": "agh.state/advanceProvider.request@1",
        "revision": 1,
        "digest": "27000144fa70647942bf177fa5a24ed5a519d5fc9feafb4ae213b751e314247b"
      },
      "output": {
        "typeId": "agh.state/advanceProvider.response@1",
        "revision": 1,
        "digest": "7f68fdb4ca567284017b99257c5de088030cb10048efaa7cae91100335354617"
      }
    },
    "intakeReceipt": {
      "input": {
        "typeId": "agh.state/intakeReceipt.request@1",
        "revision": 1,
        "digest": "a0c812900b821915355da50660ca80dab6af744e54b1aec9f7d29897a3844d6f"
      },
      "output": {
        "typeId": "agh.state/intakeReceipt.response@1",
        "revision": 1,
        "digest": "54c52e4b3f5d64d97e53aaad8d864b12b5fefedc0945f0b978cd73f3f4ef8919"
      }
    },
    "publishActionResult": {
      "input": {
        "typeId": "agh.state/publishActionResult.request@1",
        "revision": 1,
        "digest": "8c68fa0909c3392e892e5f090f3e3aae17a16921c2c212b6d04b6bae3d736f93"
      },
      "output": {
        "typeId": "agh.state/publishActionResult.response@1",
        "revision": 1,
        "digest": "4d86605976588c50dc9955ee5ab9ac04fc70a6fb328b7a6cf76b48923281b0c2"
      }
    },
    "probeActionResult": {
      "input": {
        "typeId": "agh.state/probeActionResult.request@1",
        "revision": 1,
        "digest": "f5287898736a658e6357cefd4d267741aadf231f4929fa6e6d04eba6cc952313"
      },
      "output": {
        "typeId": "agh.state/probeActionResult.response@1",
        "revision": 1,
        "digest": "ab8d45d3f52157e30a5243819ddb585acdb57a3f20e08cdf445b692f451c5b3f"
      }
    },
    "acceptBridgeChild": {
      "input": {
        "typeId": "agh.state/acceptBridgeChild.request@1",
        "revision": 1,
        "digest": "e9c3116cdecf1b4c3a0a0191c1a82a4566afe9601c25b15655310882b0a8a402"
      },
      "output": {
        "typeId": "agh.state/acceptBridgeChild.response@1",
        "revision": 1,
        "digest": "b8360e2ded19fe49a0fff351331310175c807ce9167eb0b9272c5c19e018bbb4"
      }
    },
    "probeBridgeChild": {
      "input": {
        "typeId": "agh.state/probeBridgeChild.request@1",
        "revision": 1,
        "digest": "8cc429874acf72980d3682a04616457c46725c78b3457a8630f194bbb7f4b6d9"
      },
      "output": {
        "typeId": "agh.state/probeBridgeChild.response@1",
        "revision": 1,
        "digest": "a368fcfc30ed731764acd32935ea109c00f70b00359fa6d306d032d9bd7f01da"
      }
    },
    "beginMigration": {
      "input": {
        "typeId": "agh.state/beginMigration.request@1",
        "revision": 1,
        "digest": "574686b4c13856e962f01825a60d1d19af7c7ce3e0cdbf07b7c33fa55675d3b6"
      },
      "output": {
        "typeId": "agh.state/beginMigration.response@1",
        "revision": 1,
        "digest": "7a26562b08160bc65c969c805dc6446433255de5fbd785a471f47894d812984e"
      }
    },
    "commitMigratedRun": {
      "input": {
        "typeId": "agh.state/commitMigratedRun.request@1",
        "revision": 1,
        "digest": "c406dd5ca47a11215d21d02534e0b4f489d5d9fd136cce1e723865aaeb8bb298"
      },
      "output": {
        "typeId": "agh.state/commitMigratedRun.response@1",
        "revision": 1,
        "digest": "7f68fdb4ca567284017b99257c5de088030cb10048efaa7cae91100335354617"
      }
    },
    "abortMigration": {
      "input": {
        "typeId": "agh.state/abortMigration.request@1",
        "revision": 1,
        "digest": "32e7d50d7e7a7976d7f13d21aa292689ddecbb570047101df5782b0611cd49c9"
      },
      "output": {
        "typeId": "agh.state/abortMigration.response@1",
        "revision": 1,
        "digest": "7f68fdb4ca567284017b99257c5de088030cb10048efaa7cae91100335354617"
      }
    },
    "probeMigration": {
      "input": {
        "typeId": "agh.state/probeMigration.request@1",
        "revision": 1,
        "digest": "d6e106c62195165b73a5d3867a15a9cfb1821f408c1b23dc14fbc859f56b4a24"
      },
      "output": {
        "typeId": "agh.state/probeMigration.response@1",
        "revision": 1,
        "digest": "c32f0641fa24b8ac53ecfc5ac6a7ede990f19fd803ee987b98a475ab1b51dc8c"
      }
    },
    "cancelAdmission": {
      "input": {
        "typeId": "agh.state/cancelAdmission.request@1",
        "revision": 1,
        "digest": "4de9fdd8ef8f41dc5e264b57463ec4f1ea943abbfcc62361abb83945f5db2c45"
      },
      "output": {
        "typeId": "agh.state/cancelAdmission.response@1",
        "revision": 1,
        "digest": "8c3dcea5b56382d396774dd64fc9f71c93781d9d26937ed6e3b2cf2155b40d06"
      }
    },
    "deadLetters": {
      "input": {
        "typeId": "agh.state/deadLetters.request@1",
        "revision": 1,
        "digest": "afa27bcf387072ca95e569a21fb86356cf934f5769b02fddd7200a19a02449af"
      },
      "output": {
        "typeId": "agh.state/deadLetters.response@1",
        "revision": 1,
        "digest": "2f9042a6bb8ae9fca20b3dd8d145ab6724f6bf47b128c09f4002c4219628134b"
      }
    },
    "redriveOutbox": {
      "input": {
        "typeId": "agh.state/redriveOutbox.request@1",
        "revision": 1,
        "digest": "133be127af395208f818701ce7babec270eed78dbec868b0f23520dcab18179a"
      },
      "output": {
        "typeId": "agh.state/redriveOutbox.response@1",
        "revision": 1,
        "digest": "bf249264fbdb1aeb9dd2e5689d6ab0d6358e802545b6a95984c354e626fc509f"
      }
    },
    "authorityFence": {
      "input": {
        "typeId": "agh.state/authorityFence.request@1",
        "revision": 1,
        "digest": "900585d2d818fa5e580c891745b3e1afefd135c6b81e4a57184a30a199eef28f"
      },
      "output": {
        "typeId": "agh.state/authorityFence.response@1",
        "revision": 1,
        "digest": "1ae33721897b2233a71cc0690f542fef9784be46fbfc88596439c74b34afadda"
      }
    },
    "authorityExport": {
      "input": {
        "typeId": "agh.state/authorityExport.request@1",
        "revision": 1,
        "digest": "021b4135df784fa547228753caa4211e848f633ba0824922db8209aac21f981e"
      },
      "output": {
        "typeId": "agh.state/authorityExport.response@1",
        "revision": 1,
        "digest": "7b87bcf6f0188cae59d34237bc7b8c777fb5f1707ca136f8007eed107c52c4b2"
      }
    },
    "authorityExportPage": {
      "input": {
        "typeId": "agh.state/authorityExportPage.request@1",
        "revision": 1,
        "digest": "fafed569715d56a26f535bebdc0e26b081be8b3a9a9b3b7a898654609b4f8caf"
      },
      "output": {
        "typeId": "agh.state/authorityExportPage.response@1",
        "revision": 1,
        "digest": "d507289d3b7fad72142152580647e28e35e80c3ef9ece4ade758a45183fc3285"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.state/authorityImport.request@1",
        "revision": 1,
        "digest": "cdfdcb8b48c17db1c30ffdb4390d14cb88f517165f63560e9e3fbbfa0d75ab2c"
      },
      "output": {
        "typeId": "agh.state/authorityImport.response@1",
        "revision": 1,
        "digest": "5ff1cddefc61e239e1aaaf8da90ece4249af4d9b690902687df06d4655d59536"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.state/authorityVerify.request@1",
        "revision": 1,
        "digest": "9450c037b08a68a095559a7bdebdc659b21fa7d7e6220f760f96c32ee14f5a28"
      },
      "output": {
        "typeId": "agh.state/authorityVerify.response@1",
        "revision": 1,
        "digest": "cd06c2c08955bbf49f023bdae11a390482ad3728dfada994cd0704b23905ad17"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.state/authorityActivate.request@1",
        "revision": 1,
        "digest": "f071aa7b95b692e1949ca6be5919ed60d9882c60cb2fb5bea89761a4fe917b42"
      },
      "output": {
        "typeId": "agh.state/authorityActivate.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityAbort": {
      "input": {
        "typeId": "agh.state/authorityAbort.request@1",
        "revision": 1,
        "digest": "800fa83bd387dd7f6b578770610b8704d5f25846941b860ae8d119b0328baccf"
      },
      "output": {
        "typeId": "agh.state/authorityAbort.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    },
    "authorityProbe": {
      "input": {
        "typeId": "agh.state/authorityProbe.request@1",
        "revision": 1,
        "digest": "70d859e318105d821cb5806c33e6a90ee1eeac9755b996563f7487cc4ba0aef0"
      },
      "output": {
        "typeId": "agh.state/authorityProbe.response@1",
        "revision": 1,
        "digest": "56b07b7e2aa4ce7e200f14a5ad3adb46bb2fa155f07c02980895e81fb6eda07a"
      }
    }
  },
  "agh.ui-registry": {},
  "agh.renderer": {},
  "agh.shell": {}
} as const)
