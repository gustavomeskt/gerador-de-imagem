import { Copy, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { MODEL_LABELS } from '../generation/models'
import { REFERENCE_ROLE_LABELS, type ReferenceRole } from '../generation/references'
import { SHEET_FIELDS } from '../generation/characters'
import { ASPECT_LABELS } from '../generation/styleGuide'
import { useCharacterStore } from '../store/useCharacterStore'
import { useFlowStore } from '../store/useFlowStore'

// Mostra, antes de gerar, exatamente o que vai na geração: personagens (com
// as fotos que serão enviadas e a ficha), referências, regras de estilo e o
// texto final. É a mesma montagem usada pela geração.
export default function PromptPreviewDialog({ flowId, nodeId, onClose }: { flowId: string; nodeId: string; onClose: () => void }) {
  // recalcula quando o projeto ou a biblioteca mudam (fora do seletor, pra
  // não criar um objeto novo a cada renderização)
  const flowsData = useFlowStore((s) => s.flowsData)
  const characters = useCharacterStore((s) => s.characters)
  const plan = useMemo(
    () => (void flowsData, void characters, useFlowStore.getState().getGenerationPreview(flowId, nodeId)),
    [flowsData, characters, flowId, nodeId],
  )
  const [copied, setCopied] = useState(false)

  async function copy() {
    if ('error' in plan) return
    await navigator.clipboard?.writeText(plan.prompt).catch(() => undefined)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // portal no <body>: o diálogo é aberto de dentro de um nó do canvas, que
  // tem zoom/deslocamento — sem o portal ele ficaria preso a esse espaço
  return createPortal(
    <div className="ifs-dialog-backdrop" onClick={onClose}>
      <div className="ifs-dialog ifs-dialog--wide" role="dialog" aria-modal="true" aria-label="Instruções da geração" onClick={(e) => e.stopPropagation()}>
        <div className="ifs-dialog__header">
          <h2>Instruções desta geração</h2>
          <button type="button" className="ifs-dialog__close" onClick={onClose} title="Fechar">
            <X size={16} />
          </button>
        </div>

        {'error' in plan ? (
          <p className="ifs-preview__error">{plan.error}</p>
        ) : (
          <div className="ifs-preview">
            <p className="ifs-preview__meta">
              {MODEL_LABELS[plan.model]} · {plan.images.length} foto(s) de referência
              {plan.inputFidelity ? ` · fidelidade ${plan.inputFidelity === 'high' ? 'alta' : 'baixa'}` : ''}
            </p>

            <section>
              <h3>Personagens ({plan.characters.length})</h3>
              {plan.characters.length === 0 && <p className="ifs-preview__muted">Nenhum personagem da biblioteca nesta cena.</p>}
              {plan.characters.map((c) => (
                <div key={c.id} className="ifs-preview__character">
                  <div className="ifs-preview__character-head">
                    <strong>{c.name}</strong>
                    <span>
                      v{c.version} · {c.sent} de {c.total} foto(s) enviada(s)
                    </span>
                  </div>
                  <div className="ifs-preview__thumbs">
                    {plan.images
                      .filter((img) => img.kind === 'character' && img.ownerId === c.id)
                      .map((img, i) => (
                        <figure key={img.sha256 + i}>
                          {img.src ? <img src={img.src} alt={img.photoName} /> : null}
                          <figcaption>{i === 0 ? 'principal' : img.photoName}</figcaption>
                        </figure>
                      ))}
                  </div>
                  <dl>
                    {SHEET_FIELDS.filter((f) => f.key !== 'name' && c.sheet[f.key]).map((f) => (
                      <div key={f.key}>
                        <dt>{f.label}</dt>
                        <dd>{c.sheet[f.key]}</dd>
                      </div>
                    ))}
                    {c.sceneNote && (
                      <div className="ifs-preview__scene-note">
                        <dt>Só nesta cena</dt>
                        <dd>{c.sceneNote}</dd>
                      </div>
                    )}
                  </dl>
                </div>
              ))}
              {plan.omitted.length > 0 && (
                <p className="ifs-preview__muted">
                  Fotos extras que não couberam no limite: {plan.omitted.map((o) => `${o.ownerLabel} (${o.photoName})`).join(', ')}.
                </p>
              )}
            </section>

            <section>
              <h3>Referências avulsas ({plan.references.length})</h3>
              {plan.references.length === 0 && <p className="ifs-preview__muted">Nenhum nó de referência conectado.</p>}
              {plan.references.map((r, i) => (
                <div key={r.label + i} className="ifs-preview__ref">
                  <strong>{r.label}</strong> — {REFERENCE_ROLE_LABELS[r.role as ReferenceRole]} · {r.count} foto(s)
                  <div className="ifs-preview__thumbs">
                    {plan.images
                      .filter((img) => img.kind === 'reference' && img.ownerLabel === r.label)
                      .map((img, j) => (
                        <figure key={img.sha256 + j}>{img.src ? <img src={img.src} alt={img.photoName} /> : null}</figure>
                      ))}
                  </div>
                </div>
              ))}
            </section>

            <section>
              <h3>Guia de estilo do projeto</h3>
              {plan.style ? (
                <ul className="ifs-preview__style">
                  <li>{plan.style.photorealistic ? 'Fotografia realista e natural' : 'Estilo livre'}</li>
                  {plan.style.visualStyle && <li>Estilo: {plan.style.visualStyle}</li>}
                  {plan.style.lighting && <li>Iluminação: {plan.style.lighting}</li>}
                  {plan.style.quality && <li>Qualidade: {plan.style.quality}</li>}
                  <li>Proporção: {ASPECT_LABELS[plan.style.aspect]}</li>
                  {plan.style.environment && <li>Ambientes: {plan.style.environment}</li>}
                  {plan.style.continuity && <li>Continuidade: {plan.style.continuity}</li>}
                  {plan.style.noText && <li>Sem textos, legendas ou marcas-d'água</li>}
                </ul>
              ) : (
                <p className="ifs-preview__muted">Guia de estilo desligado neste projeto.</p>
              )}
            </section>

            <section>
              <div className="ifs-preview__prompt-head">
                <h3>Texto final enviado ao modelo</h3>
                <button type="button" className="ifs-dialog__cancel" onClick={copy}>
                  <Copy size={13} /> {copied ? 'Copiado!' : 'Copiar'}
                </button>
              </div>
              <textarea className="ifs-preview__prompt" readOnly value={plan.prompt} rows={12} />
              <p className="ifs-preview__muted">
                Para ajustar a cena sem mudar a ficha permanente, edite o prompt ou o campo "Nesta cena" de cada personagem no
                nó de imagem. As fotos acima vão junto como imagens — não são trocadas por texto.
              </p>
            </section>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
