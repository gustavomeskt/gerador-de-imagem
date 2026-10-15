# Gerador de Imagens — Flow

App com tela inicial de fluxos salvos + canvas em React Flow pra gerar imagens
com a API da OpenAI: um nó de **Prompt** que você arrasta, conecta num nó de
**Imagem** (modelo, proporção, qualidade e quantidade) e ele gera N imagens
lado a lado.

## Como rodar

```bash
npm install
npm run dev
```

Abra `http://localhost:5173` (ou a porta que o Vite mostrar).

Por padrão o app usa o **provedor simulado**: gera imagens de teste
localmente, sem rede e sem custo. Pra testar o caminho de erro, inclua
`[simular-erro]` no prompt.

### Testes e verificação

```bash
npm test          # testes automatizados (Vitest)
npm run lint      # oxlint
npm run build     # typecheck + build de produção
npm run check     # os três acima, em sequência
```

## Arquitetura de geração

O app nunca fala direto com a OpenAI e **nenhuma chave de API fica no
navegador**. A interface conversa só com um *provedor* (`src/generation/`):

- `models.ts` — catálogo de modelos, tamanhos, qualidades e limites.
- `types.ts` — contrato `ImageProvider` que todo provedor implementa.
- `mockProvider.ts` — provedor simulado (grátis, local).
- `backendProvider.ts` — provedor real: chama `/api/*` do backend seguro, que
  guarda a chave no servidor. O `vite.config.ts` repassa `/api` para
  `http://localhost:8787` (ou `API_PROXY_TARGET`). **O backend ainda não foi
  implementado** — até lá, use o provedor simulado.
- `openaiRequest.ts` — regras de montagem dos pedidos à OpenAI, pra uso do
  backend (lógica pura, sem chamadas nem chave).
- `service.ts` — orquestra uma geração: divide em chamadas pelo limite do
  modelo, recorta 9:16/16:9 e devolve um resultado por imagem (uma falha não
  derruba as outras).

## Armazenamento e exportação

Projetos (fluxos) e imagens geradas são salvos **automaticamente** no
navegador, no IndexedDB (`src/persistence/`):

- Cada imagem é gravada assim que fica pronta — não depende de download.
- Ao atualizar a página ou fechar e reabrir o app, os fluxos e as imagens
  voltam como estavam.
- Gerar de novo só apaga a imagem antiga **depois** que a nova foi salva; se a
  geração falhar, as imagens anteriores são mantidas.
- Apagar uma imagem, um nó ou um fluxo apaga os arquivos correspondentes.
- O banco já tem as tabelas reservadas para as próximas etapas: personagens,
  storyboards, cenas, prompts e versões de imagem.
- Fluxos da versão anterior (que ficavam no `localStorage`) são copiados para
  o banco na primeira abertura. A cópia antiga **não é apagada**.

**Exportar ZIP** (ícone de arquivo ao lado do nome do fluxo, ou no card do
fluxo na tela inicial): baixa todas as imagens prontas do fluxo, em ordem, com
nomes padronizados, mais um `manifest.json`:

```
campanha-gelatina_2026-10-15_14-52.zip
├── manifest.json
└── imagens/
    ├── 001_grupo-01_imagem-01.png
    ├── 002_grupo-01_imagem-02.png
    └── 003_grupo-02_imagem-01.png
```

Grupo = nó de imagem, na ordem do canvas (de cima para baixo, depois da
esquerda para a direita). O manifest traz, para cada arquivo, o prompt, o
modelo, o tamanho, as dimensões, o provedor e o hash SHA-256 (para conferir a
integridade).

### Limitações — isto não é backup

- Os dados ficam **só neste navegador, neste computador**. Somem se você
  limpar os dados do site, trocar de navegador ou de computador, ou se o
  navegador precisar de espaço. Exporte o ZIP para guardar uma cópia.
- Em "Configuração" dá para ver o espaço usado e pedir armazenamento
  persistente (o navegador decide se concede).
- Falta de espaço ou falha de gravação mostram um aviso no topo da tela; uma
  imagem que não pôde ser salva fica marcada como "não salva" e só existe até
  fechar o app (ainda dá para baixá-la ou exportá-la).
- Se o IndexedDB estiver indisponível (modo privado/bloqueio), o app funciona
  sem salvar nada e avisa.
- Não edite o mesmo fluxo em duas abas ao mesmo tempo: a última gravação
  prevalece.
- O ZIP ainda não pode ser importado de volta para o app.

## Telas

**Tela inicial** (abre ao carregar o app) — menu lateral com duas abas:
- **Fluxos**: lista os fluxos salvos como cards. Clique num card pra abrir,
  no ícone de arquivo pra exportar o ZIP, no ícone de lixeira pra apagar, ou
  em **+ Novo fluxo** pra criar um e já entrar nele.
- **Configuração**: escolha o provedor de geração (simulado ou backend
  seguro). Se uma API key de versão anterior ainda estiver salva no
  navegador, aparece um botão pra apagá-la.

**Tela do fluxo** — canvas do React Flow com:
- Botão de voltar (seta) + nome do fluxo no canto superior esquerdo. Clique
  no nome pra renomear. Ao lado, o botão de exportar o fluxo em ZIP.
- Dock flutuante à esquerda com os botões **Prompt** e **Imagem** pra criar nós.

## Uso

1. Na tela inicial, aba **Configuração**, confira o provedor (simulado por
   padrão).
2. Volte pra aba **Fluxos** e crie (ou abra) um fluxo.
3. No dock lateral, clique **Prompt** pra criar um nó de texto e escreva a
   descrição da imagem.
4. Clique **Imagem**, escolha modelo / proporção / qualidade / quantidade.
5. Arraste uma conexão da bolinha direita do nó de Prompt até a bolinha
   esquerda do nó de Imagem.
6. Clique em **Gerar**. As imagens aparecem lado a lado dentro do nó.
7. Passe o mouse sobre uma imagem para ver os ícones: **gerar de novo**
   (regenera só aquela imagem — se falhar, a anterior é mantida), **baixar**
   e **remover**.
8. Pra trocar o prompt de um nó de Imagem, selecione a conexão (linha) e
   aperte Delete/Backspace, depois puxe uma nova de outro nó de Prompt.

Modelo, proporção, qualidade e quantidade do último nó de Imagem configurado
ficam salvos como padrão para o próximo nó de Imagem que você criar. Cada
fluxo salva sozinho (posições, prompts, configuração, conexões e imagens)
enquanto você edita — sem botão de salvar.

## Observações

- Imagens e fluxos ficam salvos no navegador (veja "Armazenamento e
  exportação" acima, incluindo as limitações).
- A chave da OpenAI fica só no backend (variável de ambiente do servidor),
  nunca no navegador nem no `localStorage`.
