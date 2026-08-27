import { describe, expect, it } from 'vitest'

import {
  buildCarryOverMessage,
  isCarriedText,
  splitCarriedBlocks,
  stripCarriedPrefix,
  type CarryBlockLike,
  type CarryTurn,
} from '../src/domain/carry-over.js'

function turn(role: 'user' | 'assistant', text: string): CarryTurn {
  return { role, text }
}

function block(kind: CarryBlockLike['kind'], text: string): CarryBlockLike {
  return { kind, text }
}

describe('carry-over message', () => {
  it('returns undefined when there is nothing worth carrying', () => {
    expect(buildCarryOverMessage({ sourceSessionId: 's1', turns: [] })).toBeUndefined()
    expect(buildCarryOverMessage({ sourceSessionId: 's1', turns: [turn('user', '   \n  ')] })).toBeUndefined()
  })

  it('wraps the digest with metadata and a tool-omission note', () => {
    const message = buildCarryOverMessage({
      sourceSessionId: 'session-abc',
      fromPreset: 'standard',
      toPreset: 'minimal',
      turns: [turn('user', 'Fix the login bug'), turn('assistant', 'The fix lives in auth.ts.')],
      skippedToolCalls: 7,
    })
    expect(message).toBeDefined()
    expect(message).toContain('<context-carry source="session-abc" from="standard" to="minimal">')
    expect(message).toContain('- [user] Fix the login bug')
    expect(message).toContain('- [assistant] The fix lives in auth.ts.')
    expect(message).toContain('(7 tool operations')
    expect(message?.trimEnd().endsWith('</context-carry>')).toBe(true)
  })

  it('keeps only the newest turns and truncates each one', () => {
    const turns = Array.from({ length: 30 }, (_, index) => turn(index % 2 === 0 ? 'user' : 'assistant', `turn ${index}`))
    const message = buildCarryOverMessage({ sourceSessionId: 's', turns })
    expect(message).not.toContain('turn 15\n')
    expect(message).toContain('- [assistant] turn 29')
    const long = 'x'.repeat(700)
    const truncated = buildCarryOverMessage({ sourceSessionId: 's', turns: [turn('user', long)] })
    expect(truncated).toContain('…')
    expect(truncated).not.toContain(long)
  })

  it('escapes attribute metacharacters from identifiers', () => {
    const message = buildCarryOverMessage({
      sourceSessionId: 'we"ird<id>',
      turns: [turn('user', 'hello')],
    })
    expect(message).toContain('source="we_ird_id_"')
  })
})

describe('splitCarriedBlocks', () => {
  it('separates leading carried blocks from the visible remainder', () => {
    const carried = buildCarryOverMessage({
      sourceSessionId: 's1',
      fromPreset: 'standard',
      toPreset: 'minimal',
      turns: [turn('user', 'prior question')],
    })!
    const blocks = [
      block('text', carried),
      block('image', '[Image attachment]'),
      block('text', 'continue please'),
    ]
    const split = splitCarriedBlocks(blocks)
    expect(split.carriedText).toContain('prior question')
    expect(split.carriedText).not.toContain('<context-carry')
    expect(split.rest.map((entry) => entry.kind)).toEqual(['image', 'text'])
  })

  it('merges consecutive leading carried blocks and keeps a mid-stream one visible', () => {
    const first = buildCarryOverMessage({ sourceSessionId: 'a', turns: [turn('user', 'one')] })!
    const second = buildCarryOverMessage({ sourceSessionId: 'b', turns: [turn('user', 'two')] })!
    const blocks = [block('text', first), block('text', second), block('text', 'body')]
    const split = splitCarriedBlocks(blocks)
    expect(split.carriedText).toContain('one')
    expect(split.carriedText).toContain('two')
    expect(split.rest).toHaveLength(1)
    expect(split.rest[0]?.text).toBe('body')
  })

  it('treats ordinary user text verbatim (no carry region)', () => {
    const blocks = [block('text', '<context-only> look, no closing tag'), block('text', 'real text')]
    const split = splitCarriedBlocks(blocks)
    expect(split.carriedText).toBe('')
    expect(split.rest).toHaveLength(2)
  })
})

describe('stripCarriedPrefix', () => {
  it('returns non-carried text untouched', () => {
    expect(stripCarriedPrefix('plain message')).toBe('plain message')
  })

  it('round-trips a built payload down to the typed remainder', () => {
    const carried = buildCarryOverMessage({
      sourceSessionId: 's1',
      toPreset: 'minimal',
      turns: [turn('user', 'history')],
    })!
    expect(isCarriedText(carried)).toBe(true)
    expect(stripCarriedPrefix(`${carried}\nmy actual prompt`)).toBe('my actual prompt')
    // Splitter body and prefix stripper agree on what is hidden vs visible
    // when the host stores them as the gateway's two separate text blocks.
    const split = splitCarriedBlocks([block('text', carried), block('text', 'my actual prompt')])
    expect(split.carriedText).toContain('history')
    expect(split.rest[0]?.text).toBe('my actual prompt')
  })

  it('treats a merged single block as fully carried (splitter is block-granular)', () => {
    const carried = buildCarryOverMessage({ sourceSessionId: 's', turns: [turn('user', 'x')] })!
    const split = splitCarriedBlocks([block('text', `${carried}\nrest`)])
    expect(split.rest).toHaveLength(0)
    expect(split.carriedText).toContain('rest')
  })
})
