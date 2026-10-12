import { createContext, useContext } from 'react'

// Carrega o id do fluxo que o canvas atual está mostrando — os nós (Prompt,
// Imagem, dock) leem daqui em vez de depender de um "fluxo ativo" global,
// pra não ter corrida/flash ao trocar de fluxo pela URL.
export const FlowIdContext = createContext<string | null>(null)

export function useFlowId(): string {
  const id = useContext(FlowIdContext)
  if (!id) throw new Error('useFlowId precisa estar dentro de um FlowIdContext.Provider')
  return id
}
