import { describe, expect, it } from 'vitest'
import { composerStatusText } from '../src/webview/composer-status.js'

const labels = {
  oneShotReadOnly: 'One-shot · read-only',
  continuableSubagent: 'Continuable sub-agent',
}

describe('composerStatusText', () => {
  it('shows no status line while running (the send button carries the stop hint)', () => {
    expect(composerStatusText({ running: true }, labels)).toBe('')
  })

  it('keeps one-shot status visible', () => {
    expect(composerStatusText({ running: false, subagentMode: 'one-shot' }, labels)).toBe('One-shot · read-only')
  })

  it('keeps continuable sub-agent status visible', () => {
    expect(composerStatusText({ running: false, subagentMode: 'continuable' }, labels)).toBe('Continuable sub-agent')
  })

  it('returns empty for an idle ordinary session and for missing input', () => {
    expect(composerStatusText({ running: false }, labels)).toBe('')
    expect(composerStatusText(undefined, labels)).toBe('')
  })
})
