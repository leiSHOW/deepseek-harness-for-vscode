import { describe, expect, it } from 'vitest'
import { autoEffort, resolveEffortIntent, isAutoEffort } from '../src/domain/session-effort.js'

const FULL = [
  { id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' },
]

const noHeavy = { promptTokens: 500, attachmentCount: 0, historyTurns: 0 }
const heavy = { promptTokens: 12_000, attachmentCount: 0, historyTurns: 0 }
const withAttachment = { promptTokens: 500, attachmentCount: 1, historyTurns: 0 }
const longHistory = { promptTokens: 500, attachmentCount: 0, historyTurns: 6 }

describe('isAutoEffort', () => {
  it('recognises only the auto sentinel', () => {
    expect(isAutoEffort('auto')).toBe(true)
    expect(isAutoEffort('high')).toBe(false)
  })
})

describe('autoEffort', () => {
  it('stays off/high/max and never emits an unknown tier', () => {
    expect(autoEffort(FULL, noHeavy)).toBe('low')
    expect(autoEffort(FULL, { promptTokens: 500, attachmentCount: 0, historyTurns: 1 })).toBe('high')
    expect(autoEffort(FULL, heavy)).toBe('max')
    expect(autoEffort(FULL, withAttachment)).toBe('max')
    expect(autoEffort(FULL, longHistory)).toBe('max')
  })

  it('degrades to the highest available tier when the target is unsupported', () => {
    expect(autoEffort([{ id: 'off' }, { id: 'max' }], heavy)).toBe('max')
    expect(autoEffort([{ id: 'off' }, { id: 'low' }], heavy)).toBe('low')
    expect(autoEffort([{ id: 'off' }], heavy)).toBe('off')
  })

  it('prefers the highest supported tier over the first-listed one', () => {
    // target high, but the model only offers low and max → max, never the
    // first-listed low.
    expect(autoEffort([{ id: 'low' }, { id: 'max' }], { promptTokens: 500, attachmentCount: 0, historyTurns: 1 }))
      .toBe('max')
  })

  it('returns undefined for an empty option set', () => {
    expect(autoEffort([], heavy)).toBeUndefined()
  })
})

describe('resolveEffortIntent', () => {
  it('passes a concrete supported effort through unchanged', () => {
    expect(resolveEffortIntent('low', FULL, heavy)).toBe('low')
  })

  it('falls a concrete unsupported effort back to the highest tier', () => {
    expect(resolveEffortIntent('max', [{ id: 'off' }, { id: 'low' }], heavy)).toBe('low')
  })

  it('resolves auto to a real tier that is present in the options', () => {
    const resolved = resolveEffortIntent('auto', FULL, noHeavy)
    expect(['low', 'high', 'max']).toContain(resolved)
  })
})
