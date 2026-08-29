import { describe, expect, it } from 'vitest'
import { modelCapacity } from '../src/domain/model-capacity.js'

describe('modelCapacity', () => {
  it('resolves exact DeepSeek ids to their published windows', () => {
    expect(modelCapacity('deepseek-v4-flash')).toEqual({ contextWindow: 1_000_000, maxTokens: 384_000 })
    expect(modelCapacity('deepseek-v4-pro')).toEqual({ contextWindow: 1_000_000, maxTokens: 384_000 })
    expect(modelCapacity('deepseek-v4-flash-vision-exp')).toEqual({ contextWindow: 1_000_000, maxTokens: 384_000 })
  })

  it('resolves other sheet models to their published windows', () => {
    expect(modelCapacity('qwen-3.8-flash')).toEqual({ contextWindow: 1_000_000 })
    expect(modelCapacity('qwen-3.8-27b')).toEqual({ contextWindow: 262_144 })
    expect(modelCapacity('glm-5.3')).toEqual({ contextWindow: 1_000_000 })
    expect(modelCapacity('glm-5.1')).toEqual({ contextWindow: 200_000 })
    expect(modelCapacity('kimi-k3')).toEqual({ contextWindow: 1_000_000 })
    expect(modelCapacity('grok-4.6')).toEqual({ contextWindow: 500_000 })
    expect(modelCapacity('gpt-5.6-luna')).toEqual({ contextWindow: 1_100_000 })
  })

  it('keeps distinct free variants separate from their base entry', () => {
    expect(modelCapacity('minimax-m2.7')).toEqual({ contextWindow: 200_000 })
    expect(modelCapacity('minimax-m2.7-free')).toEqual({ contextWindow: 197_000 })
    expect(modelCapacity('laguna-s-2.1-free')).toEqual({ contextWindow: 256_000 })
  })

  it('normalizes provider prefixes like deepseek/ and qwen/', () => {
    expect(modelCapacity('deepseek/deepseek-v4-flash')).toEqual({ contextWindow: 1_000_000, maxTokens: 384_000 })
    expect(modelCapacity('qwen/qwen-3.8-flash')).toEqual({ contextWindow: 1_000_000 })
    expect(modelCapacity('openrouter/deepseek/deepseek-v4-pro')).toEqual({ contextWindow: 1_000_000, maxTokens: 384_000 })
  })

  it('normalizes version tags like :latest and :free', () => {
    expect(modelCapacity('deepseek-v4-pro:latest')).toEqual({ contextWindow: 1_000_000, maxTokens: 384_000 })
    expect(modelCapacity('minimax-m3:free')).toEqual({ contextWindow: 1_000_000 })
  })

  it('matches across separator styles and case', () => {
    expect(modelCapacity('GLM 5.3 Flash')).toEqual({ contextWindow: 1_000_000 })
    expect(modelCapacity('kimi_k2.7_code')).toEqual({ contextWindow: 256_000 })
    expect(modelCapacity('  DeepSeek-V4-Pro ')).toEqual({ contextWindow: 1_000_000, maxTokens: 384_000 })
  })

  it('returns undefined for unknown ids', () => {
    expect(modelCapacity('acme-large')).toBeUndefined()
    expect(modelCapacity('')).toBeUndefined()
  })
})
