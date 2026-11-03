import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createHash } from 'node:crypto'
import { createProviderRegistry, type LanguageModel } from 'ai'
import type { ModelOption } from '@si-bot/shared'

const env = process.env

// Each provider is enabled only when its key or URL is set.
const providers: Record<string, any> = {}
const models: ModelOption[] = []

function add(provider: string, defaults: [string, string][]) {
  for (const [id, label] of defaults) models.push({ id: `${provider}:${id}`, label, provider })
}

if (env.ANTHROPIC_API_KEY) {
  providers.anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })
  add('anthropic', [
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
    ['claude-opus-5-5', 'Claude Opus 5.5'],
    ['claude-haiku-5-5', 'Claude Haiku 5.5'],
  ])
}
if (env.OPENAI_API_KEY) {
  providers.openai = createOpenAI({ apiKey: env.OPENAI_API_KEY })
  add('openai', [
    ['gpt-5', 'GPT-5'],
    ['gpt-5-mini', 'GPT-5 mini'],
  ])
}
if (env.OPENROUTER_API_KEY) {
  providers.openrouter = createOpenAICompatible({
    name: 'openrouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: env.OPENROUTER_API_KEY,
  })
  add('openrouter', [
    ['x-ai/grok-4', 'Grok 4 (OpenRouter)'],
    ['google/gemini-2.5-pro', 'Gemini 2.5 Pro (OpenRouter)'],
    ['deepseek/deepseek-r1', 'DeepSeek R1 (OpenRouter)'],
  ])
}
// OpenCode Go subscription: OpenAI-compatible endpoint, one key for its hosted open models.
if (env.OPENCODE_API_KEY) {
  providers.opencode = createOpenAICompatible({
    name: 'opencode',
    baseURL: env.OPENCODE_BASE_URL || 'https://opencode.ai/zen/go/v1',
    apiKey: env.OPENCODE_API_KEY,
    // Go rejects requests without a stable session id and asks clients to name themselves.
    // Si is one continuous conversation, so one id for the whole install (derived, never the token itself).
    headers: {
      'x-opencode-session':
        env.OPENCODE_SESSION_ID || 'si-' + createHash('sha256').update(`si-bot:${env.SIBOT_TOKEN}`).digest('hex').slice(0, 32),
      'user-agent': 'si-bot/0.1',
    },
  })
  add('opencode', [
    ['deepseek-v4.1-flash', 'DeepSeek V4.1 Flash (OpenCode Go)'],
    ['deepseek-v4-pro', 'DeepSeek V4 Pro (OpenCode Go)'],
  ])
}
if (env.OLLAMA_BASE_URL) {
  providers.ollama = createOpenAICompatible({ name: 'ollama', baseURL: env.OLLAMA_BASE_URL })
  add('ollama', [['llama3.2', 'Llama 3.2 (local)']])
}

// EXTRA_MODELS="openai:o3=o3,openrouter:qwen/qwen3-max=Qwen 3 Max" adds models without code changes.
for (const entry of (env.EXTRA_MODELS ?? '').split(',').filter(Boolean)) {
  const [id, label] = entry.split('=')
  const provider = id.split(':')[0]
  if (providers[provider]) models.push({ id, label: label ?? id, provider })
}

const registry = createProviderRegistry(providers)

/**
 * Embedding model for semantic memory recall, as "provider:model". EMBEDDING_MODEL overrides the default
 * (OpenAI text-embedding-3-small when an OpenAI key is set). Without one, recall falls back to keyword search.
 */
export function embeddingModelId(): string | undefined {
  const wanted = env.EMBEDDING_MODEL
  if (wanted) return providers[wanted.split(':')[0]] ? wanted : undefined
  return providers.openai ? 'openai:text-embedding-3-small' : undefined
}

export function getEmbeddingModel(id: string) {
  return registry.embeddingModel(id as `${string}:${string}`)
}

export function listModels(): ModelOption[] {
  return models
}

export function defaultModel(): string | undefined {
  const wanted = env.DEFAULT_MODEL
  if (wanted && models.some((m) => m.id === wanted)) return wanted
  return models[0]?.id
}

export function getModel(id: string): LanguageModel {
  return registry.languageModel(id as `${string}:${string}`)
}

/** Provider-specific options that switch on extended reasoning ("Think" mode). */
export function thinkOptions(id: string) {
  const provider = id.split(':')[0]
  if (provider === 'anthropic') return { anthropic: { thinking: { type: 'enabled', budgetTokens: 8000 } } }
  if (provider === 'openai') return { openai: { reasoningEffort: 'high' } }
  return undefined
}
