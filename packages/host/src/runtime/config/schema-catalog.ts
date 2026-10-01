import { validateRuntime } from '@agnes/protocol/runtime'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import { type ConfigRefusal, configRefusal, documentDigest } from './config-digest.js'

export type SchemaRef = {
  typeId: string
  revision: number
  digest: string
}

type ProviderInfo = {
  providerId: string
  contract: string
  major: number
  logicalName: string
  recovery: 'R0' | 'R1' | 'R2'
  isolation: Array<'trusted-in-process' | 'isolated-process' | 'remote'>
  digest: string
}

const schemaKey = (schema: SchemaRef): string => `${schema.typeId}\n${schema.revision}\n${schema.digest}`
const providerKey = (packageId: string, providerId: string): string => `${packageId}\n${providerId}`

function firstError(errors: { message: string }[]): string {
  return errors[0]?.message ?? 'invalid document'
}

export type SchemaCatalog = {
  admitSchema(schema: SchemaRef, document: unknown): ConfigRefusal | null
  admitProvider(packageId: string, descriptor: unknown): ConfigRefusal | null
  known(schema: SchemaRef): boolean
  checkValue(schema: SchemaRef, value: unknown, path: string): ConfigRefusal | null
  provider(packageId: string, providerId: string): ProviderInfo | null
}

export function createSchemaCatalog(): SchemaCatalog {
  const validators = new Map<string, ValidateFunction>()
  const providers = new Map<string, ProviderInfo>()

  return {
    admitSchema(schema, document) {
      const parsed = validateRuntime('SchemaRef', schema)
      if (!parsed.ok) return configRefusal('schema_invalid', '/schema', firstError(parsed.errors))
      if (documentDigest(document) !== schema.digest) {
        return configRefusal(
          'content_identity_mismatch',
          '/schema',
          'schema digest does not match the admitted document',
        )
      }
      const key = schemaKey(schema)
      if (validators.has(key)) return null
      try {
        const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true })
        const validate = ajv.compile(document as object)
        if ('$async' in validate && validate.$async) {
          return configRefusal('schema_invalid', '/schema', 'async schema is not admitted')
        }
        validators.set(key, validate)
        return null
      } catch {
        return configRefusal('schema_invalid', '/schema', 'schema document cannot be compiled')
      }
    },
    admitProvider(packageId, descriptor) {
      const parsed = validateRuntime('ProviderDescriptor', descriptor)
      if (!parsed.ok) return configRefusal('schema_invalid', '/provider', firstError(parsed.errors))
      const value = parsed.value as {
        providerId: string
        contract: string
        major: number
        logicalName: string
        recovery: 'R0' | 'R1' | 'R2'
        isolation: ProviderInfo['isolation']
      }
      const digest = documentDigest(parsed.value)
      const key = providerKey(packageId, value.providerId)
      const existing = providers.get(key)
      if (existing) {
        if (existing.digest !== digest) {
          return configRefusal('duplicate_declaration', '/provider', 'provider descriptor digest conflicts')
        }
        return null
      }
      providers.set(key, {
        providerId: value.providerId,
        contract: value.contract,
        major: value.major,
        logicalName: value.logicalName,
        recovery: value.recovery,
        isolation: value.isolation,
        digest,
      })
      return null
    },
    known(schema) {
      return validators.has(schemaKey(schema))
    },
    checkValue(schema, value, path) {
      const validate = validators.get(schemaKey(schema))
      if (!validate) return configRefusal('unknown_schema', path, 'schema is not admitted')
      if (validate(value)) return null
      return configRefusal('schema_invalid', path, 'value does not match the admitted schema')
    },
    provider(packageId, providerId) {
      return providers.get(providerKey(packageId, providerId)) ?? null
    },
  }
}
