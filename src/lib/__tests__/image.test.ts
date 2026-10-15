import { describe, expect, it } from 'vitest'
import { computeCenterCrop } from '../image'

describe('computeCenterCrop', () => {
  it('2:3 (1024x1536) para 9:16 corta as laterais, centralizado', () => {
    expect(computeCenterCrop(1024, 1536, 9 / 16)).toEqual({ sx: 80, sy: 0, width: 864, height: 1536 })
  })

  it('3:2 (1536x1024) para 16:9 corta em cima e embaixo, centralizado', () => {
    expect(computeCenterCrop(1536, 1024, 16 / 9)).toEqual({ sx: 0, sy: 80, width: 1536, height: 864 })
  })

  it('não corta quando a proporção já bate', () => {
    expect(computeCenterCrop(1024, 1024, 1)).toEqual({ sx: 0, sy: 0, width: 1024, height: 1024 })
  })
})
