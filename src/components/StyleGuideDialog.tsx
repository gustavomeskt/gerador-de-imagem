import { X } from 'lucide-react'
import { ASPECT_LABELS, defaultStyleGuide, type PreferredAspect, type StyleGuide } from '../generation/styleGuide'
import { useFlowStore } from '../store/useFlowStore'

const TEXT_FIELDS: Array<{ key: keyof StyleGuide; label: string; placeholder: string }> = [
  { key: 'visualStyle', label: 'Estilo visual padrão', placeholder: 'Ex.: fotografia publicitária realista, estilo UGC' },
  { key: 'lighting', label: 'Iluminação', placeholder: 'Ex.: luz natural de janela, suave' },
  { key: 'quality', label: 'Qualidade visual pretendida', placeholder: 'Ex.: alta nitidez, pele com textura natural' },
  { key: 'environment', label: 'Características permanentes dos ambientes', placeholder: 'Ex.: cozinha clara com azulejo branco e plantas' },
  { key: 'continuity', label: 'Continuidade de roupas e objetos', placeholder: 'Ex.: o pote de gelatina é sempre verde com tampa branca' },
]

// Guia de estilo do projeto: regras visuais aplicadas a todas as gerações
// deste projeto. Só diz COMO a imagem deve parecer — não muda a história.
export default function StyleGuideDialog({ flowId, onClose }: { flowId: string; onClose: () => void }) {
  const guide = useFlowStore((s) => s.flowsData[flowId]?.styleGuide) ?? defaultStyleGuide()
  const update = useFlowStore((s) => s.updateStyleGuide)
  const set = (partial: Partial<StyleGuide>) => update(flowId, partial)

  return (
    <div className="ifs-dialog-backdrop" onClick={onClose}>
      <div className="ifs-dialog ifs-dialog--wide" role="dialog" aria-modal="true" aria-label="Guia de estilo" onClick={(e) => e.stopPropagation()}>
        <div className="ifs-dialog__header">
          <h2>Guia de estilo do projeto</h2>
          <button type="button" className="ifs-dialog__close" onClick={onClose} title="Fechar">
            <X size={16} />
          </button>
        </div>

        <div className="ifs-style-guide">
          <label className="ifs-style-guide__check">
            <input type="checkbox" checked={guide.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
            Aplicar este guia em todas as gerações do projeto
          </label>

          <fieldset disabled={!guide.enabled}>
            <label className="ifs-style-guide__check">
              <input type="checkbox" checked={guide.photorealistic} onChange={(e) => set({ photorealistic: e.target.checked })} />
              Fotografia realista e natural (sem ilustração, desenho ou 3D)
            </label>
            <label className="ifs-style-guide__check">
              <input type="checkbox" checked={guide.noText} onChange={(e) => set({ noText: e.target.checked })} />
              Sem textos, legendas, logos ou marcas-d'água
            </label>
            <label>
              Proporção preferida (vale para nós de imagem novos)
              <select value={guide.aspect} onChange={(e) => set({ aspect: e.target.value as PreferredAspect })}>
                {Object.entries(ASPECT_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {TEXT_FIELDS.map((f) => (
              <label key={f.key}>
                {f.label}
                <textarea
                  rows={2}
                  value={guide[f.key] as string}
                  placeholder={f.placeholder}
                  maxLength={1000}
                  onChange={(e) => set({ [f.key]: e.target.value } as Partial<StyleGuide>)}
                />
              </label>
            ))}
          </fieldset>
          <p className="ifs-preview__muted">
            O guia nunca acrescenta acontecimentos à cena: as instruções pedem para mostrar só o que o prompt descreve.
          </p>
        </div>

        <div className="ifs-dialog__actions">
          <button type="button" className="ifs-dialog__cancel" onClick={() => set(defaultStyleGuide())}>
            Restaurar padrão (fotorrealista 9:16)
          </button>
          <button type="button" className="ifs-btn-primary" onClick={onClose}>
            Pronto
          </button>
        </div>
      </div>
    </div>
  )
}
