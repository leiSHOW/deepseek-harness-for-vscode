import { describe, expect, it } from 'vitest'
import { conversationTitle } from '../src/domain/session-title.js'

describe('conversationTitle', () => {
  it('joins text blocks into a single-line title', () => {
    expect(conversationTitle([
      { type: 'text', text: 'Fix the' },
      { type: 'text', text: 'login bug' },
    ])).toBe('Fix the login bug')
  })

  it('strips markdown symbols and collapses whitespace', () => {
    expect(conversationTitle([
      { type: 'text', text: '## Refactor **auth**\n\n  `src/auth.ts`' },
    ])).toBe('Refactor auth src/auth.ts')
  })

  it('truncates long prompts with an ellipsis', () => {
    const long = 'a'.repeat(60)
    const title = conversationTitle([{ type: 'text', text: long }])
    expect(title).toBe(`${'a'.repeat(48)}…`)
  })

  it('ignores image blocks and returns undefined for empty text', () => {
    expect(conversationTitle([{ type: 'image', text: '[Image attachment]' }])).toBeUndefined()
    expect(conversationTitle([{ type: 'text', text: '   ' }])).toBeUndefined()
    expect(conversationTitle('not-an-array')).toBeUndefined()
  })
})
