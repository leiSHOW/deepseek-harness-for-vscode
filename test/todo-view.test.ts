import { describe, expect, it } from 'vitest'
import { todoGlyph, todoListSignature, todoProgress } from '../src/domain/todo-view.js'

describe('todoGlyph', () => {
  it('maps completed/in_progress/pending to their glyphs', () => {
    expect(todoGlyph('completed')).toBe('☑')
    expect(todoGlyph('in_progress')).toBe('●')
    expect(todoGlyph('pending')).toBe('○')
    expect(todoGlyph('anything-else')).toBe('○')
  })
})

describe('todoProgress', () => {
  it('counts completed vs total', () => {
    const todos = [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ]
    expect(todoProgress(todos)).toEqual({ done: 1, total: 3 })
  })

  it('handles an empty list', () => {
    expect(todoProgress([])).toEqual({ done: 0, total: 0 })
  })
})

describe('todoListSignature', () => {
  it('is stable for identical lists and distinct for changed ones', () => {
    const a = [{ content: 'x', status: 'pending' }]
    const b = [{ content: 'x', status: 'completed' }]
    expect(todoListSignature(a)).toBe(todoListSignature([{ content: 'x', status: 'pending' }]))
    expect(todoListSignature(a)).not.toBe(todoListSignature(b))
  })
})
