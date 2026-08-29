import { describe, expect, it } from 'vitest'
import { supportsImageInput } from '../src/domain/model-modalities.js'

describe('supportsImageInput', () => {
  it('accepts vision-named models', () => {
    expect(supportsImageInput('deepseek-v4-flash-vision-exp')).toBe(true)
    expect(supportsImageInput('deepseek/deepseek-v4-flash-vision-exp')).toBe(true)
    expect(supportsImageInput('gpt-4o-vision')).toBe(true)
    expect(supportsImageInput('DEEPSEEK-V4-FLASH-VISION')).toBe(true)
  })

  it('rejects text-only models', () => {
    expect(supportsImageInput('deepseek-v4-flash')).toBe(false)
    expect(supportsImageInput('deepseek/deepseek-v4-pro')).toBe(false)
    expect(supportsImageInput('')).toBe(false)
  })
})
