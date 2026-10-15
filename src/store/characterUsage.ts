import { useFlowStore } from './useFlowStore'

// Em quais projetos (e quantos nós de imagem) um personagem da biblioteca é
// usado — mostrado antes de excluir, pra nada quebrar em silêncio.
export interface CharacterUsage {
  flowId: string
  flowName: string
  nodeCount: number
}

export function projectsUsingCharacter(characterId: string): CharacterUsage[] {
  const { flows, flowsData } = useFlowStore.getState()
  return flows.flatMap((f) => {
    const nodeCount = (flowsData[f.id]?.nodes ?? []).filter(
      (n) => n.type === 'image' && (n.data.castIds ?? []).includes(characterId),
    ).length
    return nodeCount > 0 ? [{ flowId: f.id, flowName: f.name, nodeCount }] : []
  })
}
