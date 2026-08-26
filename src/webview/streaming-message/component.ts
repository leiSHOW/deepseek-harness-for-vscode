import type { ChatBlock, ChatItem } from '../../domain/workbench-state.js'
import { createSequentialActivityDots } from '../activity-indicator/component.js'
import { nextStreamText } from './model.js'

type StreamingMessage = Pick<ChatItem, 'status' | 'blocks'>

interface StreamState {
  rendered: string
  target: string
  frame: number | undefined
  /** Authoritative adapter-reported reasoning tokens, once the usage chunk lands. */
  tokens?: number
  /** Monotonic live estimate so the counter only grows while streaming. */
  labelTokens?: number
  /** Whether the reasoning content keeps auto-scrolling to its own bottom. */
  follow?: boolean
}

/** Rough live token estimate for streamed reasoning text (≈4 chars/token). */
function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.trim().length / 4))
}

/** Owns reasoning disclosure state and smooth incremental assistant text. */
export class StreamingMessageComponent {
  private readonly streams = new WeakMap<HTMLElement, StreamState>()

  constructor(private readonly options: {
    readonly document: Document
    readonly reasoningLabel: () => string
    /** "Thinking… · 1,234 tokens" once a running reasoning block has text or usage. */
    readonly thinkingLabel: (tokens?: number) => string
    /** "Thought for 12s · 342 tokens" style label once a reasoning block has known timing. */
    readonly reasoningDoneLabel: (elapsedMs: number, tokens?: number) => string
    readonly renderMarkdown: (target: HTMLElement, source: string) => void
    readonly onStreamFrame: () => void
  }) {}

  render(body: HTMLElement, item: StreamingMessage): void {
    const running = item.status === 'running'
    for (const [index, block] of (item.blocks ?? []).entries()) {
      body.append(this.renderBlock(block, index, running))
    }
    if (running) body.append(createSequentialActivityDots(this.options.document))
  }

  patch(body: HTMLElement, item: StreamingMessage): boolean {
    const blocks = item.blocks ?? []
    const renderedBlocks = Array.from(body.children).filter((child) => !child.classList.contains('streaming-indicator'))
    if (renderedBlocks.length !== blocks.length) return false
    const running = item.status === 'running'
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]
      const rendered = renderedBlocks[index]
      if (block === undefined || !(rendered instanceof HTMLElement)) return false
      if (!this.patchBlock(rendered, block, running)) return false
    }
    const indicator = body.querySelector('.streaming-indicator')
    if (running && indicator === null) body.append(createSequentialActivityDots(this.options.document))
    else if (!running) indicator?.remove()
    return true
  }

  private renderBlock(block: ChatBlock, index: number, messageRunning: boolean): HTMLElement {
    const running = messageRunning && block.streaming === true
    if (block.kind === 'reasoning') {
      const details = this.options.document.createElement('details')
      details.className = `reasoning-block${running ? ' running' : ''}`
      details.dataset.disclosureKey = `reasoning-${index}`
      details.dataset.autoOpen = running ? 'true' : 'false'
      details.open = running
      const summary = this.options.document.createElement('summary')
      summary.append(this.reasoningDot(), this.label(running, block), this.reasoningPreview(block.text), this.chevron())
      const content = this.options.document.createElement('div')
      content.className = `reasoning-content markdown-body${running ? ' streaming-content' : ''}`
      this.renderContent(content, block, running)
      details.append(summary, content)
      return details
    }
    const content = this.options.document.createElement('div')
    content.className = `content-block ${block.kind}${block.kind === 'text' ? ' markdown-body' : ''}${running ? ' streaming-content' : ''}`
    this.renderContent(content, block, running)
    return content
  }

  private patchBlock(rendered: HTMLElement, block: ChatBlock, messageRunning: boolean): boolean {
    const running = messageRunning && block.streaming === true
    if (block.kind === 'reasoning') {
      if (!(rendered instanceof HTMLDetailsElement) || !rendered.classList.contains('reasoning-block')) return false
      const content = rendered.querySelector<HTMLElement>('.reasoning-content')
      const label = rendered.querySelector<HTMLElement>('.reasoning-label')
      if (content === null || label === null) return false
      rendered.classList.toggle('running', running)
      rendered.dataset.autoOpen = running ? 'true' : 'false'
      rendered.open = running
      label.textContent = this.labelText(running, block)
      const summary = rendered.querySelector<HTMLElement>('.reasoning-summary')
      if (summary !== null) {
        const value = this.reasoningPreviewText(block.text)
        summary.textContent = value
        summary.title = value
      }
      content.classList.toggle('streaming-content', running)
      this.renderContent(content, block, running)
      return true
    }
    if (!rendered.classList.contains('content-block') || !rendered.classList.contains(block.kind)) return false
    rendered.classList.toggle('streaming-content', running)
    this.renderContent(rendered, block, running)
    return true
  }

  private renderContent(target: HTMLElement, block: ChatBlock, running: boolean): void {
    if (block.kind === 'image') {
      this.finishStream(target)
      target.textContent = block.text
    } else if (running) {
      this.stream(target, block.text, block.reasoningTokens)
    } else {
      this.finishStream(target)
      this.options.renderMarkdown(target, block.text)
    }
  }

  private stream(target: HTMLElement, text: string, tokens?: number): void {
    let state = this.streams.get(target)
    if (state === undefined) {
      target.textContent = ''
      state = { rendered: '', target: text, frame: undefined, follow: true, ...(tokens === undefined ? {} : { tokens }) }
      this.streams.set(target, state)
      // The reasoning content auto-follows its own stream, but an intentional
      // scroll-up inside the card must win: once the reader moves off the
      // bottom the card stops being yanked down, and resumes only after they
      // scroll back to its very bottom.
      if (target.classList.contains('reasoning-content') && target.dataset.followBound === undefined) {
        target.dataset.followBound = 'true'
        target.addEventListener('scroll', () => {
          const current = this.streams.get(target)
          if (current === undefined) return
          const atBottom = target.scrollHeight - target.scrollTop - target.clientHeight <= 4
          if (atBottom) current.follow = true
          else if (current.follow !== false) current.follow = false
        }, { passive: true })
      }
    } else {
      state.target = text
      if (tokens !== undefined) state.tokens = tokens
    }
    if (state.frame === undefined) this.schedule(target, state)
  }

  private schedule(target: HTMLElement, state: StreamState): void {
    state.frame = requestAnimationFrame(() => {
      state.frame = undefined
      if (!target.isConnected) return
      state.rendered = nextStreamText(state.rendered, state.target)
      // Render each partial frame as Markdown so formatting appears while streaming,
      // instead of showing raw Markdown source until the block completes.
      this.options.renderMarkdown(target, state.rendered)
      if (target.classList.contains('reasoning-content')) {
        if (state.follow !== false) target.scrollTop = target.scrollHeight
        this.updateStreamingLabel(target, state)
      }
      this.options.onStreamFrame()
      if (state.rendered !== state.target) this.schedule(target, state)
    })
  }

  /** Keeps the "Thinking… · N tokens" label ticking while reasoning streams. */
  private updateStreamingLabel(target: HTMLElement, state: StreamState): void {
    const label = target.closest('.reasoning-block')?.querySelector('.reasoning-label')
    if (!(label instanceof HTMLElement)) return
    if (state.tokens !== undefined) {
      label.textContent = this.options.thinkingLabel(state.tokens)
      return
    }
    const estimate = estimateTokens(state.rendered)
    if (estimate <= (state.labelTokens ?? 0)) return
    state.labelTokens = estimate
    label.textContent = this.options.thinkingLabel(estimate)
  }

  private finishStream(target: HTMLElement): void {
    const state = this.streams.get(target)
    if (state?.frame !== undefined) cancelAnimationFrame(state.frame)
    this.streams.delete(target)
  }

  private reasoningPreview(text: string): HTMLElement {
    const preview = this.options.document.createElement('span')
    preview.className = 'reasoning-summary'
    const value = this.reasoningPreviewText(text)
    preview.textContent = value
    preview.title = value
    return preview
  }

  private reasoningPreviewText(text: string): string {
    const first = text.split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== '') ?? ''
    return first.length > 80 ? `${first.slice(0, 80)}…` : first
  }

  private reasoningDot(): HTMLElement {
    const dot = this.options.document.createElement('span')
    dot.className = 'reasoning-dot'
    dot.setAttribute('aria-hidden', 'true')
    return dot
  }

  private label(running: boolean, block?: ChatBlock): HTMLElement {
    const label = this.options.document.createElement('span')
    label.className = 'reasoning-label'
    label.textContent = this.labelText(running, block)
    return label
  }

  private labelText(running: boolean, block?: ChatBlock): string {
    if (running) return this.options.thinkingLabel(this.liveTokens(block))
    if (block?.duration !== undefined) {
      const elapsed = Math.max(0, (block.duration.endedAt ?? Date.now()) - block.duration.startedAt)
      return this.options.reasoningDoneLabel(elapsed, block.reasoningTokens)
    }
    return this.options.reasoningLabel()
  }

  /** Adapter-reported count when known, else a live estimate from the streamed text. */
  private liveTokens(block: ChatBlock | undefined): number | undefined {
    if (block === undefined || block.kind !== 'reasoning') return undefined
    if (block.reasoningTokens !== undefined) return block.reasoningTokens
    if (block.text.trim() === '') return undefined
    return estimateTokens(block.text)
  }

  private chevron(): HTMLElement {
    const chevron = this.options.document.createElement('span')
    chevron.className = 'reasoning-chevron'
    chevron.textContent = '⌄'
    chevron.setAttribute('aria-hidden', 'true')
    return chevron
  }
}
