// Historinhas fictícias usadas nos testes. Personagens fictícios.

// 4 personagens, diálogos, mudanças de ambiente, figurino, objetos,
// passagem de tempo e uma passagem que pede duas imagens.
export const STORY_FOUR = `Dona Maria acorda cedo na cozinha e prepara o café.
Ela veste um avental azul e coloca a xícara na mesa.
Seu João entra na cozinha com o jornal debaixo do braço.
Seu João: Bom dia, Maria! O cheiro está ótimo.
Dona Maria: Bom dia, João. Senta que o café está pronto.
Ana desce a escada correndo, atrasada para a escola.
Ana: Mãe, cadê minha mochila?
Dona Maria aponta para a cadeira, e depois entrega um pão para Ana.
Beto chega na sala segurando o celular, preocupado.
Beto: Pai, a internet caiu de novo!
Seu João sorri e mostra o celular novo que comprou.
Mais tarde, no quintal, Ana e Beto brincam com o cachorro.
Dona Maria observa os filhos da janela, feliz.
À noite, na sala, a família assiste televisão junta.
Beto: Esse celular novo é demais!
Dona Maria abraça Seu João no sofá.`

// Gera uma historinha longa e variada com `n` momentos (uma linha cada).
export function longStory(n: number): string {
  const places = ['na cozinha', 'na sala', 'no quintal', 'no quarto', 'na rua', 'no mercado']
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    const place = places[i % places.length]
    if (i % 3 === 1) lines.push(`${i % 2 ? 'Ana' : 'Beto'}: Momento ${i + 1}, estou ${place}!`)
    else lines.push(`Dona Maria caminha ${place} no momento ${i + 1}.`)
  }
  return lines.join('\n')
}
