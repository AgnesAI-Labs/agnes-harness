import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ProviderStreamOptions,
  ProviderStreams,
} from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { azureOpenAIResponsesApi } from '@earendil-works/pi-ai/api/azure-openai-responses.lazy'
import { bedrockConverseStreamApi } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { googleVertexApi } from '@earendil-works/pi-ai/api/google-vertex.lazy'
import { mistralConversationsApi } from '@earendil-works/pi-ai/api/mistral-conversations.lazy'
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { piMessagesApi } from '@earendil-works/pi-ai/api/pi-messages.lazy'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'

/**
 * The wire library's implementations, addressed by the api a route declared. Each entry is a lazy
 * wrapper: the protocol module behind it is imported the first time a request uses it.
 */
const APIS: Record<string, () => ProviderStreams> = {
  'anthropic-messages': anthropicMessagesApi,
  'azure-openai-responses': azureOpenAIResponsesApi,
  'bedrock-converse-stream': bedrockConverseStreamApi,
  'google-generative-ai': googleGenerativeAIApi,
  'google-vertex': googleVertexApi,
  'mistral-conversations': mistralConversationsApi,
  'openai-codex-responses': openAICodexResponsesApi,
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'pi-messages': piMessagesApi,
}

/**
 * One request, over the implementation for the api the route declared.
 *
 * The library ships a dispatcher that does this same job, and this exists to avoid it. That
 * dispatcher fills a missing key in from the environment, choosing which variable to read from the
 * model's *provider name* while still sending the request to the model's *declared endpoint* — so a
 * route named after one of the library's builtin providers and pointed anywhere would carry the
 * operator's key for that provider to that anywhere. Dispatching by api removes that dispatcher
 * credential fallback. Cache retention is pinned by streamOptions instead of inherited from
 * PI_CACHE_RETENTION in the environment.
 *
 * It is also the entrypoint the library's own header schedules for deletion, which is a second
 * reason not to build on it.
 */
export function streamOverApi(
  model: Model<Api>,
  context: Context,
  options?: ProviderStreamOptions,
): AssistantMessageEventStream {
  const api = APIS[model.api]
  // The same failure the dispatcher raised for an api it had no implementation for, and raised the
  // same way: a route declaring an api this library cannot speak is a configuration mistake.
  if (!api) throw new Error(`No API provider registered for api: ${model.api}`)
  return api().stream(model, normalizeContext(context), options)
}

/**
 * The apis whose client library carries a credential chain of its own. Given no key, neither of
 * these fails: the AWS SDK signs with whatever identity the host exports or its instance metadata
 * service hands out, and the Google SDK walks Application Default Credentials — a service-account
 * file, the metadata server, a gcloud login — mints a token and sends it. Either way the credential
 * goes to the endpoint the route declared.
 *
 * So on these two "no credential" is not a statement about the request. It is a request for the
 * host's AWS or GCP identity, made by a route that never named one. The adapter refuses it; the
 * other eight apis raise their own "no API key" and need no help here.
 */
export const AMBIENT_CREDENTIAL_APIS: ReadonlySet<string> = new Set([
  'bedrock-converse-stream',
  'google-vertex',
])
