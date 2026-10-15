import { describe, expect, it } from 'vitest'
import {
  clampCount,
  getSizeOption,
  isImageModel,
  MAX_IMAGES_PER_NODE,
  MODEL_LABELS,
  MODEL_MAX_N,
  MODEL_SIZES,
  splitIntoBatches,
} from '../models'

describe('splitIntoBatches', () => {
  it('divide respeitando o máximo por chamada', () => {
    expect(splitIntoBatches(10, 10)).toEqual([10])
    expect(splitIntoBatches(3, 1)).toEqual([1, 1, 1])
    expect(splitIntoBatches(7, 3)).toEqual([3, 3, 1])
  })

  it('não gera chamadas para zero ou valores inválidos', () => {
    expect(splitIntoBatches(0, 10)).toEqual([])
    expect(splitIntoBatches(-2, 10)).toEqual([])
    expect(splitIntoBatches(2, 0)).toEqual([1, 1])
  })
})

describe('clampCount', () => {
  it('limita entre 1 e o máximo por nó', () => {
    expect(clampCount(0)).toBe(1)
    expect(clampCount(5)).toBe(5)
    expect(clampCount(99)).toBe(MAX_IMAGES_PER_NODE)
    expect(clampCount(2.7)).toBe(2)
    expect(clampCount(Number.NaN)).toBe(1)
  })
})

describe('catálogo de modelos', () => {
  it('todo modelo tem rótulo, tamanhos e limite por chamada', () => {
    for (const model of Object.keys(MODEL_LABELS)) {
      expect(isImageModel(model)).toBe(true)
      if (!isImageModel(model)) continue
      expect(MODEL_SIZES[model].length).toBeGreaterThan(0)
      expect(MODEL_MAX_N[model]).toBeGreaterThanOrEqual(1)
    }
  })

  it('reconhece modelos inválidos', () => {
    expect(isImageModel('midjourney')).toBe(false)
    expect(isImageModel(undefined)).toBe(false)
  })

  it('9:16 do gpt-image é gerado em 1024x1536 e recortado', () => {
    const option = getSizeOption('gpt-image-1.5', '1024x1536')
    expect(option?.aspect).toBeCloseTo(9 / 16)
    expect(option?.crop).toBe(true)
    expect(getSizeOption('gpt-image-1.5', '999x999')).toBeUndefined()
  })
})
