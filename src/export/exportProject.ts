import { repository } from '../persistence/repository'
import { useCharacterStore } from '../store/useCharacterStore'
import { useFlowStore } from '../store/useFlowStore'
import type { ProjectManifest } from './projectZip'

// Gera o ZIP do projeto a partir do estado atual e dispara o download.
export async function exportProjectZip(flowId: string): Promise<ProjectManifest> {
  const state = useFlowStore.getState()
  const meta = state.flows.find((f) => f.id === flowId)
  const slice = state.flowsData[flowId]
  if (!meta || !slice) throw new Error('Projeto não encontrado.')

  const persistent = state.persistence === 'indexeddb'
  // JSZip só é baixado quando alguém exporta
  const { buildProjectZip } = await import('./projectZip')
  const { data, manifest, fileName } = await buildProjectZip({
    meta,
    slice,
    loadAsset: (id) => (persistent ? repository.getAsset(id) : Promise.resolve(undefined)),
    characters: useCharacterStore.getState().characters,
  })

  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/zip' }))
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.click()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
  return manifest
}
