const MINIMUM_STEP = 3
const TARGET_FRAMES = 8

/** Advances a stream enough to stay smooth without falling far behind large chunks. */
export function nextStreamText(rendered: string, target: string): string {
  if (rendered === target) return rendered
  if (!target.startsWith(rendered)) return target
  const remaining = target.length - rendered.length
  const step = Math.max(MINIMUM_STEP, Math.ceil(remaining / TARGET_FRAMES))
  return target.slice(0, Math.min(target.length, rendered.length + step))
}

/** Minimum time between full markdown rebuilds of a streaming block (≈33 fps). */
export const STREAMING_REBUILD_MIN_INTERVAL_MS = 30
/** Minimum accumulated text before a streaming block is rebuilt. */
export const STREAMING_REBUILD_CHAR_THRESHOLD = 80

export interface StreamFrameState {
  /** Text advanced so far in the current frame. */
  readonly rendered: string
  /** The streaming block's full target text. */
  readonly target: string
  /** Text handed to the last full markdown rebuild (empty before the first). */
  readonly lastRendered?: string
  /** Timestamp of the last full markdown rebuild. */
  readonly lastRenderAt?: number
}

/**
 * Decides whether this streaming frame must rebuild the block's Markdown.
 * Full rebuilds (markdown-it + DOMPurify + innerHTML) scale with the
 * accumulated text, so rebuilding on every animation frame makes long replies
 * janky. The first visible frame renders immediately, then rebuilds only when
 * enough new text has accumulated, enough time has passed, or the block is
 * about to finish (so the stream always lands exactly on its target).
 */
export function shouldRebuildStreamFrame(
  state: StreamFrameState,
  now: number,
  minIntervalMs: number,
  charThreshold: number,
): boolean {
  const lastRendered = state.lastRendered ?? ''
  if (state.rendered !== '' && lastRendered === '') return true
  if (state.rendered === state.target) return true
  const delta = state.rendered.length - lastRendered.length
  if (delta >= charThreshold) return true
  if (delta > 0 && now - (state.lastRenderAt ?? 0) >= minIntervalMs) return true
  return false
}
