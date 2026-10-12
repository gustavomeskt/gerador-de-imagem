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

> Importante: rode sempre via `npm run dev`. O `vite.config.ts` tem um proxy
> (`/openai-api` → `api.openai.com`) que evita bloqueio de CORS no navegador.
> Isso só funciona com o servidor de dev rodando — não existe num build
> estático (`npm run build` + arquivos soltos).

## Telas

**Tela inicial** (abre ao carregar o app) — menu lateral com duas abas:
- **Fluxos**: lista os fluxos salvos como cards. Clique num card pra abrir,
  no ícone de lixeira pra apagar, ou em **+ Novo fluxo** pra criar um e já
  entrar nele.
- **Configuração**: cole sua API key da OpenAI (`sk-...`). Fica salva só no
  `localStorage` do navegador.

**Tela do fluxo** — canvas do React Flow com:
- Botão de voltar (seta) + nome do fluxo no canto superior esquerdo. Clique
  no nome pra renomear.
- Dock flutuante à esquerda com os botões **Prompt** e **Imagem** pra criar nós.

## Uso

1. Na tela inicial, aba **Configuração**, cole sua API key e salve.
2. Volte pra aba **Fluxos** e crie (ou abra) um fluxo.
3. No dock lateral, clique **Prompt** pra criar um nó de texto e escreva a
   descrição da imagem.
4. Clique **Imagem**, escolha modelo / proporção / qualidade / quantidade.
5. Arraste uma conexão da bolinha direita do nó de Prompt até a bolinha
   esquerda do nó de Imagem.
6. Clique em **Gerar**. As imagens aparecem lado a lado dentro do nó.
7. Passe o mouse sobre uma imagem para ver os ícones: **gerar de novo**
   (regenera só aquela imagem), **baixar** e **remover**.
8. Pra trocar o prompt de um nó de Imagem, selecione a conexão (linha) e
   aperte Delete/Backspace, depois puxe uma nova de outro nó de Prompt.

Modelo, proporção, qualidade e quantidade do último nó de Imagem configurado
ficam salvos como padrão para o próximo nó de Imagem que você criar. Cada
fluxo salva sozinho (posições, prompts, configuração e conexões) enquanto
você edita — sem botão de salvar.

## Observações

- **Imagens geradas não são salvas no fluxo** — só a estrutura (nós, prompts,
  config, conexões). Isso evita estourar o limite do `localStorage`. Ao reabrir
  um fluxo as imagens precisam ser geradas de novo.
- A API key fica em texto no `localStorage` e é usada direto do navegador
  (via proxy local, sem passar por nenhum backend seu). Isso é prático para uso
  pessoal, mas não é recomendado pra uma versão que outras pessoas vão acessar —
  nesse caso a key deveria ficar só no servidor.
