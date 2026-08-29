import { describe, expect, it } from 'vitest'
import { supportsImageInput } from '../src/domain/model-modalities.js'

describe('supportsImageInput', () => {
  it('accepts vision-named models via the naming-convention fallback', () => {
    expect(supportsImageInput('deepseek-v4-flash-vision-exp')).toBe(true)
    expect(supportsImageInput('deepseek/deepseek-v4-flash-vision-exp')).toBe(true)
    expect(supportsImageInput('gpt-4o-vision')).toBe(true)
    expect(supportsImageInput('DEEPSEEK-V4-FLASH-VISION')).toBe(true)
  })

  it('accepts table-listed models regardless of provider prefix, tag, case, or separators', () => {
    // User's provider sheet (pi-ai catalog: input includes image).
    expect(supportsImageInput('minimax-m3')).toBe(true)
    expect(supportsImageInput('minimax/minimax-m3')).toBe(true)
    expect(supportsImageInput('minimax-m3-free')).toBe(true)
    expect(supportsImageInput('qwen-3.7-plus')).toBe(true)
    expect(supportsImageInput('kimi-k2.7-code-highspeed')).toBe(true)
    expect(supportsImageInput('step-3.7-flash')).toBe(true)
    expect(supportsImageInput('mimo-v2.5')).toBe(true)
    expect(supportsImageInput('grok-4.5')).toBe(true)
    expect(supportsImageInput('grok-4.6')).toBe(true)
    expect(supportsImageInput('gpt-5.6-luna')).toBe(true)
    expect(supportsImageInput('kimi-k3')).toBe(true)
    expect(supportsImageInput('qwen-3.8-max')).toBe(true)
    // Major families from the curated table.
    expect(supportsImageInput('claude-sonnet-5')).toBe(true)
    expect(supportsImageInput('anthropic/claude-sonnet-5')).toBe(true)
    expect(supportsImageInput('gpt-5.2')).toBe(true)
    expect(supportsImageInput('gemini-3.5-flash')).toBe(true)
    expect(supportsImageInput('google/gemini-2.5-flash')).toBe(true)
    expect(supportsImageInput('qwen/qwen3-vl-8b-instruct')).toBe(true)
    expect(supportsImageInput('glm-4.6v')).toBe(true)
  })

  it('rejects text-only models', () => {
    expect(supportsImageInput('deepseek-v4-flash')).toBe(false)
    expect(supportsImageInput('deepseek/deepseek-v4-pro')).toBe(false)
    expect(supportsImageInput('glm-5')).toBe(false)
    expect(supportsImageInput('step-3.5-flash')).toBe(false)
    expect(supportsImageInput('qwen-3.8-flash')).toBe(false)
    expect(supportsImageInput('')).toBe(false)
  })
})
