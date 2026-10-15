import { describe, expect, it } from 'vitest'
import { containRect, describeFormat, isNineSixteen, reframeRect, regionSurvivesReframe } from '../format'

describe('formato 9:16', () => {
  it('reconhece 9:16 exato (inclusive 1152×2048 do gpt-image-2) e recusa 2:3', () => {
    expect(isNineSixteen(1080, 1920)).toBe(true)
    expect(isNineSixteen(1152, 2048)).toBe(true)
    expect(isNineSixteen(1008, 1792)).toBe(true)
    expect(isNineSixteen(1024, 1536)).toBe(false)
    expect(isNineSixteen(1024, 1820)).toBe(true) // dentro da tolerância de 0,5%
    expect(isNineSixteen(null, 1920)).toBe(false)
  })

  it('expansão: a imagem 2:3 inteira cabe no quadro 1080×1920, sem corte e sem distorção', () => {
    const r = containRect(1024, 1536)
    expect(r).toMatchObject({ drawW: 1080, drawH: 1620, dx: 0, dy: 150, outW: 1080, outH: 1920 })
    // mesma escala nos dois eixos (sem esticar)
    expect(r.drawW / 1024).toBeCloseTo(r.drawH / 1536, 3)
    // a imagem desenhada fica toda dentro do quadro
    expect(r.dx).toBeGreaterThanOrEqual(0)
    expect(r.dy + r.drawH).toBeLessThanOrEqual(1920)
    // paisagem também cabe inteira
    const land = containRect(1536, 1024)
    expect(land.drawW).toBe(1080)
    expect(land.dy + land.drawH).toBeLessThanOrEqual(1920)
  })

  it('reenquadramento: informa quanto se perde e de que lado', () => {
    const center = reframeRect(1024, 1536, 0.5)
    expect(center).toMatchObject({ sw: 864, sh: 1536, sx: 80, lossPercent: 15.6 })
    expect(center.lost).toEqual({ left: 80, right: 80, top: 0, bottom: 0 })
    const left = reframeRect(1024, 1536, 0)
    expect(left.lost).toEqual({ left: 0, right: 160, top: 0, bottom: 0 })
    expect(reframeRect(1536, 1024, 0.5).lossPercent).toBeGreaterThan(60)
  })

  it('exemplo controlado: rosto encostado na borda — o recorte central cortaria, a expansão não corta nada', () => {
    const face = { x: 20, y: 300, w: 180, h: 220 } // rosto à esquerda numa imagem 1024×1536
    expect(regionSurvivesReframe(face, reframeRect(1024, 1536, 0.5))).toBe(false) // corte central perderia o rosto
    expect(regionSurvivesReframe(face, reframeRect(1024, 1536, 0))).toBe(true) // posição escolhida preserva
    // expansão: toda a imagem original é preservada
    expect(regionSurvivesReframe({ x: 0, y: 0, w: 1024, h: 1536 }, { sx: 0, sy: 0, sw: 1024, sh: 1536 })).toBe(true)
    expect(describeFormat('expanded')).toMatch(/sem corte nem distorção/)
    expect(describeFormat('reframed', { lossPercent: 15.6 })).toMatch(/15.6% da imagem ficou de fora/)
  })
})
