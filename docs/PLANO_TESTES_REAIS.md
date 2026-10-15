# Plano de testes reais (pagos) — NÃO EXECUTADO

Este plano só deve ser executado com autorização explícita. Nenhuma chamada
paga foi feita até agora: todos os testes usaram o provedor simulado ou
respostas falsas da API.

## Objetivo

Validar com imagens reais o que os testes simulados não conseguem provar:
identidade facial a partir das selfies, consistência de roupa e cenário entre
cenas, pessoas na quantidade e posição certas, e o formato 9:16 nativo.

## Preparação (sem custo)

1. Fotos de teste de pessoas que AUTORIZARAM o uso (selfies nítidas, de
   frente, boa luz; 2 a 3 fotos por pessoa). Nada de fotos de terceiros.
2. `.env` do servidor (nunca no repositório):
   ```
   IMAGE_BACKEND_MODE=openai
   OPENAI_API_KEY=...            # só no .env do servidor
   ALLOWED_MODELS=gpt-image-2,gpt-image-1.5
   MAX_COST_PER_JOB_USD=0.50     # nenhuma imagem acima disso
   MAX_COST_PER_BATCH_USD=1.00   # nenhum lote acima disso
   DAILY_BUDGET_USD=4.00         # teto do dia inteiro
   DAILY_IMAGE_LIMIT=20
   MAX_CONCURRENT_REQUESTS=1
   ```
3. No app: provedor **Backend**. Cada lote mostra o custo estimado e só segue
   com confirmação.

## Testes (gpt-image-2, 1152×2048 = 9:16 nativo, qualidade média)

Valores por imagem calculados pela tabela do servidor (`server/pricing.ts`),
pelo **limite superior**. O preço do gpt-image-2 não pôde ser confirmado na
documentação oficial a partir deste ambiente: foi usado o maior valor público
encontrado, proporcional à área. O orçamento mostrado pelo app antes de cada
lote é o que vale; a cobrança real é a da fatura da OpenAI.

| # | Teste | Imagens | Fotos por imagem | Estimativa |
|---|---|---|---|---|
| 1 | Uma pessoa, uma cena simples ("Dona Maria prepara o café na cozinha") | 1 | 1 | US$ 0,15 |
| 2 | A mesma pessoa em 3 ambientes (cozinha, sala, quintal) | 3 | 1 | US$ 0,46 |
| 3 | Mudança de expressão e enquadramento (close sorrindo; plano médio preocupada) | 2 | 1 | US$ 0,31 |
| 4 | Duas pessoas na mesma imagem, com posições indicadas | 2 | 2 | US$ 0,45 |
| 5 | Continuidade: duas cenas seguidas no mesmo ambiente, a 2ª usando a 1ª (aprovada) como referência | 2 | 2 + 1 | US$ 0,60 |
| 6* | Três pessoas (só se 1–5 forem satisfatórios) | 1 | 3 | US$ 0,30 |
| 7* | Quatro pessoas (só se o 6 for satisfatório) | 1 | 4 | US$ 0,37 |
| 8* | Comparação: gpt-image-1.5 (2:3 + expansão para 9:16) na cena do teste 1 | 1 | 1 | US$ 0,14 |

\* condicionais.

- Testes 1–5: **US$ 1,97**
- Com os condicionais 6–8: **US$ 2,78**
- Margem para uma repetição por teste com problema: teto do dia **US$ 4,00**
  (garantido pelo servidor com `DAILY_BUDGET_USD`).

## Como avaliar cada imagem (aba Imagens → "Revisar e comparar")

- **Identidade:** comparar com a selfie original lado a lado, com zoom 2×/4×
  no rosto. Marcar "Rosto diferente da pessoa" se não for reconhecível como a
  mesma pessoa.
- **Quantidade e posição:** exatamente as pessoas da cena, nas posições
  pedidas; nenhuma pessoa extra.
- **Roupa e cenário:** comparar com a cena anterior do mesmo personagem
  ("Comparar com: Cena N").
- **Objetos e ação:** só o que está no trecho da copy; nada inventado.
- **Formato:** o selo deve dizer "9:16 nativo" e as dimensões 1152×2048.
  Conferir mãos, pés e objetos nas bordas.
- **Sem texto** na imagem.
- Aprovar ou rejeitar com os problemas marcados. Rejeitadas podem ser
  regeneradas sozinhas ("Regenerar só as rejeitadas"), cada uma com novo
  orçamento.

## Critérios para seguir adiante

- Teste 1: rosto reconhecível em pelo menos 1 de 2 tentativas.
- Testes 2–3: a mesma pessoa reconhecível em todos os ambientes/expressões.
- Teste 4: duas pessoas distintas, sem mistura de traços.
- Teste 5: mesma roupa e mesmo cenário nas duas cenas.
- Se algum falhar duas vezes: parar, anotar os problemas e ajustar instruções
  ou fotos antes de gastar mais.

## Registro

Exportar o ZIP ao final: o `manifest.json` guarda modelo, dimensões, hashes,
fotos usadas, versões, aprovações e problemas marcados de cada imagem.
