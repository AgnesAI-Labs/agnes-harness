// generated from schema/runtime by tools/gen-runtime.ts — do not edit
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
export const RuntimeSchemaRefs = freeze({
  "PreparedModelRequest": {
    "typeId": "agh.model/prepared-request@1",
    "revision": 4,
    "digest": "1d363b186010ac72d6b942ecd450943e1e5de897ac18953671f951b96dd72628"
  },
  "EmbeddingVectors": {
    "typeId": "agh.embedding/vectors@1",
    "revision": 1,
    "digest": "a6b1c7217fa28b4cddef04e08a7c2bc6140cc5f78a9b607bf2865e1dbd923e57"
  },
  "RuntimeCommitData": {
    "typeId": "agh.runtime/state-commit@1",
    "revision": 1,
    "digest": "633cc1e6742cc39bdb77840fa3c6b5400d26cd521a382e7181f47a30a580fe2f"
  },
  "RuntimeFormatData": {
    "typeId": "agh.runtime/format@1",
    "revision": 2,
    "digest": "04f159db39d608bbb46d56feffae67b5864c1d951c72b0fc4da10eed582dbbf8"
  },
  "StandardToolOutput": {
    "typeId": "agh.tool/standard-output@1",
    "revision": 1,
    "digest": "0dee52b9f005dbb71aa0aedf7aaa0d4e076331824acbaf43aff4ccb369653b6c"
  },
  "SimplePromptPayload": {
    "typeId": "agh.sdk/simple-loop-instructions@1",
    "revision": 3,
    "digest": "1fb1bd03a7a1c4f04a51aaa774a0b402905d97eb7860983da99eb02dce57d997"
  },
  "SimpleLoopOutput": {
    "typeId": "agh.sdk/simple-loop-output@1",
    "revision": 1,
    "digest": "8925a13f043f7ec3d0cb3c0e55a780628536f73164b403307b6e8625410b8b68"
  },
  "SimpleLoopCheckpoint": {
    "typeId": "agh.sdk/simple-loop-state@1",
    "revision": 2,
    "digest": "5134814be3693a3f2d13e90603d840cba713acd1680624c86ca001eccc077b4a"
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
    "revision": 3,
    "digest": "0945030f2ae07fa4a465af3abc590425c5e1ae765a342159c971522b97850c95"
  },
  "ToolModelResult": {
    "typeId": "agh.tools/model-result@1",
    "revision": 3,
    "digest": "2ea930350c93a3aa4d70cf15f944a1f8b26180dae2cd71f25e48e1ff2e3d416d"
  },
  "SimpleStepView": {
    "typeId": "agh.sdk/simple-step-view@1",
    "revision": 3,
    "digest": "c9ebdd8f2ed39941216d185ae21ec1919c7ebbcf2c1612fd92f976d1a4fc5ef1"
  },
  "SimpleObservation": {
    "typeId": "agh.sdk/simple-observation@1",
    "revision": 3,
    "digest": "589e9e0c86df60de38ff4379c958b71fdda66ac6c2fa85a71a76d8437eb5f07e"
  },
  "SimpleDecisionObservation": {
    "typeId": "agh.sdk/simple-decision-observation@1",
    "revision": 2,
    "digest": "f69af5d47227ae24fa9f1aa5a7c67ebcad36ab9addbc553b491b48c455b3bdf7"
  },
  "SimpleModelRequest": {
    "typeId": "agh.sdk/simple-model-request@1",
    "revision": 2,
    "digest": "36c16b72835ff11c785a7220fe6aec6d109e6824ab2b4ecaa5007e1688d5037f"
  },
  "SimpleStepDecision": {
    "typeId": "agh.sdk/simple-step-decision@1",
    "revision": 2,
    "digest": "22fa6381f9255644afa7c2d0cfdcfbf18d1676b118eb52e01ae4cbfe38aab8cb"
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
    "revision": 2,
    "digest": "b58c35a74075366f3e2321fccbba0e1cc5a58773452a35e9d2c2ee10ec0bfbf3"
  },
  "ApprovalAnswer": {
    "typeId": "agh.interaction/approval-answer@1",
    "revision": 1,
    "digest": "9ec6aa6d8d5f8d24f5faeb7440651fe0d45493667e6917ec946c1e9751f31f60"
  },
  "CommandRuntimeAcceptanceResult": {
    "typeId": "agh.domain/command-runtime-acceptance-result@1",
    "revision": 2,
    "digest": "95d9cd0fb9df39ba0688588b3f467ff565da955b6e64ca53fc6a28c97c7f292d"
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
  },
  "StateLeaseRecordValue": {
    "typeId": "agh.runtime/state-lease-record@1",
    "revision": 1,
    "digest": "de2aeb270d509b3ef19b2b46899881e1fe334568c75eb80c55179fe5f3e95b6f"
  },
  "StateWriteOpenProofValue": {
    "typeId": "agh.runtime/state-write-open-proof@1",
    "revision": 1,
    "digest": "8c27594ae21e2959db32c15e097babc0c211987a3ddb712d2fbb79589139e5ec"
  },
  "StateLeaseProofValue": {
    "typeId": "agh.runtime/state-lease-proof@1",
    "revision": 1,
    "digest": "a31ad1e3dcdd25d6cde59bd4d8b0d7ff0fa75694d6398c7861ae7a0c03ea3e42"
  },
  "SessionIdentityValue": {
    "typeId": "agh.runtime/session-identity-record@1",
    "revision": 2,
    "digest": "7a0d20e88bfbf51467f601653ee0ea04a9627ed251ede21230bf2e7b3f451c31"
  },
  "RunRecordValue": {
    "typeId": "agh.runtime/run-record@1",
    "revision": 2,
    "digest": "9cb4d13895dafd0317516208cdf184efff45957d94d5b002e2b2ef2045128dd0"
  },
  "RunBinding": {
    "typeId": "agh.runtime/run-binding@1",
    "revision": 2,
    "digest": "0f0daee8d4ea4b05023ffaf870b3aafe88e6a97c1c55cfb694664a08f9426f8f"
  },
  "RunTaintRecordValue": {
    "typeId": "agh.runtime/run-taint-record@1",
    "revision": 2,
    "digest": "81c28e008e24aa495846cb3b056d3dbada4dbb2842f7e9f3c5134e9a8ab5dbaa"
  },
  "ActionRecordValue": {
    "typeId": "agh.runtime/action-record@1",
    "revision": 2,
    "digest": "54a2874964b0369294d9e9418c5fb0a230d117bb8f04c8a6deca3a7e547e85a8"
  },
  "AttemptRecordValue": {
    "typeId": "agh.runtime/attempt-record@1",
    "revision": 2,
    "digest": "eab4ca6b86cb1f2a684708b43f87de2a45f580fdd78eeedc3f4e3559f18847ca"
  },
  "RunQuotaValue": {
    "typeId": "agh.runtime/run-quota@1",
    "revision": 2,
    "digest": "b5879b855c8e7c683a1733a0065f4010f5f92e8ec25a13904463749ad5350134"
  },
  "InvocationValue": {
    "typeId": "agh.runtime/invocation@1",
    "revision": 2,
    "digest": "ae6987d1a5e8d0ee6c6b9aa28824cbe82ab519a9ad9a65820eccf19f9448ac5d"
  },
  "PrepareQueryQuotaValue": {
    "typeId": "agh.runtime/prepare-query-quota@1",
    "revision": 2,
    "digest": "c46b57f2fed3b593ba3466a74b090b2188ecea543150f668d35b170587656c31"
  },
  "QueryGrantValue": {
    "typeId": "agh.runtime/query-grant@1",
    "revision": 2,
    "digest": "bb9d42369b6e56b3050b0993e7e3985c736a2b7c6af4d0b3513a58193544b37c"
  },
  "DispatchAdmissionRecordValue": {
    "typeId": "agh.runtime/dispatch-admission@1",
    "revision": 2,
    "digest": "d20185ac62930abb36a2670494a1cb3525ef0e772a05a15387087d4611657b0c"
  },
  "ReceiptRecordValue": {
    "typeId": "agh.runtime/receipt-record@1",
    "revision": 2,
    "digest": "b2d33ea69d5fc4046c5cc5524bc0c3e35960f950af7e0272e8507339dee63cb8"
  },
  "QuotaReservationMirrorValue": {
    "typeId": "agh.runtime/quota-mirror@1",
    "revision": 2,
    "digest": "669387e07f64b03223f7ab829866d90ea97367089d22d55756d8e7869da62713"
  },
  "SignalRecordValue": {
    "typeId": "agh.runtime/signal-record@1",
    "revision": 2,
    "digest": "bbf186433bff7bdcf3d82c0648bf2dbef20fbc0ea48f36b38c91f50b774ecc87"
  },
  "ActionVisibilityValue": {
    "typeId": "agh.runtime/action-visibility@1",
    "revision": 2,
    "digest": "1600b14139f2ca6c0f03c49747835cd3eaab734c25a2e1071aea598d3543e5d8"
  },
  "UsageMirrorValue": {
    "typeId": "agh.runtime/usage-mirror@1",
    "revision": 2,
    "digest": "6cde4132301a3d071485ecc0f61d6fc31d60b488bf1d1d6a583268135bfd112c"
  },
  "OutboxRecord": {
    "typeId": "agh.runtime/outbox-record@1",
    "revision": 3,
    "digest": "b95767ed5b1761a9507b2fc826425aa7922bbedab927a621081bbb6e8224dee0"
  },
  "ReferenceRecordValue": {
    "typeId": "agh.runtime/reference-record@1",
    "revision": 2,
    "digest": "d641cf854a83b7108f1a651604389d3fadbffb43c094dc90094a15e087d9dbec"
  },
  "InteractionRecord": {
    "typeId": "agh.interaction/interaction-record@1",
    "revision": 3,
    "digest": "cfab7e60603cc5951f36af9c576f27bcc98418a55e2c25d97678368bb36b3a52"
  },
  "InboxRecord": {
    "typeId": "agh.runtime/inbox-record@1",
    "revision": 3,
    "digest": "bc028829ce1eb1af4f63c14d0f30a42dca0b3fa4b9961716b2e67dbb660cfc43"
  },
  "ApprovalTaintAckRecordValue": {
    "typeId": "agh.runtime/approval-taint-ack-record@1",
    "revision": 2,
    "digest": "aae583f8182eb94340cd54f3c0d7b38123bfe877bafc6a8e035e323c9944c17b"
  },
  "AuthorizationPreparation": {
    "typeId": "agh.runtime/authorization-preparation@1",
    "revision": 3,
    "digest": "190e55f89c05df1d4c37a427d2457b572efafa5b2c5c25e5aae8994adda07d18"
  },
  "ApprovalRespondRequest": {
    "typeId": "agh.interaction/approval-respond-request@1",
    "revision": 2,
    "digest": "81cc1e2040e97632a5d0467a100b54cec8c5bbe2e28bafc217d1ca16c5a459e3"
  },
  "CommitControlRequest": {
    "typeId": "agh.state/commitControl.request@1",
    "revision": 3,
    "digest": "8a1b4727c0792ac5ae39fece09c4a78d1443efa4818a7ae61c0bfc12a88556e5"
  }
} as const)
export const RuntimeMethodSchemaRefs = freeze({
  "agh.loop": {
    "start": {
      "input": {
        "typeId": "agh.loop/start.request@1",
        "revision": 2,
        "digest": "f493d97e0186d139a85e5a88b314765eeb0adb7b1d3a4300e7e592352fbcb912"
      },
      "output": {
        "typeId": "agh.loop/start.response@1",
        "revision": 2,
        "digest": "33aec7b8b0987283dee9b17150f7af99b630860fdcdb07f571e40af4d09e6105"
      }
    },
    "resume": {
      "input": {
        "typeId": "agh.loop/resume.request@1",
        "revision": 2,
        "digest": "f493d97e0186d139a85e5a88b314765eeb0adb7b1d3a4300e7e592352fbcb912"
      },
      "output": {
        "typeId": "agh.loop/resume.response@1",
        "revision": 2,
        "digest": "33aec7b8b0987283dee9b17150f7af99b630860fdcdb07f571e40af4d09e6105"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.loop/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.loop/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.loop/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.loop/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.loop/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 3,
        "digest": "06d66aa1e3abd8c1d2d3e11d17dab327de928eaf664c84a38ef34b33e57addaf"
      },
      "output": {
        "typeId": "agh.context/view.response@1",
        "revision": 3,
        "digest": "21b06b80c2015a5a954c56425a383b81bcfd411ddd20ca02097c3200d92dc733"
      }
    },
    "prepareView": {
      "input": {
        "typeId": "agh.context/prepareView.request@1",
        "revision": 3,
        "digest": "b449ca112f88231f0e4c75c57c75a7b472590c297e237e8d24fcec619539e9b5"
      },
      "output": {
        "typeId": "agh.context/prepareView.response@1",
        "revision": 3,
        "digest": "21b06b80c2015a5a954c56425a383b81bcfd411ddd20ca02097c3200d92dc733"
      }
    },
    "refresh": {
      "input": {
        "typeId": "agh.context/refresh.request@1",
        "revision": 3,
        "digest": "47051bac9d7f12f093c7b2ec1f2c23ccd0a8d76bb707b6838752c5b1e4845d09"
      },
      "output": {
        "typeId": "agh.context/refresh.response@1",
        "revision": 3,
        "digest": "77c6e8d703ba5e13f9c4603e34d832beea763e6798b2d10de7e760fadfeb3a82"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.context/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.context/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.context/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.context/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.context/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 3,
        "digest": "56d89f9aa399c8c92222ad22be9bd5ccb3832ebe45bb7eb213f77c9ffeca6f55"
      },
      "output": {
        "typeId": "agh.compaction/plan.response@1",
        "revision": 3,
        "digest": "310005a6c7246c024a3f26cfa22d461db49836321adeedb42fa223b68cc89f3c"
      }
    },
    "preparePlan": {
      "input": {
        "typeId": "agh.compaction/preparePlan.request@1",
        "revision": 3,
        "digest": "f48495e8170692b66dca5bbb561c11e6bdf4360ecfd6027209c85e8440b28f6c"
      },
      "output": {
        "typeId": "agh.compaction/preparePlan.response@1",
        "revision": 3,
        "digest": "310005a6c7246c024a3f26cfa22d461db49836321adeedb42fa223b68cc89f3c"
      }
    },
    "execute": {
      "input": {
        "typeId": "agh.compaction/execute.request@1",
        "revision": 3,
        "digest": "32c52091ef9a4a5f362c2a59197107146a26d22962bc371b0c8eae8340c90677"
      },
      "output": {
        "typeId": "agh.compaction/execute.response@1",
        "revision": 3,
        "digest": "bfb0bd8d6e968734d283bf224c782f34a9ca4619f846e205018c5d2ae253d480"
      }
    },
    "apply": {
      "input": {
        "typeId": "agh.compaction/apply.request@1",
        "revision": 3,
        "digest": "18b9988ab1f11772a691367088878ccec60c7658c54140c087691d2604c5fb5f"
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
        "revision": 3,
        "digest": "7f1d08d88248a02057689bb62b883a2a430ad73dd7527dfc585ca7c02fcc788f"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.compaction/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.compaction/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.compaction/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.compaction/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.compaction/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 4,
        "digest": "a5b0c00c0de54f74579da61f0bf410c4ea4168db29428d757b607b312420c7f1"
      },
      "output": {
        "typeId": "agh.model/prepare.response@1",
        "revision": 3,
        "digest": "5b203e917500b077197b6d889837572dbb87600d9d8d4078c80dba66254a3d8b"
      }
    },
    "prepareRequest": {
      "input": {
        "typeId": "agh.model/prepareRequest.request@1",
        "revision": 4,
        "digest": "c0a400765ccc44813d66284d830073812afb89c29ef71c82a95c92635c340c5a"
      },
      "output": {
        "typeId": "agh.model/prepareRequest.response@1",
        "revision": 3,
        "digest": "80f67c4e36d7b97be08f6ccd575be8f50ca00a822525ba213ab3b0fb4cb926b5"
      }
    },
    "infer": {
      "input": {
        "typeId": "agh.model/infer.request@1",
        "revision": 2,
        "digest": "6cddde2965d5393fd725983766f8694678d6e895caec57d705507d3d5638ae76"
      },
      "output": {
        "typeId": "agh.model/infer.response@1",
        "revision": 2,
        "digest": "82a9cb8b8a0756940c1050504808ccfc6202b3ec27991f0c7e185d003e6c11e2"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.model/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.model/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.model/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.model/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.model/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 3,
        "digest": "e0dad8f5d28ca6826124158cd6496afc89a9515ded48194593068292c987f73d"
      },
      "output": {
        "typeId": "agh.routing/select.response@1",
        "revision": 2,
        "digest": "eb08a582f1e598cdf6102e26a3a5498d0afb0880e27e6a77e0e4148eb57edfd1"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.routing/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.routing/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.routing/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.routing/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.routing/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 3,
        "digest": "36a1b4b0bbc0347d066b9d3ee16631de83bcb0caf5ede6dde4837e8a05b4dac8"
      },
      "output": {
        "typeId": "agh.media/prepare.response@1",
        "revision": 3,
        "digest": "a8f85ce9d57392c8e53fed5cb149040548c1da1e0dc6cc3c29982534b0819209"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.media/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.media/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.media/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.media/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.media/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "a25e4f31c34dc319a66a0d5c12001e1701cfd35d8504ccf0562500eaa4555b15"
      },
      "output": {
        "typeId": "agh.model-adapter/invoke.response@1",
        "revision": 2,
        "digest": "82a9cb8b8a0756940c1050504808ccfc6202b3ec27991f0c7e185d003e6c11e2"
      }
    },
    "reconcile": {
      "input": {
        "typeId": "agh.model-adapter/reconcile.request@1",
        "revision": 2,
        "digest": "4f6cc0d3db5e5574e0ef7c38c1ae014a7898c09e5ae3863476254522e2476a1c"
      },
      "output": {
        "typeId": "agh.model-adapter/reconcile.response@1",
        "revision": 2,
        "digest": "7624ed5a5bd113795400113e8792c85796e8485b0b840323c9ca8d83eaf83fd8"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.model-adapter/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.model-adapter/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.model-adapter/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.model-adapter/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.model-adapter/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 3,
        "digest": "7053143b6a5ec739c836f72ff34300f2d16f1b8bdd318708fdecbdf79f57de41"
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
        "revision": 3,
        "digest": "95dc8f477e247ad5affac69c42e9d5778ffc9c254784608315761e5fd0a1d33c"
      }
    },
    "register": {
      "input": {
        "typeId": "agh.resources/register.request@1",
        "revision": 3,
        "digest": "498e2f1d3018c32efbb6368ceff7b9b69f51b9baf5041e408b8262aa6c2fe511"
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
        "revision": 3,
        "digest": "0833e37ad54a3ba795e73244fdb3aeaae6ba757fbd18fa73d7383e80a3dd5194"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.resources/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.resources/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.resources/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.resources/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.resources/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "a65c3515f14fa9f7efdb25451be1e411e58d4f968a43b0fe051dc358d221264b"
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
        "revision": 2,
        "digest": "5dd9ef8cb6b59fa1881828cf4a88fe034a8c64795494a88cb998eabd65df3758"
      },
      "output": {
        "typeId": "agh.mcp/call.response@1",
        "revision": 2,
        "digest": "e4565902ea86bc62951cc08320379dde5408b5d12c3524df706cc9e9d4cdf99e"
      }
    },
    "read": {
      "input": {
        "typeId": "agh.mcp/read.request@1",
        "revision": 2,
        "digest": "e1a7f68b1c0015c5add950f5afe9402f286bcc8e52e515385620d45d6d0329d9"
      },
      "output": {
        "typeId": "agh.mcp/read.response@1",
        "revision": 2,
        "digest": "de62e5d3fbb2fb97dafdd45789024b5f9079cc4c2e062c3ba32922488d06f075"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.mcp/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.mcp/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.mcp/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.mcp/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.mcp/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "18b9fd54894ff3244cdf02835ca9508c7e8744b6f2f4945aeedbcfbfb32f4db5"
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
        "revision": 2,
        "digest": "ce8f266b0e108014a39222374cce091ee1bee90a6d2351dab90bbae6d06de4ff"
      }
    },
    "classify": {
      "input": {
        "typeId": "agh.tools/classify.request@1",
        "revision": 2,
        "digest": "1f9d9c68aaa87b8dbd8157f3e829e6bb3e361b2d7985d33d653817eb37e488ee"
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
        "revision": 3,
        "digest": "e529a8e718d15c9f3c4bcd7201a34c6f0379509c9538d3b5818c010fb9df8415"
      },
      "output": {
        "typeId": "agh.tools/catalog.response@1",
        "revision": 2,
        "digest": "e260805dadc28bee5ce5287723b136c15f500513dc9e1f719b3c378552c2ee40"
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
        "revision": 2,
        "digest": "ade025edd516cd41864b80715190fefae2c9a1bd3a6ea5070452ba6fb12b6d92"
      },
      "output": {
        "typeId": "agh.tools/invoke.response@1",
        "revision": 3,
        "digest": "0945030f2ae07fa4a465af3abc590425c5e1ae765a342159c971522b97850c95"
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
        "revision": 2,
        "digest": "1cb42cbe889debd3fba6ab87d74de66b7f5d9467c266deb8565ca0c7823a7582"
      },
      "output": {
        "typeId": "agh.tools/reconcile.response@1",
        "revision": 2,
        "digest": "7624ed5a5bd113795400113e8792c85796e8485b0b840323c9ca8d83eaf83fd8"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.tools/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.tools/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.tools/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.tools/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.tools/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 3,
        "digest": "ece230d46bdeba927391668262ed93cabbf5af428d1d03cf126806c04cb4ffd5"
      },
      "output": {
        "typeId": "agh.memory/remember.response@1",
        "revision": 2,
        "digest": "24f19325e5c296047d0175c745a3de618024ce7101faf2c2d686128490ec30e9"
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
        "revision": 3,
        "digest": "2d1dde4b77571d6365e4ffa0ed0a9fc51618a3c2c534da34fd160871f782f571"
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
        "revision": 3,
        "digest": "3a2baeabfa71be41a2ead9c27f3775f7e5bec6973e6ee8298613e87f7d9e2d91"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.memory/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.memory/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.memory/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.memory/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.memory/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "8e51450dcbe27cd2389ad1317734021cde5ff9037fb9d1b46bfc3da20d9bf194"
      },
      "output": {
        "typeId": "agh.retrieval/search.response@1",
        "revision": 3,
        "digest": "31d08193826d57d8c38d6d982c5eb20a40dd060f2049b13c344de864f3bca4d4"
      }
    },
    "searchRemote": {
      "input": {
        "typeId": "agh.retrieval/searchRemote.request@1",
        "revision": 2,
        "digest": "8c31dd6db51cc9975b72df79d01f025bea0d98554a7c0d7a66b683ec0188b44f"
      },
      "output": {
        "typeId": "agh.retrieval/searchRemote.response@1",
        "revision": 3,
        "digest": "05bbe28e621b052b641eca834f3edb7f41067517584e3be92a54b367588a0468"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.retrieval/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.retrieval/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.retrieval/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.retrieval/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.retrieval/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 3,
        "digest": "03b5df3c42be5fb5399d4887238fd52dddce9c9f01644c95724a094febfad98f"
      },
      "output": {
        "typeId": "agh.embedding/encode.response@1",
        "revision": 2,
        "digest": "c2ca34368b9098cbdfc944bdbea83561dcdf6695553217f4a3add7c580a31beb"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.embedding/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.embedding/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.embedding/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.embedding/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.embedding/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "f0f616741684e4fceb4aee2bfa0e4b4231eabd8c3eb86f6101386ad6106d84f5"
      },
      "output": {
        "typeId": "agh.identity/authenticate.response@1",
        "revision": 2,
        "digest": "d360ad6ffe0e020dddf1029aacdcde4e1f9758227ba42d903766e8cdd0020ea9"
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
        "revision": 2,
        "digest": "d360ad6ffe0e020dddf1029aacdcde4e1f9758227ba42d903766e8cdd0020ea9"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.identity/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.identity/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.identity/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.identity/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.identity/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 3,
        "digest": "055e2b5aa7c7fe85ba2f952c60623bb13c062994ed4dab1e0228daef4edfacf8"
      },
      "output": {
        "typeId": "agh.policy/evaluate.response@1",
        "revision": 3,
        "digest": "b0cbcd06bf0a7dddf37210a91ce6a7cc3057837e3d4228b6d117336acd87b487"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.policy/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.policy/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.policy/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.policy/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.policy/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "5cd7c619e686722977673ef6b336a4d5bc43795a782fb9200f478ab6c2bf0cb2"
      },
      "output": {
        "typeId": "agh.effects/runHooks.response@1",
        "revision": 2,
        "digest": "e221e4decc7ae081affdc7a200ba4e1c4e8063f52a42f643ebf781ff9d503156"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.effects/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.effects/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.effects/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.effects/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.effects/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.workspace/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.workspace/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.workspace/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.workspace/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.workspace/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.files/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.files/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.files/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.files/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.files/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.sandbox/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.sandbox/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.sandbox/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.sandbox/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.sandbox/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "7624ed5a5bd113795400113e8792c85796e8485b0b840323c9ca8d83eaf83fd8"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.exec/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.exec/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.exec/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.exec/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.exec/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "fe984c6e740e3146253e437b493800efc7c95a6bea3f3824ed54a4d7bb6723cb"
      },
      "output": {
        "typeId": "agh.network/request.response@1",
        "revision": 2,
        "digest": "30152ff785246f332407b348348cd5227e07597fd765f108d29ded32c76e701f"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.network/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.network/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.network/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.network/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.network/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.secrets/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.secrets/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.secrets/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.secrets/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.secrets/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 3,
        "digest": "55db174ec9ca2785bab35e5e9d1a719885e9cedeb201e11ba07f4fb803f9875c"
      },
      "output": {
        "typeId": "agh.interaction/request.response@1",
        "revision": 3,
        "digest": "cfab7e60603cc5951f36af9c576f27bcc98418a55e2c25d97678368bb36b3a52"
      }
    },
    "respond": {
      "input": {
        "typeId": "agh.interaction/respond.request@1",
        "revision": 2,
        "digest": "16273ab88eb8cbd9a79895c7cd0f79ead64f59a4aa4bfab730e3f8d0af000006"
      },
      "output": {
        "typeId": "agh.interaction/respond.response@1",
        "revision": 3,
        "digest": "0642b8f012d8f107f3d5369e20cb1c53654da35a31aa5d299920d94ce324b75b"
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
        "revision": 3,
        "digest": "cfab7e60603cc5951f36af9c576f27bcc98418a55e2c25d97678368bb36b3a52"
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
        "revision": 3,
        "digest": "cfab7e60603cc5951f36af9c576f27bcc98418a55e2c25d97678368bb36b3a52"
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
        "revision": 3,
        "digest": "cfab7e60603cc5951f36af9c576f27bcc98418a55e2c25d97678368bb36b3a52"
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
        "revision": 3,
        "digest": "a57095bd4925d332672bfac01140dcf21c3285ac92dfe830d4946b2542011a9d"
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
        "revision": 3,
        "digest": "0642b8f012d8f107f3d5369e20cb1c53654da35a31aa5d299920d94ce324b75b"
      }
    },
    "acceptResponse": {
      "input": {
        "typeId": "agh.interaction/acceptResponse.request@1",
        "revision": 2,
        "digest": "80629f78f745ef55e488654d738a492a2c421e41414536494edc5a2ee3ee0213"
      },
      "output": {
        "typeId": "agh.interaction/acceptResponse.response@1",
        "revision": 3,
        "digest": "0642b8f012d8f107f3d5369e20cb1c53654da35a31aa5d299920d94ce324b75b"
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
        "revision": 3,
        "digest": "0642b8f012d8f107f3d5369e20cb1c53654da35a31aa5d299920d94ce324b75b"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.interaction/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.interaction/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.interaction/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.interaction/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.interaction/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "b9420832dd7f47deb7950c5062ab61447e352f8047fd21a78fdf63aa1bb6245d"
      },
      "output": {
        "typeId": "agh.recovery/inspect.response@1",
        "revision": 2,
        "digest": "5b7d9a3c6ec11237173553c7eb0875bb7d3e1760d8da6ccbb063fd2867ca7a43"
      }
    },
    "restore": {
      "input": {
        "typeId": "agh.recovery/restore.request@1",
        "revision": 2,
        "digest": "ff046e80a9a4a67407facb8180ad46957c304f2c189074dbff7adf5fe1d755b5"
      },
      "output": {
        "typeId": "agh.recovery/restore.response@1",
        "revision": 2,
        "digest": "04b43558c197bb561ad7e7fed03896cc00fd01f6ec34b87b00c839795c541509"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.recovery/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.recovery/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.recovery/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.recovery/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.recovery/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "6e88aed7b9453b3f90f20b59b9a6f5dcdad0909911f7a5d7e884f14cd4c9dc4b"
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
        "revision": 2,
        "digest": "f92f979ca530f341e8b96f577472477674e4992b9210ea7a13188385c76c7f94"
      },
      "output": {
        "typeId": "agh.supervisor/admitServiceCommand.response@1",
        "revision": 2,
        "digest": "b0b8a4b0b2bff688272eb999b0b80b722ad85ce4e6f46cfab67fca4a2cc7e54d"
      }
    },
    "signal": {
      "input": {
        "typeId": "agh.supervisor/signal.request@1",
        "revision": 2,
        "digest": "c05df541758c936ba6878e5db4bf71622a9baf6d62b24f5a86fc175ffc2ae719"
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
        "revision": 2,
        "digest": "46e7522a844832dafec1b377b8dc9a315fb8e38159e2d9a7d6c154586634279d"
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
        "revision": 3,
        "digest": "9a73a1d686a23995ac12abc613aeec95bf7f44d1de1de7c70d14990f8cd0123d"
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
        "revision": 2,
        "digest": "a0b7651bc77f257cd29e0fa75dc184346154d5731cb62b58dbca5db6193d561e"
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
        "revision": 2,
        "digest": "d594a9a6f1851f8b4c2908c5bece5ba529a734ddbf358944f01ff2fbec9bdfad"
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
        "revision": 4,
        "digest": "96381f3d2b3d476a35f2b80491e2fa38606494f47bcc78a19c036cb61e58112a"
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
        "revision": 4,
        "digest": "96381f3d2b3d476a35f2b80491e2fa38606494f47bcc78a19c036cb61e58112a"
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
        "revision": 4,
        "digest": "96381f3d2b3d476a35f2b80491e2fa38606494f47bcc78a19c036cb61e58112a"
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
        "revision": 2,
        "digest": "dd14ac9b071badd5fc9fd10f0174390108b41c9aa88e1814ab967d73db95a367"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.supervisor/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.supervisor/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.supervisor/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.supervisor/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.supervisor/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "1d61b19f0dffb2bf07fd3cbd613e53a673cc1a4cc73e99441f4fec1d4812625d"
      },
      "output": {
        "typeId": "agh.scheduler/enqueue.response@1",
        "revision": 2,
        "digest": "0c4022538685b144ed58578050aa77965f90455e9a31cc5ee5ff71d46805d69b"
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
        "revision": 2,
        "digest": "c5607de78fdbed5c787eed26e9b20c92d955337f5ab1ec002a3a205e06efd7d8"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.scheduler/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.scheduler/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.scheduler/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.scheduler/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.scheduler/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "bf42ed6f7cde211b877eb8d16e504fa4f874ffae1d54bb3faa4fe17b3fa17ada"
      },
      "output": {
        "typeId": "agh.agents/spawn.response@1",
        "revision": 2,
        "digest": "768fd5f777273019d5f6a91271039217e74057b1d40c36f11868c062bc66c207"
      }
    },
    "send": {
      "input": {
        "typeId": "agh.agents/send.request@1",
        "revision": 2,
        "digest": "171ab2daa45a11ec0adda9a51a3b095422aa78277ba6585deeecc1ea97b52443"
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
        "revision": 2,
        "digest": "161222c47ca3c3dd2c31eaf206c3151e44d4f38e85e22be1323822a353eb1c4c"
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
        "revision": 2,
        "digest": "1af2e77c59388cf5c7675fa8869413a8fe183a8947fff3a06e72d104dcc10dbe"
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
        "revision": 2,
        "digest": "cb6eca5674e95d15f9d0f1146ab8ac8d43f53557c6022fdf89a675c07f964787"
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
        "revision": 2,
        "digest": "f7d6259d7843a10fbd7dfac58031d5c2d692e71874c3e3c99098954fc090f51e"
      },
      "output": {
        "typeId": "agh.agents/inspect.response@1",
        "revision": 2,
        "digest": "09be617d22709e7ff040a9bae4feae7a6adba0706766bc5e10e8d294d9bc49d6"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.agents/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.agents/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.agents/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.agents/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.agents/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "3f733d54959fba58ff266fa8cdcd0aa6b4e8cab692e0927b3492d42814718198"
      },
      "output": {
        "typeId": "agh.jobs/requestCreate.response@1",
        "revision": 2,
        "digest": "625351c227fe55778a6906bfc35583bdc9720612d7a6ff90bf892e754446f099"
      }
    },
    "requestUpdate": {
      "input": {
        "typeId": "agh.jobs/requestUpdate.request@1",
        "revision": 2,
        "digest": "ba7cf12828221a6b3571b6e1a25e8880a03f9324539f697766a5f71453a5e019"
      },
      "output": {
        "typeId": "agh.jobs/requestUpdate.response@1",
        "revision": 2,
        "digest": "625351c227fe55778a6906bfc35583bdc9720612d7a6ff90bf892e754446f099"
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
        "revision": 2,
        "digest": "6a630325e875196b768a586bc958011949de959bbd697278971a60a02b1175ef"
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
        "revision": 2,
        "digest": "0eb81d05fb518fe39b35ae126759f655b7f785cd5f15325088854383f4f284ef"
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
        "revision": 2,
        "digest": "7cc440557a3de9f00cac2a19a031ad129030b4b280a6c62925439c26b22ef6dd"
      },
      "output": {
        "typeId": "agh.jobs/reserveDetached.response@1",
        "revision": 2,
        "digest": "0eb81d05fb518fe39b35ae126759f655b7f785cd5f15325088854383f4f284ef"
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
        "revision": 2,
        "digest": "0eb81d05fb518fe39b35ae126759f655b7f785cd5f15325088854383f4f284ef"
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
        "revision": 2,
        "digest": "0eb81d05fb518fe39b35ae126759f655b7f785cd5f15325088854383f4f284ef"
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
        "revision": 2,
        "digest": "97bf5ea2566a41bdf2e9bd7c462750699935f28cddb4c4ea10c547adf50a8e93"
      }
    },
    "createDefinition": {
      "input": {
        "typeId": "agh.jobs/createDefinition.request@1",
        "revision": 2,
        "digest": "bd7c05660dc30406f028b79ae5534f86903078fdaf164c7d815db934f6f1786c"
      },
      "output": {
        "typeId": "agh.jobs/createDefinition.response@1",
        "revision": 2,
        "digest": "625351c227fe55778a6906bfc35583bdc9720612d7a6ff90bf892e754446f099"
      }
    },
    "updateDefinition": {
      "input": {
        "typeId": "agh.jobs/updateDefinition.request@1",
        "revision": 2,
        "digest": "be49afe651e7eb84e8835b6454117919fc0448b77f7fe02b24ac9be1df0d933c"
      },
      "output": {
        "typeId": "agh.jobs/updateDefinition.response@1",
        "revision": 2,
        "digest": "625351c227fe55778a6906bfc35583bdc9720612d7a6ff90bf892e754446f099"
      }
    },
    "cancelDefinition": {
      "input": {
        "typeId": "agh.jobs/cancelDefinition.request@1",
        "revision": 2,
        "digest": "36086c9b12e679db62adc3fc89860ebf6b21e0541cf33d3d6713d34fd8e111fc"
      },
      "output": {
        "typeId": "agh.jobs/cancelDefinition.response@1",
        "revision": 2,
        "digest": "6a630325e875196b768a586bc958011949de959bbd697278971a60a02b1175ef"
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
        "revision": 2,
        "digest": "0a810267ec1bf8a4657bedd5bf5f120718d397e4797271090cf5fada47e894db"
      },
      "output": {
        "typeId": "agh.jobs/acceptCreateDefinition.response@1",
        "revision": 4,
        "digest": "96381f3d2b3d476a35f2b80491e2fa38606494f47bcc78a19c036cb61e58112a"
      }
    },
    "acceptUpdateDefinition": {
      "input": {
        "typeId": "agh.jobs/acceptUpdateDefinition.request@1",
        "revision": 2,
        "digest": "521cdd54be829e81cf1c5e4437f63c2f7e7a0a669162696dbbc4be968b691393"
      },
      "output": {
        "typeId": "agh.jobs/acceptUpdateDefinition.response@1",
        "revision": 4,
        "digest": "96381f3d2b3d476a35f2b80491e2fa38606494f47bcc78a19c036cb61e58112a"
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
        "revision": 4,
        "digest": "96381f3d2b3d476a35f2b80491e2fa38606494f47bcc78a19c036cb61e58112a"
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
        "revision": 4,
        "digest": "96381f3d2b3d476a35f2b80491e2fa38606494f47bcc78a19c036cb61e58112a"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.jobs/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.jobs/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.jobs/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.jobs/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.jobs/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 3,
        "digest": "b5b846a0d20f53cf3d7f8f6e05e3dc9105b16b56fc7ba9ac8847337333175372"
      },
      "output": {
        "typeId": "agh.artifacts/reserve.response@1",
        "revision": 3,
        "digest": "dabf1574a2ee32de6fe46ba3b4bcbbc875db77b4d8ca7ee257383518fd2fad91"
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
        "revision": 3,
        "digest": "dabf1574a2ee32de6fe46ba3b4bcbbc875db77b4d8ca7ee257383518fd2fad91"
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
        "revision": 3,
        "digest": "dabf1574a2ee32de6fe46ba3b4bcbbc875db77b4d8ca7ee257383518fd2fad91"
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
        "revision": 3,
        "digest": "dabf1574a2ee32de6fe46ba3b4bcbbc875db77b4d8ca7ee257383518fd2fad91"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.artifacts/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.artifacts/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.artifacts/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.artifacts/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.artifacts/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 3,
        "digest": "fc5e8a5a5b67cc928dc1cdf1765f10f769117e8bc8b1332901364d0f3d88b318"
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
        "revision": 3,
        "digest": "90ab7629e0727f6b7f67a226c5fe257c6c4c5da73221d31e62063f61f9d2ac48"
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
        "revision": 3,
        "digest": "7079c9e5563a4c03af1ed89fc520d456d07af7a211ac904930e5525033459f93"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.blob/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.blob/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.blob/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.blob/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.blob/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "b386997b206b0e74055f2d1ec0c168829bd092893d1c8aa5cece6a97fe889c18"
      },
      "output": {
        "typeId": "agh.budget/reserve.response@1",
        "revision": 2,
        "digest": "7a6b0e2a4d3a76591e9d8a151d51103c70538f8ac57daa20a45d77374a978146"
      }
    },
    "settle": {
      "input": {
        "typeId": "agh.budget/settle.request@1",
        "revision": 2,
        "digest": "3781cefde335fc48a6798ba9ed079c9a28052d102737853caf2794980a7b3163"
      },
      "output": {
        "typeId": "agh.budget/settle.response@1",
        "revision": 2,
        "digest": "4729d80442ad94899fe452d3a37d5b57cd8bd674757f371e7d613f23ad958fcd"
      }
    },
    "reconcile": {
      "input": {
        "typeId": "agh.budget/reconcile.request@1",
        "revision": 2,
        "digest": "aebfae69c497d04bd3e654aa1a1de82f35142387724e3f95b1a8eaddad2f0b57"
      },
      "output": {
        "typeId": "agh.budget/reconcile.response@1",
        "revision": 2,
        "digest": "01234bc1ab7ddce4bb0af2bfc7ff8f7fc84fbc9b08c38a0884a93e21c168a37f"
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
        "revision": 2,
        "digest": "6b5e960b0d686f2c9eda7b9b12bb821f91b3a7dc36150777664865b8a7fbacdd"
      }
    },
    "releaseQuota": {
      "input": {
        "typeId": "agh.budget/releaseQuota.request@1",
        "revision": 2,
        "digest": "b5d9f5e3f65c70aa2eb98c849b8a38014482376a09936ee893230d3ef0750f94"
      },
      "output": {
        "typeId": "agh.budget/releaseQuota.response@1",
        "revision": 2,
        "digest": "6b5e960b0d686f2c9eda7b9b12bb821f91b3a7dc36150777664865b8a7fbacdd"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.budget/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.budget/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.budget/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.budget/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.budget/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 3,
        "digest": "d2c73edad9abac443545d0cdc39df951b84b6787027aa032a2ddb8776f1741a3"
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
        "revision": 2,
        "digest": "a898995bf5413e12364d1a749f484456c7468c66e7ab2f9eddc77c5b0fd63287"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.usage/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.usage/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.usage/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.usage/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.usage/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.pricing/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.pricing/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.pricing/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.pricing/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.pricing/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "c2cb909b6b8288d01733adf1c76984e3400d55a576753017feb8c59efc7a0b74"
      },
      "output": {
        "typeId": "agh.billing/post.response@1",
        "revision": 2,
        "digest": "4a409e7ee1f8594104bb5945946e15cb5ec75ddcf59a9b299be38d0d4a909451"
      }
    },
    "refund": {
      "input": {
        "typeId": "agh.billing/refund.request@1",
        "revision": 2,
        "digest": "6a1a5d7e0bbdc6c3e506ff6772602701083bf0cb1de011a151a264f792b0347e"
      },
      "output": {
        "typeId": "agh.billing/refund.response@1",
        "revision": 2,
        "digest": "4a409e7ee1f8594104bb5945946e15cb5ec75ddcf59a9b299be38d0d4a909451"
      }
    },
    "reconcile": {
      "input": {
        "typeId": "agh.billing/reconcile.request@1",
        "revision": 2,
        "digest": "11df6dfadc169a112679eef56c67f5a2834d99225a860141f09928bb37f25156"
      },
      "output": {
        "typeId": "agh.billing/reconcile.response@1",
        "revision": 2,
        "digest": "4a409e7ee1f8594104bb5945946e15cb5ec75ddcf59a9b299be38d0d4a909451"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.billing/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.billing/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.billing/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.billing/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.billing/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 3,
        "digest": "1f02c91ce82b916c299f1531a897eda16e2ba27d943bf7173403c9279747e020"
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
        "revision": 2,
        "digest": "cac6610b563b3c280b3bf49f95a0372f376a0308eac697014829889f599e2d29"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.audit/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.audit/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.audit/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.audit/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.audit/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "361dd0755aecd5fa52064910a56908f19925fafff3440dc2c0663a55c1a19efe"
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
        "revision": 2,
        "digest": "e033a74033211db9a08ac4436cd8778add2af302ed10e5f79b3beaaae39656ca"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.trace/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.trace/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.trace/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.trace/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.trace/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "cb28f1c8147218a84b54da76c70f46043bd050937be11ee3478d48d5763cb6ca"
      },
      "output": {
        "typeId": "agh.events/subscribe.response@1",
        "revision": 3,
        "digest": "4161ffcf711fbadf9b5f7edb154ac77c907cb28dd801c13e64d3cc8aaf7443d7"
      }
    },
    "publish": {
      "input": {
        "typeId": "agh.events/publish.request@1",
        "revision": 3,
        "digest": "91faf66a1735bd08d92039a501ba61aacca04d0e702fabcd48461cb4a115723e"
      },
      "output": {
        "typeId": "agh.events/publish.response@1",
        "revision": 3,
        "digest": "253452d665a4b956633027dec9bbf42679306f88e7571439b8f34f72c88538cb"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.events/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.events/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.events/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.events/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.events/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 3,
        "digest": "938bdfe5063095f52ed4fba5b27605e9d0b7cdaf39343a3b711a5ab4ddee3386"
      },
      "output": {
        "typeId": "agh.projection/snapshot.response@1",
        "revision": 3,
        "digest": "797906be8ffa896388284a1f607cdf8f8bb42c27f4da2f5e83f95493ee01b9ce"
      }
    },
    "changes": {
      "input": {
        "typeId": "agh.projection/changes.request@1",
        "revision": 3,
        "digest": "f8a4aa83119f47ae7ffac5d0c6efd1ac9aba3acc20996788cafabbaeacc56d58"
      },
      "output": {
        "typeId": "agh.projection/changes.response@1",
        "revision": 3,
        "digest": "016bda150afd206ca2427c09aeb61dba5e1b8d0b35f3433dc8faac38812a14d8"
      }
    },
    "command": {
      "input": {
        "typeId": "agh.projection/command.request@1",
        "revision": 3,
        "digest": "990987a7bbac062aa8698467e31099b7d332f0e73aae821ece6a6bd8249d1db8"
      },
      "output": {
        "typeId": "agh.projection/command.response@1",
        "revision": 4,
        "digest": "96381f3d2b3d476a35f2b80491e2fa38606494f47bcc78a19c036cb61e58112a"
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
        "revision": 4,
        "digest": "3f53c1f14c22ebefa40213f81ce5335fb1f244ab101c01f867b87e74b594d870"
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
        "revision": 4,
        "digest": "3f53c1f14c22ebefa40213f81ce5335fb1f244ab101c01f867b87e74b594d870"
      }
    },
    "acceptCommand": {
      "input": {
        "typeId": "agh.projection/acceptCommand.request@1",
        "revision": 3,
        "digest": "990987a7bbac062aa8698467e31099b7d332f0e73aae821ece6a6bd8249d1db8"
      },
      "output": {
        "typeId": "agh.projection/acceptCommand.response@1",
        "revision": 4,
        "digest": "96381f3d2b3d476a35f2b80491e2fa38606494f47bcc78a19c036cb61e58112a"
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
        "revision": 4,
        "digest": "96381f3d2b3d476a35f2b80491e2fa38606494f47bcc78a19c036cb61e58112a"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.projection/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.projection/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.projection/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.projection/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.projection/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 6,
        "digest": "b7145f21b2a846c7088e707f5698ebfa8ad80e9748d87272b642475c7f491ac8"
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
        "revision": 6,
        "digest": "b7145f21b2a846c7088e707f5698ebfa8ad80e9748d87272b642475c7f491ac8"
      }
    },
    "command": {
      "input": {
        "typeId": "agh.transport/command.request@1",
        "revision": 3,
        "digest": "990987a7bbac062aa8698467e31099b7d332f0e73aae821ece6a6bd8249d1db8"
      },
      "output": {
        "typeId": "agh.transport/command.response@1",
        "revision": 4,
        "digest": "96381f3d2b3d476a35f2b80491e2fa38606494f47bcc78a19c036cb61e58112a"
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
        "revision": 6,
        "digest": "0c21fb099a53d9607854a9324f43a05f53c6a30605cc90af4237d27c779da197"
      }
    },
    "clientQuery": {
      "input": {
        "typeId": "agh.transport/clientQuery.request@1",
        "revision": 3,
        "digest": "5376be1f4eb4c7830d013becf104a50f7a3942e84d83c9801ed3d7fb6e648c90"
      },
      "output": {
        "typeId": "agh.transport/clientQuery.response@1",
        "revision": 5,
        "digest": "35eeb5ff6f74664734af5179c5a8ee657e3fe7baf717e2045b757e5b51dab46d"
      }
    },
    "clientCommand": {
      "input": {
        "typeId": "agh.transport/clientCommand.request@1",
        "revision": 3,
        "digest": "feb2a687ef2d34a559178f78f55e82e7f55ffc0edc3d61cab38da093dc2222ab"
      },
      "output": {
        "typeId": "agh.transport/clientCommand.response@1",
        "revision": 4,
        "digest": "f0f58da2a28a04d46e762859a808b814d40d6d0ba95b492e001e748e1454b44f"
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
        "revision": 6,
        "digest": "cc01c2416cdb74d125255b80716335db14d92e66ae94315f9fffe4e4ac8dee4a"
      }
    },
    "subscribe": {
      "input": {
        "typeId": "agh.transport/subscribe.request@1",
        "revision": 3,
        "digest": "ef815785998a8594ee2db0cf7cacbc8365d3eb5724e4772f9ac2816fa8c0b7be"
      },
      "output": {
        "typeId": "agh.transport/subscribe.response@1",
        "revision": 4,
        "digest": "2114be8062ffaf4715fc3a3a90633e76a378f8a116f87202b44d4dfd72816298"
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
        "revision": 4,
        "digest": "76975b3fa8deb30a506240b83d13dae2fa283b343bbf7a781b037351e0250d07"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.transport/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.transport/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.transport/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.transport/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.transport/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "6b34caae39492e6accae14821fcf5dca3a161d7966e5e8f4091350c3bd3ccdde"
      }
    },
    "reconcile": {
      "input": {
        "typeId": "agh.channel/reconcile.request@1",
        "revision": 2,
        "digest": "f28c2a0bc11eea8be97dd6f49cd2f941eb52c64edc1a0032f21a0e48de265c41"
      },
      "output": {
        "typeId": "agh.channel/reconcile.response@1",
        "revision": 2,
        "digest": "6b34caae39492e6accae14821fcf5dca3a161d7966e5e8f4091350c3bd3ccdde"
      }
    },
    "callback": {
      "input": {
        "typeId": "agh.channel/callback.request@1",
        "revision": 2,
        "digest": "a5f53efa62e7069485d87be254c4a6af4a64e704729343e50677786586079769"
      },
      "output": {
        "typeId": "agh.channel/callback.response@1",
        "revision": 2,
        "digest": "8640097378c8c8fe7f750d44072f226dd93b896628b4f958c46b603ebcf1022a"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.channel/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.channel/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.channel/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.channel/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.channel/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "89d26d414804092a7aecb6ef8d630fd489cfe27c8f886f5a20fb02cb197858e2"
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
        "revision": 2,
        "digest": "2eb6aaeaea09ad467982a081a1ab516814bb2235a7b69f13defbb34f3e0b4e17"
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
        "revision": 2,
        "digest": "1e721560c4209975522f380aff2d69242a0e4e326ecb637bd51477f025757c11"
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
        "revision": 2,
        "digest": "025c8eb4686c188d6a3734628ed5d543c873fdfae48a659b8d048acc2a0e98ce"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.package-source/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.package-source/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.package-source/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.package-source/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.package-source/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "2f6cbd8f85459ce670a0e1f20b0fab1ca98b2d67112bceb51dd16d0246fc7280"
      },
      "output": {
        "typeId": "agh.package-resolver/resolve.response@1",
        "revision": 2,
        "digest": "6544d07d9d1f8f888b5f4b752afbe10509eba6c05f13adf4a8b7eda35b0eeb66"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.package-resolver/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.package-resolver/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.package-resolver/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.package-resolver/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.package-resolver/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "4537f97f92c8e24cd7f0ebeeacd0ccd2cdc9109254e03eb49d5cac1b7ddcd78b"
      },
      "output": {
        "typeId": "agh.package-installer/prepare.response@1",
        "revision": 2,
        "digest": "a7a5eb18b1c16f7be4c71bf44e15aaebdd02dc10cc5fe701e21495b6fa44e809"
      }
    },
    "activate": {
      "input": {
        "typeId": "agh.package-installer/activate.request@1",
        "revision": 2,
        "digest": "b1656ca44fed9602b52687fa6537909d4fa52dc4441ce96051d0dfef226e47b2"
      },
      "output": {
        "typeId": "agh.package-installer/activate.response@1",
        "revision": 2,
        "digest": "f9d9a9636d83b5240b8cd3202d393d2072c705eb4c6cb13010414deeb0c84fc3"
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
        "revision": 2,
        "digest": "726eb53f039dc48a7a18b199f8b67dc84230b7d952063ad53a5b64da63592ba0"
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
        "revision": 2,
        "digest": "ac194bf6bc982d09de70564855cda209a5f691736b097c0bce05d4a7498cb99f"
      },
      "output": {
        "typeId": "agh.package-installer/requestChange.response@1",
        "revision": 2,
        "digest": "0a3f0fe991dbe94bd4923b27e586c3f2b1cbd916236c0a8d5d23d3f4fe63de22"
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
        "revision": 2,
        "digest": "0a3f0fe991dbe94bd4923b27e586c3f2b1cbd916236c0a8d5d23d3f4fe63de22"
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
        "revision": 2,
        "digest": "0a3f0fe991dbe94bd4923b27e586c3f2b1cbd916236c0a8d5d23d3f4fe63de22"
      }
    },
    "applyResourceChange": {
      "input": {
        "typeId": "agh.package-installer/applyResourceChange.request@1",
        "revision": 2,
        "digest": "7054f165c00538cbaadb73550159f97b6f69b1145cf20c83f56d5e9b0fe7e274"
      },
      "output": {
        "typeId": "agh.package-installer/applyResourceChange.response@1",
        "revision": 2,
        "digest": "8922cf000e8362a2fe768935d810ddaab820683a856d15de320c9a3bd4d4bb45"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.package-installer/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.package-installer/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.package-installer/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.package-installer/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.package-installer/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "3d478c746eea5f7940820f368f7c245803cbda34497ba8b5f890a23ce2e03fee"
      }
    },
    "resolve": {
      "input": {
        "typeId": "agh.config/resolve.request@1",
        "revision": 3,
        "digest": "59a11fc931b201e388c5759e55775a83bee536cc2b6c1307b2935a34449ae761"
      },
      "output": {
        "typeId": "agh.config/resolve.response@1",
        "revision": 2,
        "digest": "12221aeb9a0db2fd4d23fd69e62fb26e6c48c6729270459c7324a13742fd26e7"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.config/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.config/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.config/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.config/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.config/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "d00cd098a05cd37310b571347f215d157705afe86dd30a947abbe7590d28819e"
      },
      "output": {
        "typeId": "agh.assembly/plan.response@1",
        "revision": 2,
        "digest": "79536a00dd11f5293b5d14bd763f60dfafc43067070256149dfdfea0e88afb84"
      }
    },
    "prepare": {
      "input": {
        "typeId": "agh.assembly/prepare.request@1",
        "revision": 2,
        "digest": "0d4909dd6d6670e7ed227300f1ee3b7ff3be0c0f5b2bd5bf9e57b83097f3825c"
      },
      "output": {
        "typeId": "agh.assembly/prepare.response@1",
        "revision": 2,
        "digest": "25a0c0a5d081bc153f6c6d987c5e5eeec22eaff3898e9fe1f9064c53c75c13b2"
      }
    },
    "publish": {
      "input": {
        "typeId": "agh.assembly/publish.request@1",
        "revision": 2,
        "digest": "dc471a4dc6d46cda23c08cec17eb8315adbb063a1f586592b5c4c77015cdf021"
      },
      "output": {
        "typeId": "agh.assembly/publish.response@1",
        "revision": 2,
        "digest": "613630d9f1180abb62acb29c4e5d9922be1bb90a102f953f56816ae3cae1f3d0"
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
        "revision": 3,
        "digest": "fd6e79d3ddec088a2e2a7d309303ced09831287cef6fa5be7813803dba6fc005"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.assembly/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.assembly/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.assembly/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.assembly/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.assembly/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "ec52e8dd5427a87e970c76d626138bf9fe60df0d46f364bc70ff0806ad88234c"
      },
      "output": {
        "typeId": "agh.migration/inspect.response@1",
        "revision": 2,
        "digest": "1f5cce31f4c66ddcc88d824db19fbbc452c0a3470f0c9cc7db3c7de802596fcb"
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
        "revision": 2,
        "digest": "68864cdfe902626a21caf3acfec26e78e2e08fcb847f17fa10abcc538cb2ef95"
      }
    },
    "validate": {
      "input": {
        "typeId": "agh.migration/validate.request@1",
        "revision": 2,
        "digest": "9dad220160ef308dfb29abd2687358bc015d2724003c7088d02277acf7da3c41"
      },
      "output": {
        "typeId": "agh.migration/validate.response@1",
        "revision": 2,
        "digest": "4a235e755bc2671ee95688b337eb4a272c198c2b5119576866fd306218762f54"
      }
    },
    "cutover": {
      "input": {
        "typeId": "agh.migration/cutover.request@1",
        "revision": 2,
        "digest": "06515959a23986cc5c887e01892e3f7e5edb35002bdc9ed11646db8e32b766ff"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.migration/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.migration/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.migration/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.migration/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.migration/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "cc59884e6574b5785a248c6dd58871da99407ea38243ea3c084edf322f8aa17e"
      },
      "output": {
        "typeId": "agh.integrity/verifyPackage.response@1",
        "revision": 2,
        "digest": "332c87c5349f8eed9906f9667e08b50922d021369dd071d92087c5d7dce74649"
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
        "revision": 2,
        "digest": "89aefef08a34e264b9d8b31cde3ca43912d961392ffc2bbc4add85f642a6073b"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.integrity/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.integrity/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.integrity/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.integrity/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.integrity/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "b8b4671f72f8938ed466b562d586aab39191746e3a449e99475e84e970d83131"
      }
    },
    "transfer": {
      "input": {
        "typeId": "agh.authority-directory/transfer.request@1",
        "revision": 2,
        "digest": "ec52e8dd5427a87e970c76d626138bf9fe60df0d46f364bc70ff0806ad88234c"
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
        "revision": 2,
        "digest": "f663d515ab3d055c6073b16460689c2dbd85986f59fb6639726cf557ee1081a3"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.authority-directory/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.authority-directory/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.authority-directory/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.authority-directory/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.authority-directory/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
        "revision": 2,
        "digest": "f92f979ca530f341e8b96f577472477674e4992b9210ea7a13188385c76c7f94"
      },
      "output": {
        "typeId": "agh.state/acceptServiceCommand.response@1",
        "revision": 2,
        "digest": "b0b8a4b0b2bff688272eb999b0b80b722ad85ce4e6f46cfab67fca4a2cc7e54d"
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
        "revision": 2,
        "digest": "77af1a1d55f67fdc585b6e23c1f7ad1610faad19fbad76a7ecb753a165273679"
      }
    },
    "importConversation": {
      "input": {
        "typeId": "agh.state/importConversation.request@1",
        "revision": 2,
        "digest": "5a6a6864e457a670a88cadfb5576d8f5d2e89db5577b95493e6b8f39464b6531"
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
        "revision": 2,
        "digest": "d1ab78d1f2ea000eaa075ab38c072dfa2dc87cee9090956e22c53783f4978763"
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
        "revision": 2,
        "digest": "7553cf322faa4f140a2949b646a3e1d1aa1db6c75093381177af84a480568c79"
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
        "revision": 3,
        "digest": "8a1b4727c0792ac5ae39fece09c4a78d1443efa4818a7ae61c0bfc12a88556e5"
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
        "revision": 2,
        "digest": "0da22cbed99ee2b6d3d001f956da11ee9d4679c15e8ec4bc2ddfa3ea1a9e93c4"
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
        "revision": 2,
        "digest": "dd14ac9b071badd5fc9fd10f0174390108b41c9aa88e1814ab967d73db95a367"
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
        "revision": 3,
        "digest": "2431f53ede0557c049907bdc66666b7452a60a93ce36f5d511ed8e5ff3866e36"
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
        "revision": 2,
        "digest": "f798ca271b17575590322d8c0ebf75c2ae8c584cbdd27e418b0bfa57b93246b9"
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
        "revision": 3,
        "digest": "cfee699b09ea761e1a74da39840bd5971397080a3b4243cd3fafbc6e5b495855"
      }
    },
    "ackOutbox": {
      "input": {
        "typeId": "agh.state/ackOutbox.request@1",
        "revision": 2,
        "digest": "a99ce6591b3fa987445c0176b36c7b4fd5f76a380deea2d809bb0a38e6933642"
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
        "revision": 2,
        "digest": "ca31994d51e0a0c60756288f0a48e2f451eff9d1f32a7bd6e3c029ad39360db1"
      },
      "output": {
        "typeId": "agh.state/beginReconciliation.response@1",
        "revision": 2,
        "digest": "8d87f0504c43c8427f71ca13100c7d5f03f557b9cdd6750a25a7020cd435229b"
      }
    },
    "completeReconciliation": {
      "input": {
        "typeId": "agh.state/completeReconciliation.request@1",
        "revision": 2,
        "digest": "72bcf5e00faf0888e824fc21688616ea7c84f72bc20741f66e3acb6334e3f249"
      },
      "output": {
        "typeId": "agh.state/completeReconciliation.response@1",
        "revision": 2,
        "digest": "8d87f0504c43c8427f71ca13100c7d5f03f557b9cdd6750a25a7020cd435229b"
      }
    },
    "advanceRun": {
      "input": {
        "typeId": "agh.state/advanceRun.request@1",
        "revision": 2,
        "digest": "263d18a8a5e13e5f5be17afacf3bb68395bddfaa96f0345d04d0355e5387b732"
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
        "revision": 2,
        "digest": "40c4e9bc69b02eed2bca127349ef23ab97ac07cc41e0557b2b90e42548bbe58b"
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
        "revision": 2,
        "digest": "6d14625f84ef473e648d7c3a621040b6a69b93b432e05c872175dd59c27026d0"
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
        "revision": 2,
        "digest": "1379ebab6753f41a90cc141f84767a72a75a3826bdff9e26d9d2e9b27521b7a1"
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
        "revision": 2,
        "digest": "230fae36f0e8648218d30cd9e4004f89ef7eb168135d51f008e2a46ba3c8bc82"
      }
    },
    "acceptBridgeChild": {
      "input": {
        "typeId": "agh.state/acceptBridgeChild.request@1",
        "revision": 2,
        "digest": "05be0c77860ecc5db1ebf9d0037e6ccb70cfe6c0f8a8fdbfbbcd2cb1685d42bd"
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
        "revision": 2,
        "digest": "c88626c2febb9512abe6927d04c4439b1c009b946fc3b25ac6b9ba3655544430"
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
    "scan": {
      "input": {
        "typeId": "agh.state/scan.request@1",
        "revision": 2,
        "digest": "76f327ae06b9db745347455978c943d55c8e665997ea21d752035ab4f5278405"
      },
      "output": {
        "typeId": "agh.state/scan.response@1",
        "revision": 1,
        "digest": "79a8fc471f476c0c4f672e03626fc545dba88e6a2c7d233effbc10626f77726e"
      }
    },
    "probeCommit": {
      "input": {
        "typeId": "agh.state/probeCommit.request@1",
        "revision": 1,
        "digest": "d17165a82319ebeab71a853fff06ac9a9b912793fa24fbcfb357d0a56fcb9349"
      },
      "output": {
        "typeId": "agh.state/probeCommit.response@1",
        "revision": 1,
        "digest": "3637a16b03afea732573628c4ef50b9b3a5ac8fc4b809ea988d64bc1224e48c9"
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
        "revision": 2,
        "digest": "3093d1ef0e66dde8ea1024e9bab33d5658050b13feb38ea96dab2c649414c81f"
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
        "revision": 2,
        "digest": "658b694e1dc946435af5b00c78469071513fbb1e2e34712dd306d8f53be548d4"
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
        "revision": 2,
        "digest": "05903b5297468c6514a5dc9a8ea91b7c273d158dc0d67d25a6975eb65366f1cb"
      }
    },
    "authorityImport": {
      "input": {
        "typeId": "agh.state/authorityImport.request@1",
        "revision": 2,
        "digest": "1cabfc026ab205b605b75aac4adbba08d79b049085a77c6448a76ef22b55dc22"
      },
      "output": {
        "typeId": "agh.state/authorityImport.response@1",
        "revision": 2,
        "digest": "f5be17f5df0306a02d7e6196876010ea0baefe285bfd0b6b9267f454d110c156"
      }
    },
    "authorityVerify": {
      "input": {
        "typeId": "agh.state/authorityVerify.request@1",
        "revision": 2,
        "digest": "bd76778afaf0e46b2f778bfc41582643636c338a340fdded58215e1b6187df89"
      },
      "output": {
        "typeId": "agh.state/authorityVerify.response@1",
        "revision": 2,
        "digest": "a4931db51e2fd95384c21868e5ac92c3cdc4e7f60ed1c8a57b3a0c0b20646d4a"
      }
    },
    "authorityActivate": {
      "input": {
        "typeId": "agh.state/authorityActivate.request@1",
        "revision": 2,
        "digest": "46a148104dedc56abc28dcb69b09a793f086e1b793b808a241be83bb09642bf8"
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
        "revision": 2,
        "digest": "7ebfe4a754086dab8ab2c03277b6bd6ada1e77f33b135c9f0693bd2123c71486"
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
