# Gerador de Imagens — Flow

App com tela inicial de fluxos salvos + canvas em React Flow pra gerar imagens
com a API da OpenAI: um nó de **Prompt** que você arrasta, conecta num nó de
**Imagem** (modelo, proporção, qualidade e quantidade) e ele gera N imagens
lado a lado.

## Como rodar (resumo)

```bash
npm install
npm run dev:full     # frontend (Vite, porta 5173) + backend local (porta 8787)
```

Abra `http://localhost:5173`. Só o frontend: `npm run dev`. Só o backend:
`npm run server`.

Por padrão tudo é **gratuito**: o app usa o provedor simulado do navegador, e
o backend começa em modo simulado (não chama a OpenAI). Pra testar o caminho
de erro do provedor do navegador, inclua `[simular-erro]` no prompt.

### Testes e verificação

```bash
npm test          # testes automatizados (Vitest) — frontend e backend
npm run lint      # oxlint
npm run build     # typecheck (frontend + servidor) + build de produção
npm run check     # os três acima, em sequência
```

## Passo a passo no Windows

1. **Instale o Node.js 22 LTS** (ou mais novo) em <https://nodejs.org> —
   pode deixar as opções padrão do instalador. Depois, abra o **PowerShell**
   e confira:

   ```powershell
   node -v    # deve mostrar v22.x ou maior
   npm -v
   ```

2. **Baixe o projeto** (com Git instalado — <https://git-scm.com>) e entre na
   pasta:

   ```powershell
   git clone https://github.com/gustavomeskt/gerador-de-imagem.git
   cd gerador-de-imagem
   git checkout claude/determined-darwin-bmslxf
   ```

3. **Instale as dependências** (uma vez só):

   ```powershell
   npm install
   ```

4. **Crie o arquivo de configuração do servidor** a partir do exemplo:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

   Pra testar sem gastar nada, deixe `IMAGE_BACKEND_MODE=simulated` e
   `OPENAI_API_KEY=` vazio. O `.env` nunca vai para o repositório.

5. **Inicie frontend e backend juntos:**

   ```powershell
   npm run dev:full
   ```

   Aparecem as linhas `[web]` (Vite) e `[api]` (servidor). O servidor informa
   o modo (SIMULADO ou OPENAI) e os limites. Se o Windows Firewall perguntar,
   pode **negar** o acesso à rede: o servidor só atende o próprio computador.

6. **Abra** `http://localhost:5173` no navegador. Em **Configuração**, escolha
   o provedor:
   - **Simulado (grátis, sem API)** — tudo no navegador;
   - **OpenAI via backend local (seguro)** — passa pelo servidor. O painel
     "Servidor local" mostra o modo, se há chave configurada (sim/não), o
     consumo do dia e os limites.

7. **Para parar:** `Ctrl + C` no PowerShell (confirme com `S` se perguntar).

### Ativar chamadas reais (pagas) — só quando quiser

1. Crie uma chave em <https://platform.openai.com/api-keys> e defina um
   limite de gastos na sua conta da OpenAI (Billing → Limits).
2. No `.env`: `IMAGE_BACKEND_MODE=openai` e `OPENAI_API_KEY=sk-...` (sem
   aspas). Revise `MAX_COST_PER_JOB_USD`, `DAILY_BUDGET_USD` e
   `DAILY_IMAGE_LIMIT`.
3. Reinicie (`Ctrl + C` e `npm run dev:full`). O servidor deve dizer
   `Modo: OPENAI`.
4. Toda geração (e todo "Melhorar prompt") abre uma janela com o **custo
   estimado**; nada é enviado à OpenAI antes de você clicar em confirmar.

### Problemas comuns no Windows

- **"A porta 8787 já está em uso"** — feche o outro terminal com o servidor
  ou mude `PORT` no `.env` (e rode o Vite com
  `$env:API_PROXY_TARGET="http://127.0.0.1:NOVA_PORTA"; npm run dev`).
- **"Backend local indisponível" no app** — o servidor não está rodando; use
  `npm run dev:full` (e não só `npm run dev`).
- **"Configuração inválida: ..."** ao iniciar — a mensagem diz qual variável
  do `.env` corrigir.
- **`npm` não é reconhecido** — reabra o PowerShell depois de instalar o
  Node.js.
- **Scripts bloqueados no PowerShell** ("execução de scripts foi
  desabilitada") — rode uma vez
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, ou use o Prompt de
  Comando (`cmd`).

## Backend local (pasta `server/`)

Servidor Node.js (sem framework, só `node:http`) que é a **única** parte do
sistema que conhece a chave da OpenAI. Ele lê a chave do `.env` (variável de
ambiente) e nunca a devolve em respostas, erros ou logs.

Rotas (todas em `/api`, repassadas pelo Vite em desenvolvimento):

| Rota | O que faz |
|---|---|
| `GET /api/health` | servidor no ar |
| `GET /api/status` | modo, se há chave (sim/não), limites, consumo do dia |
| `POST /api/images/quote` | orçamento de uma geração (todas as imagens de um nó) |
| `POST /api/images/generate` | gera imagens — exige o cabeçalho `X-Cost-Quote`; com `references` usa o endpoint de edição da OpenAI com as fotos |
| `POST /api/prompts/quote` | orçamento do "Melhorar prompt" |
| `POST /api/prompts/enhance` | melhora o prompt — exige `X-Cost-Quote` |

Proteções:

- **Só o próprio computador:** recusa iniciar fora de `127.0.0.1`/`::1`/
  `localhost`; recusa requisições com `Host` de outro domínio (DNS
  rebinding), com `Origin` fora de `ALLOWED_ORIGINS` ou marcadas como
  cross-site; exige `application/json` e não responde CORS — outros sites
  abertos no navegador não conseguem disparar gerações.
- **Validação estrita:** lista de modelos permitidos (`ALLOWED_MODELS`),
  tamanhos/qualidades/quantidade válidos por modelo, limite de tamanho do
  prompt por modelo, campos desconhecidos recusados — nada arbitrário chega à
  OpenAI. Fotos de referência são conferidas pelos bytes (assinatura do
  arquivo, tamanho, dimensões, tipo declarado = tipo real); URLs não são
  aceitas — o servidor nunca baixa nada de fora. Campos das próximas etapas
  (`characters`, `scenes`...) são recusados com mensagem clara.
- **Confirmação de custo obrigatória:** o servidor só faz uma chamada paga
  com um orçamento (`quoteId`) que a pessoa confirmou na tela, que bate
  exatamente com o pedido, não venceu e não foi usado além do confirmado.
- **Controle de consumo:** custo máximo por geração, orçamento diário em US$,
  limite diário de imagens (salvos em `server/.data/usage.json`, valem mesmo
  depois de reiniciar), limite de chamadas por minuto, limite de chamadas
  simultâneas com fila curta, timeout das chamadas à OpenAI e limite de
  tamanho das requisições.
- **Erros tratados:** chave recusada, pedido recusado, limite da OpenAI,
  timeout e falha de rede viram mensagens claras; mensagens vindas da OpenAI
  passam por uma limpeza que remove qualquer trecho de chave.

A estimativa de custo usa uma tabela de preços de referência
(`server/pricing.ts`) — a cobrança real é a da fatura da OpenAI. Os preços
podem ser corrigidos sem mexer no código com `PRICE_TABLE_FILE`. Todas as
variáveis estão explicadas no `.env.example`.

## Arquitetura de geração

O app nunca fala direto com a OpenAI e **nenhuma chave de API fica no
navegador**. A interface conversa só com um *provedor* (`src/generation/`):

- `models.ts` — catálogo de modelos, tamanhos, qualidades e limites.
- `types.ts` — contrato `ImageProvider` que todo provedor implementa.
- `mockProvider.ts` — provedor simulado (grátis, local).
- `backendProvider.ts` — provedor real: pede orçamento, e só depois da
  confirmação chama `/api/*` do backend local, que guarda a chave no
  servidor. O `vite.config.ts` repassa `/api` para `http://127.0.0.1:8787`
  (ou `API_PROXY_TARGET`).
- `openaiRequest.ts` — regras de montagem dos pedidos à OpenAI, usadas pelo
  backend (lógica pura, sem chamadas nem chave): JSON para geração e
  multipart (`image[]`) para edição com referências.
- `references.ts` — imagens de referência: modelos compatíveis, limites,
  validação dos arquivos pelos bytes e o texto que diz ao modelo qual foto é
  de quem.
- `service.ts` — orquestra uma geração: divide em chamadas pelo limite do
  modelo, recorta 9:16/16:9 e devolve um resultado por imagem (uma falha não
  derruba as outras).

## Imagens de referência

Fotos reais enviadas por você que vão **junto** com o pedido ao modelo — a
base para manter a identidade dos personagens. As fotos nunca são trocadas
por descrições em texto: elas são enviadas de verdade (endpoint
`/v1/images/edits` da OpenAI, via backend).

**Como usar**

1. No dock, clique no ícone de pessoa (**Novo nó de referência**).
2. Dê um nome ("Dona Maria"), escolha o tipo — *Personagem*, *Roupa*,
   *Cenário ou objeto* ou *Estilo* — e, para personagens, marque **Manter a
   roupa da foto** se quiser a mesma roupa.
3. **Adicionar fotos**: uma ou várias (PNG, JPG ou WebP, até 8 MB cada, até
   6 por nó). Passe o mouse numa foto para **substituir** ou **remover**.
   Arquivos inválidos são recusados com aviso.
4. Ligue a bolinha verde do nó de Referência na **bolinha verde** do nó de
   Imagem (a de baixo; a de cima é o prompt). Pode ligar várias referências
   no mesmo nó de Imagem — cada uma vale só para os nós onde está ligada.
5. No nó de Imagem aparece quantas fotos vão junto e o seletor de
   **Fidelidade** (alta preserva melhor rosto e traços, e custa mais).
6. **Gerar** — o orçamento já inclui o custo das fotos; confirme.

**Modelos e recursos** (conferido no SDK oficial da OpenAI, out/2026):

| Modelo | Aceita referências | Fidelidade (`input_fidelity`) |
|---|---|---|
| GPT Image 1.5 | sim (API: até 16; app: até 6) | alta ou baixa |
| GPT Image 1 | sim (API: até 16; app: até 6) | alta ou baixa |
| GPT Image 1 Mini | sim (API: até 16; app: até 6) | só baixa (o app não envia o parâmetro) |
| DALL-E 3 / DALL-E 2 | não — o app avisa e não gera | — |

Sem referências ligadas, a geração continua exatamente como antes.

**O que o app faz para a consistência**

- Envia as fotos dos **personagens primeiro** (com fidelidade alta os
  modelos dão mais peso às primeiras imagens), depois roupa, objetos e
  estilo.
- Junta às fotos um texto curto dizendo **qual imagem é de quem** ("Imagens
  1-2: Dona Maria — mesma pessoa: mesmo rosto, idade aparente, cabelo,
  traços; expressão, pose e ângulo podem mudar"), pedindo para não misturar
  pessoas diferentes e para não colocar textos nem marcas-d'água.
- A imagem gerada guarda quais referências foram usadas (vai também para o
  `manifest.json` do ZIP).

> **A fidelidade facial não está garantida.** Toda a infraestrutura foi
> testada com imagens fictícias e respostas simuladas; a qualidade real da
> preservação do rosto, idade e roupas só pode ser avaliada com chamadas
> reais à OpenAI.

**Armazenamento:** as fotos ficam no IndexedDB, ligadas ao projeto, e voltam
ao reabrir o app. A mesma foto usada em vários nós é guardada **uma vez só**
(pelo hash do conteúdo) e só é apagada quando nenhum nó a usa mais.

**Limites do servidor** (`.env`): `MAX_REFERENCE_IMAGES` (padrão 6, máx. 16)
e `MAX_REFERENCE_FILE_MB` (padrão 8, máx. 50). O limite de tamanho da
requisição com fotos é calculado a partir deles (ou `MAX_EDIT_BODY_BYTES`).

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
- Dock flutuante à esquerda com os botões **Prompt**, **Imagem** e
  **Referência** pra criar nós.

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
