import { validateOwnedAuthorSchemaSource } from '@agnes/protocol/runtime'

// These identities validate data only; selected package and issuer provenance are separate.
export const currentHeadSource = validateOwnedAuthorSchemaSource({
  ownerPackageId: 'agnes-host',
  name: 'MaintenanceCurrentHead',
  typeId: 'agnes-host/maintenance-current-head@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/MaintenanceCurrentHead',
    $defs: {
      MaintenanceCurrentHead: {
        type: 'object',
        properties: {
          directoryJson: { type: 'string', minLength: 1, maxLength: 4096, 'x-max-utf8-bytes': 4096 },
          jointDomainsJson: { type: 'string', minLength: 1, maxLength: 24576, 'x-max-utf8-bytes': 24576 },
          migrationsJson: { const: '[]' },
          stateAuthorityRefJson: { type: 'string', minLength: 1, maxLength: 4096, 'x-max-utf8-bytes': 4096 },
        },
        required: ['directoryJson', 'jointDomainsJson', 'migrationsJson', 'stateAuthorityRefJson'],
        additionalProperties: false,
      },
    },
  },
}).source
export const releaseRouteSource = validateOwnedAuthorSchemaSource({
  ownerPackageId: 'agnes-host',
  name: 'MaintenanceReleaseRoute',
  typeId: 'agnes-host/maintenance-release-route@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/MaintenanceReleaseRoute',
    $defs: {
      MaintenanceReleaseRoute: {
        type: 'object',
        properties: {
          routeId: { type: 'string', minLength: 1, maxLength: 256, 'x-max-utf8-bytes': 256 },
          activeReleaseSetId: { type: 'string', minLength: 1, maxLength: 256, 'x-max-utf8-bytes': 256 },
          authorityEpoch: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
          cutoverId: { type: 'string', minLength: 1, maxLength: 256, 'x-max-utf8-bytes': 256 },
        },
        required: ['routeId', 'activeReleaseSetId', 'authorityEpoch', 'cutoverId'],
        additionalProperties: false,
      },
    },
  },
}).source
export const releaseSnapshotSource = validateOwnedAuthorSchemaSource({
  ownerPackageId: 'agnes-host',
  name: 'MaintenanceReleaseSnapshot',
  typeId: 'agnes-host/maintenance-release-snapshot@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/MaintenanceReleaseSnapshot',
    $defs: {
      MaintenanceReleaseSnapshot: {
        type: 'object',
        properties: {
          canonicalJson: { type: 'string', minLength: 1, maxLength: 60000, 'x-max-utf8-bytes': 60000 },
          contentDigest: { type: 'string', minLength: 64, maxLength: 64 },
        },
        required: ['canonicalJson', 'contentDigest'],
        additionalProperties: false,
      },
    },
  },
}).source
export const appliedSourceSource = validateOwnedAuthorSchemaSource({
  ownerPackageId: 'agnes-host',
  name: 'MaintenanceAppliedSource',
  typeId: 'agnes-host/maintenance-applied-source@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/MaintenanceAppliedSource',
    $defs: {
      MaintenanceAppliedSource: {
        type: 'object',
        properties: {
          formatVersion: { const: 1 },
          transactionId: { type: 'string', minLength: 1, maxLength: 256, 'x-max-utf8-bytes': 256 },
          maintenanceAuthorityJson: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
            'x-max-utf8-bytes': 4096,
          },
          stateAuthorityJson: { type: 'string', minLength: 1, maxLength: 4096, 'x-max-utf8-bytes': 4096 },
          producerJson: { type: 'string', minLength: 1, maxLength: 4096, 'x-max-utf8-bytes': 4096 },
          scopeJson: { type: 'string', minLength: 1, maxLength: 4096, 'x-max-utf8-bytes': 4096 },
          issuerCodeDigest: { type: 'string', minLength: 64, maxLength: 64 },
          releaseSetId: { type: 'string', minLength: 1, maxLength: 256, 'x-max-utf8-bytes': 256 },
          bindingId: { type: 'string', minLength: 1, maxLength: 256, 'x-max-utf8-bytes': 256 },
          planDigest: { type: 'string', minLength: 64, maxLength: 64 },
          sourceFingerprint: { type: 'string', minLength: 64, maxLength: 64 },
          observedAt: { type: 'string', minLength: 1, maxLength: 64, 'x-max-utf8-bytes': 64 },
          contextDeadline: { type: 'string', minLength: 1, maxLength: 64, 'x-max-utf8-bytes': 64 },
          identityExpiresAt: { type: 'string', minLength: 1, maxLength: 64, 'x-max-utf8-bytes': 64 },
          planExpiresAt: { type: 'string', minLength: 1, maxLength: 64, 'x-max-utf8-bytes': 64 },
          protectedUntil: {
            anyOf: [
              { type: 'string', minLength: 1, maxLength: 64, 'x-max-utf8-bytes': 64 },
              { type: 'null' },
            ],
          },
          qualifiedUntil: { type: 'string', minLength: 1, maxLength: 64, 'x-max-utf8-bytes': 64 },
          memberFingerprints: {
            type: 'array',
            items: { type: 'string', minLength: 64, maxLength: 64 },
            minItems: 3,
            maxItems: 3,
          },
          content: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role: {
                  enum: [
                    'config-request',
                    'config-result',
                    'package-request',
                    'package-result',
                    'package-metadata',
                    'package-fetch',
                    'package-manifest',
                    'release-plan',
                    'release-set',
                    'run-binding',
                    'assembly-graph',
                    'protected-config',
                    'protected-package',
                    'protected-lock',
                    'protected-policy',
                    'package-file',
                    'referenced-json',
                    'schema-source',
                  ],
                },
                kind: { enum: ['json', 'bytes'] },
                digest: { type: 'string', minLength: 64, maxLength: 64 },
                bytes: { type: 'integer', minimum: 0, maximum: 8388608 },
                packageId: {
                  anyOf: [
                    { type: 'string', minLength: 1, maxLength: 256, 'x-max-utf8-bytes': 256 },
                    { type: 'null' },
                  ],
                },
                path: {
                  anyOf: [
                    { type: 'string', minLength: 1, maxLength: 1024, 'x-max-utf8-bytes': 1024 },
                    { type: 'null' },
                  ],
                },
                schemaJson: {
                  anyOf: [
                    { type: 'string', minLength: 1, maxLength: 1024, 'x-max-utf8-bytes': 1024 },
                    { type: 'null' },
                  ],
                },
              },
              required: ['role', 'kind', 'digest', 'bytes', 'packageId', 'path', 'schemaJson'],
              additionalProperties: false,
            },
            maxItems: 128,
          },
          requiredDigests: {
            type: 'array',
            items: { type: 'string', minLength: 64, maxLength: 64 },
            maxItems: 512,
          },
        },
        required: [
          'formatVersion',
          'transactionId',
          'maintenanceAuthorityJson',
          'stateAuthorityJson',
          'producerJson',
          'scopeJson',
          'issuerCodeDigest',
          'releaseSetId',
          'bindingId',
          'planDigest',
          'sourceFingerprint',
          'observedAt',
          'contextDeadline',
          'identityExpiresAt',
          'planExpiresAt',
          'protectedUntil',
          'qualifiedUntil',
          'memberFingerprints',
          'content',
          'requiredDigests',
        ],
        additionalProperties: false,
      },
    },
  },
}).source
