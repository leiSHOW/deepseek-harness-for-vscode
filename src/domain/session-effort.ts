import type { ReasoningEffort } from './options.js'

/**
 * What the user asked for on a per-session basis. A concrete `ReasoningEffort`
 * is forwarded verbatim to the harness; `'auto'` is an extension-side selection
 * layer that is resolved to a real effort before anything reaches the harness.
 * The harness only ever understands `off` / `low` / `high` / `max`.
 */
export type EffortIntent = 'auto' | ReasoningEffort

/** Task signals an auto-effort resolver may consult (all extension-side). */
export interface AutoEffortSignals {
  readonly promptTokens: number
  readonly attachmentCount: number
  readonly historyTurns: number
}

/** Prompt-level signals the webview supplies; history turns are derived locally. */
export type PromptEffortSignals = Pick<AutoEffortSignals, 'promptTokens' | 'attachmentCount'>

export function isAutoEffort(value: string): value is 'auto' {
  return value === 'auto'
}

/** Descending capability order: the highest available tier wins a fallback. */
const CAPABILITY_RANK: readonly string[] = ['max', 'high', 'low']

/**
 * Resolves a per-session intent against the model's actual reasoning options.
 * 'auto' never leaks to the harness — it is translated to one of the model's
 * own tiers here. A concrete intent the model does not support falls back to
 * its highest available tier rather than erroring.
 */
export function resolveEffortIntent(
  intent: EffortIntent,
  options: readonly { readonly id: string }[],
  signals: AutoEffortSignals,
): string | undefined {
  if (intent !== 'auto') {
    return options.some((option) => option.id === intent) ? intent : highestRanked(options)
  }
  return autoEffort(options, signals)
}

/**
 * Picks a concrete effort from the model's supported options using task
 * signals. The heuristic is deliberately conservative and documented:
 *  - tiny, attachment-free, fresh prompts → `low`;
 *  - large prompts or attachments or a long history → `max`;
 *  - otherwise → `high`.
 * When the target tier is unavailable it degrades to the highest known tier.
 */
export function autoEffort(
  options: readonly { readonly id: string }[],
  signals: AutoEffortSignals,
): string | undefined {
  const ids = new Set(options.map((option) => option.id))
  const heavy = signals.promptTokens >= 8_000 || signals.attachmentCount > 0 || signals.historyTurns >= 4
  const light = signals.promptTokens < 1_000 && signals.attachmentCount === 0 && signals.historyTurns === 0
  const target = light ? 'low' : heavy ? 'max' : 'high'
  if (ids.has(target)) return target
  return highestRanked(options)
}

function highestRanked(options: readonly { readonly id: string }[]): string | undefined {
  const ids = new Set(options.map((option) => option.id))
  for (const id of CAPABILITY_RANK) {
    if (ids.has(id)) return id
  }
  return options[0]?.id
}
