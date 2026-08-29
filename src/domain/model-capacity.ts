/**
 * Hard-coded model capacity table (context window + max output tokens).
 *
 * Harness's pi-ai adapter resolves a relay model's context window by exact-id
 * catalog lookup (`entry.contextWindow ?? base?.contextWindow ??
 * defaultContextWindow`). Relay endpoints expose prefixed ids such as
 * `deepseek/deepseek-v4-flash`, which never match the catalog, so every
 * request silently fell back to the 256K default — wrong for 1M models and
 * wrong for 200K ones. Writing a known capacity into the relay profile fixes
 * the meter for both Auto and manually selected models.
 *
 * The table mirrors the provider's published model sheet supplied by the user
 * plus the bundled pi-ai catalog (@earendil-works/pi-ai
 * providers/data/deepseek.json). Values are tokens. Unknown ids stay
 * capacity-less and keep the adapter default.
 *
 * Matching is deliberately forgiving, because relay catalogs rename ids:
 * provider prefixes (`deepseek/`, `qwen/`, `openrouter/…/`), variant tags
 * (`:free`, `:nitro`, `:latest`, `-preview`), case, and separator styles are
 * all normalized away. Exact forms always win over tag-stripped forms, so a
 * distinct variant (e.g. `minimax-m2.7-free` at 197K) is not shadowed by the
 * base entry (200K).
 */
export interface ModelCapacity {
  readonly contextWindow: number
  readonly maxTokens?: number
}

const RAW_CAPACITIES: ReadonlyArray<readonly [string, ModelCapacity]> = [
  // DeepSeek — capacities from the provider sheet; maxTokens from the bundled
  // pi-ai catalog.
  ['deepseek-v4-flash', { contextWindow: 1_000_000, maxTokens: 384_000 }],
  ['deepseek-v4-pro', { contextWindow: 1_000_000, maxTokens: 384_000 }],
  ['deepseek-v4-flash-vision-exp', { contextWindow: 1_000_000, maxTokens: 384_000 }],
  // Provider model sheet (context column only).
  ['tencent-hy4-preview', { contextWindow: 1_000_000 }],
  ['hy4-preview', { contextWindow: 1_000_000 }],
  ['glm-5.3-flash', { contextWindow: 1_000_000 }],
  ['qwen-3.8-flash', { contextWindow: 1_000_000 }],
  ['glm-5.3', { contextWindow: 1_000_000 }],
  ['qwen-3.8-27b', { contextWindow: 262_144 }],
  ['gemini-3.7-flash', { contextWindow: 1_000_000 }],
  ['grok-4.6', { contextWindow: 500_000 }],
  ['muse-spark-1.2', { contextWindow: 1_000_000 }],
  ['muse-spark-1.2-contributor', { contextWindow: 1_000_000 }],
  ['qwen-3.8-max', { contextWindow: 1_000_000 }],
  ['inkling-small', { contextWindow: 1_000_000 }],
  ['qwen-3.7-flash', { contextWindow: 1_000_000 }],
  ['laguna-s-2.1', { contextWindow: 256_000 }],
  ['laguna-s-2.1-free', { contextWindow: 256_000 }],
  ['inkling', { contextWindow: 256_000 }],
  ['kimi-k3', { contextWindow: 1_000_000 }],
  ['gpt-5.6-luna', { contextWindow: 1_100_000 }],
  ['gpt-5.6-sol', { contextWindow: 1_100_000 }],
  ['grok-4.5', { contextWindow: 500_000 }],
  ['tencent-hy3', { contextWindow: 262_144 }],
  ['hy3', { contextWindow: 262_144 }],
  ['glm-5.2-fast', { contextWindow: 1_000_000 }],
  ['glm-5.2', { contextWindow: 1_000_000 }],
  ['kimi-k2.7-code-highspeed', { contextWindow: 262_144 }],
  ['kimi-k2.7-code', { contextWindow: 256_000 }],
  ['nemotron-3-ultra', { contextWindow: 1_000_000 }],
  ['minimax-m3', { contextWindow: 1_000_000 }],
  ['minimax-m3-free', { contextWindow: 1_000_000 }],
  ['qwen-3.7-plus', { contextWindow: 1_000_000 }],
  ['step-3.7-flash', { contextWindow: 256_000 }],
  ['mimo-v2.5', { contextWindow: 1_000_000 }],
  ['mimo-v2.5-pro', { contextWindow: 1_000_000 }],
  ['qwen-3.7-max', { contextWindow: 1_000_000 }],
  ['step-3.5-flash', { contextWindow: 1_000_000 }],
  ['glm-5.1', { contextWindow: 200_000 }],
  ['minimax-m2.7', { contextWindow: 200_000 }],
  ['minimax-m2.7-free', { contextWindow: 197_000 }],
  ['qwen-3.6-max', { contextWindow: 200_000 }],
  ['qwen-3.6-max-preview', { contextWindow: 200_000 }],
  ['qwen-3.6-plus', { contextWindow: 200_000 }],
  ['kimi-k2.6', { contextWindow: 256_000 }],
  ['glm-5', { contextWindow: 200_000 }],
  ['kimi-k2.5', { contextWindow: 256_000 }],
  ['minimax-m2.5', { contextWindow: 200_000 }],
]

const CAPACITY_TABLE: ReadonlyMap<string, ModelCapacity> = new Map(
  RAW_CAPACITIES.map(([id, capacity]) => [slugKey(id), capacity]),
)

/**
 * Looks up a model's known capacity. Matching ignores provider prefixes,
 * variant tags, case, and separators; exact forms are tried before any
 * tag-stripped form.
 */
export function modelCapacity(modelId: string): ModelCapacity | undefined {
  const trimmed = modelId.trim()
  if (trimmed === '') return undefined
  for (const candidate of lookupCandidates(trimmed)) {
    const capacity = CAPACITY_TABLE.get(slugKey(candidate))
    if (capacity !== undefined) return capacity
  }
  return undefined
}

/** Exact pieces first, then their tag-stripped forms, then the whole id. */
export function lookupCandidates(modelId: string): string[] {
  const lower = modelId.toLowerCase()
  const candidates = new Set<string>()
  for (const piece of lower.split('/')) {
    if (piece === '') continue
    candidates.add(piece)
    const stripped = stripVariantTag(piece)
    if (stripped !== piece) candidates.add(stripped)
  }
  candidates.add(lower)
  return [...candidates]
}

function stripVariantTag(piece: string): string {
  return piece.replace(/[:-](?:free|nitro|latest|preview|exp|\d{4}-\d{2}-\d{2})$/u, '')
}

/** Alphanumeric-only lowercase key: `GLM 5.3 Flash` ≡ `glm-5.3-flash`. */
export function slugKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}
