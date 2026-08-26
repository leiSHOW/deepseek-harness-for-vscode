/**
 * Flattens a prompt's text blocks into a single-line, symbol-light session
 * title. Returns undefined when the content carries no usable text (image-only
 * prompts, empty messages) so callers can keep the fallback title.
 */
export function conversationTitle(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const text = content
    .flatMap((block) => {
      if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return []
      return [block.text]
    })
    .join(' ')
    .replace(/[`*_~#>|]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (text === '') return undefined
  return text.length > 48 ? `${text.slice(0, 48)}…` : text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
