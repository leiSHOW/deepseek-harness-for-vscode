import type { ChatItem } from '../../domain/workbench-state.js'
import { components, elements, messageSignatures, t } from './context.js'

export function messageSignature(item: ChatItem): string {
  return JSON.stringify(item)
}

export function setMessageMetadata(element: HTMLElement, id: string, signature: string): void {
  element.dataset.messageId = id
  messageSignatures.set(element, signature)
}

/** Mutates only text inside the active assistant card for smooth token flow. */
export function patchStreamingMessage(element: HTMLElement, item: ChatItem): boolean {
  if (item.kind !== 'message' || element.tagName !== 'ARTICLE') return false
  const body = element.querySelector('.message-body')
  if (!body) return false
  if (!components.streamingMessage.patch(body as HTMLElement, item)) return false
  // Keep the ticking worked-time footer under the streaming DeepSeek bubble.
  components.workDuration.update(element, item.workDuration)
  return true
}

export function captureDisclosures(root: HTMLElement): Map<string, boolean> {
  const state = new Map<string, boolean>()
  for (const details of disclosureElements(root)) state.set(details.dataset.disclosureKey || '', details.open)
  return state
}

export function restoreDisclosures(root: HTMLElement, state: Map<string, boolean>): void {
  for (const details of disclosureElements(root)) {
    if (details.dataset.autoOpen === 'true') details.open = true
    else if (details.dataset.autoOpen === 'false') details.open = false
    else details.open = state.get(details.dataset.disclosureKey || '') === true
  }
}

function disclosureElements(root: HTMLElement): HTMLDetailsElement[] {
  const descendants = Array.from(root.querySelectorAll('details'))
  return root.tagName === 'DETAILS' ? [root as HTMLDetailsElement, ...descendants] : descendants
}

export function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 100
}

/** True only when the scroller is essentially pinned to its very bottom. */
export function isAtBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 4
}

export function scrollConversationToBottom(): void {
  const conversation = elements.conversation
  // Bypass `scroll-behavior: smooth` so the jump lands in the same frame; a
  // smooth animation is interruptible by the catalog pushes that follow a
  // session open, leaving the view stranded at the top.
  const previous = conversation.style.scrollBehavior
  conversation.style.scrollBehavior = 'auto'
  conversation.scrollTop = conversation.scrollHeight
  conversation.style.scrollBehavior = previous
  // Re-assert once layout settles in case late content (images, markdown)
  // grows the transcript after the jump.
  window.requestAnimationFrame(() => {
    conversation.scrollTop = conversation.scrollHeight
  })
}

export function formatRelativeTime(time: number): string {
  const delta = Date.now() - time
  if (delta < 60_000) return t('justNow')
  if (delta < 3_600_000) return t('minutesAgo', { count: Math.floor(delta / 60_000) })
  if (delta < 86_400_000) return t('hoursAgo', { count: Math.floor(delta / 3_600_000) })
  return new Date(time).toLocaleDateString()
}

export function formatTokenCount(count: number): string {
  return Number(count).toLocaleString()
}

export function estimateReasoningTokens(text: string): number {
  return Math.max(1, Math.round(String(text || '').trim().length / 4))
}

export function cssEscape(value: string): string {
  return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}

export function copyText(text: string): void {
  if (navigator.clipboard?.writeText !== undefined) {
    navigator.clipboard.writeText(text).catch(() => legacyCopy(text))
  } else {
    legacyCopy(text)
  }
}

function legacyCopy(text: string): void {
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  try {
    document.execCommand('copy')
  } catch {
    // Clipboard unavailable; the user can still select the text manually.
  }
  area.remove()
}
