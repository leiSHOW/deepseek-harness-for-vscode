/**
 * Carry-over context for DSH-mode switches.
 *
 * Upstream locks a session's Agent Preset once a conversation starts
 * (`agent-preset-locked`) and `session.fork` inherits the source preset, so a
 * mid-conversation mode switch can never fork into the requested mode. The
 * extension therefore opens a fresh session under the requested preset and
 * rides a digest of the previous conversation along with the next user
 * message as a leading hidden text block. The webview collapses that block
 * into a context card, so the carried history stays out of sight while the
 * model keeps full continuity.
 */

/** One condensed exchange extracted from the source conversation. */
export interface CarryTurn {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** Structural view of projected chat blocks; avoids coupling to the workbench module. */
export interface CarryBlockLike {
  readonly kind: 'text' | 'reasoning' | 'image'
  readonly text: string
}

export interface CarriedContextSplit {
  /** Merged text of every leading carried block ('' when nothing is carried). */
  readonly carriedText: string
  /** Everything from the first non-carried block onward — the visible remainder. */
  readonly rest: readonly CarryBlockLike[]
}

const OPEN_TAG = '<context-carry'
const CLOSE_TAG = '</context-carry>'
const MAX_TURNS = 14
const MAX_TURN_CHARS = 600

export interface BuildCarryOverInput {
  readonly sourceSessionId: string
  readonly fromPreset?: string
  readonly toPreset?: string
  readonly turns: readonly CarryTurn[]
  readonly skippedToolCalls?: number
}

/**
 * Renders the hidden lead block for the next prompt in the fresh session.
 * Returns undefined when there is nothing worth carrying (no exchanges),
 * so the next message goes out verbatim.
 */
export function buildCarryOverMessage(input: BuildCarryOverInput): string | undefined {
  const lines: string[] = []
  for (const turn of input.turns.slice(-MAX_TURNS)) {
    const text = truncate(turn.text)
    if (text === '') continue
    lines.push(`- [${turn.role}] ${text.replace(/\s+/gu, ' ')}`)
  }
  if (lines.length === 0) return undefined

  const attributes = [
    `source="${sanitizeAttribute(input.sourceSessionId)}"`,
    ...(input.fromPreset === undefined ? [] : [`from="${sanitizeAttribute(input.fromPreset)}"`]),
    ...(input.toPreset === undefined ? [] : [`to="${sanitizeAttribute(input.toPreset)}"`]),
  ].join(' ')

  const body: string[] = [
    `<context-carry ${attributes}>`,
    'This block was assembled automatically when the conversation switched modes.',
    'The transcript excerpts below are reference context from the previous session;',
    'continue the ongoing task naturally without commenting on this block.',
    '此块为切换模式时自动携带的上一段对话摘要，仅作上下文衔接，请勿评论其本身。',
    '',
    ...lines,
  ]
  const omitted = input.skippedToolCalls ?? 0
  if (omitted > 0) body.push(`(${omitted} tool operations in the previous session are omitted here.)`)
  body.push(CLOSE_TAG)
  return body.join('\n')
}

/** Splits projected user-message blocks into the leading carried region and the visible remainder. */
export function splitCarriedBlocks(blocks: readonly CarryBlockLike[]): CarriedContextSplit {
  const carried: string[] = []
  let index = 0
  while (index < blocks.length) {
    const block = blocks[index]
    if (block === undefined || block.kind !== 'text' || !isCarriedText(block.text)) break
    carried.push(extractCarriedBody(block.text))
    index += 1
  }
  return { carriedText: carried.join('\n\n').trim(), rest: blocks.slice(index) }
}

/** Whether one block's text is an auto-assembled carry-over payload. */
export function isCarriedText(text: string): boolean {
  return text.trimStart().startsWith(OPEN_TAG) && text.includes(CLOSE_TAG)
}

/** User-visible text with any leading carry-over region removed, for optimistic-bubble matching. */
export function stripCarriedPrefix(text: string): string {
  if (!isCarriedText(text)) return text
  const end = text.indexOf(CLOSE_TAG)
  return text.slice(end + CLOSE_TAG.length).replace(/^\s+/, '')
}

function extractCarriedBody(text: string): string {
  const start = text.indexOf('>', text.indexOf(OPEN_TAG))
  const end = text.indexOf(CLOSE_TAG)
  if (start === -1 || end === -1 || start >= end) return ''
  // Interior of the wrapper plus anything trailing it: the gateway always
  // sends its own dedicated block, so a trailing tail here means some other
  // producer concatenated real user text onto the payload — keep it visible
  // inside the card instead of silently hiding it.
  const trailing = text.slice(end + CLOSE_TAG.length)
  return `${text.slice(start + 1, end).trim()}\n${trailing.trim()}`.trim()
}

function sanitizeAttribute(value: string): string {
  return value.replace(/["<>&]/gu, '_')
}

function truncate(text: string): string {
  const single = text.trim()
  return single.length > MAX_TURN_CHARS ? `${single.slice(0, MAX_TURN_CHARS)}…` : single
}
