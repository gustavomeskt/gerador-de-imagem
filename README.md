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
| `POST /api/story/quote` | orçamento da interpretação de uma historinha |
| `POST /api/story/interpret` | interpreta a copy (modelo de linguagem ou simulado) — exige `X-Cost-Quote` |

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

## Biblioteca de personagens

Aba **Personagens** na tela inicial: cadastre cada pessoa **uma vez** e use
em quantas historinhas quiser. A biblioteca é independente dos projetos — os
projetos guardam só o **identificador** do personagem, e as fotos ficam
guardadas uma única vez.

**Ficha de cada personagem:** identificador único, nome, fotografia
principal do rosto (estrela), fotos adicionais (até 6 no total), descrição
física permanente, idade aparente, características do rosto, cabelo,
características marcantes, roupa padrão (opcional), instruções de preservação
visual, datas de criação/atualização e versão (sobe a cada edição).

Ações: **criar**, **ver/editar**, **duplicar** (nova ficha usando os mesmos
arquivos de foto) e **excluir**.

**Usar numa cena:** no nó de Imagem, em *Personagens da biblioteca*, escolha
um ou mais personagens. Em cada um há o campo **"Nesta cena"** para ajustes
só daquela cena (ex.: "de pijama, rindo") — a ficha permanente não muda.
As fotos cadastradas vão **de verdade** para o modelo (mesma integração de
referências da Etapa 3), nunca trocadas por descrição em texto.

- Ordem das fotos: a **principal de cada personagem** primeiro, depois as
  fotos dos nós de referência, depois as fotos extras dos personagens em
  rodízio até o limite de 6 por geração. Fotos que não couberem aparecem
  listadas na pré-visualização.
- Cenas com várias pessoas recebem a regra de não misturar identidades e de
  mostrar cada pessoa uma vez.

**Exclusão segura:** antes de excluir, o app mostra em quais projetos (e
quantos nós) o personagem é usado. Depois de excluído, esses nós mostram
"Personagem excluído da biblioteca" e **não geram** até você trocá-lo ou
restaurar o backup — nada quebra em silêncio. Imagens já geradas não são
apagadas, e cada uma guarda a ficha do personagem **como estava** na geração
(editar depois não altera esse histórico).

**Backup da biblioteca** (botões na aba Personagens): **Exportar backup**
gera um ZIP com as fichas, os metadados e as **fotos originais**
(`backup.json` + `fotos/`). **Importar backup** valida tudo antes de gravar —
formato, campos, tipo real e tamanho de cada foto e o hash SHA-256 de cada
arquivo; caminhos suspeitos e fotos adulteradas são recusados. Um personagem
com problema não impede os outros. Se o personagem já existe, fica a versão
mais recente (o backup mais antigo é ignorado). Restaurar um personagem
excluído (mesmo identificador) faz os projetos que o usavam voltarem a
funcionar.

> **A preservação do rosto depende do modelo.** O app envia as fotos e as
> instruções da ficha; quão fiel o resultado fica (rosto, idade, cabelo,
> roupa, várias pessoas na mesma cena) só pode ser avaliado com chamadas
> reais à OpenAI.

## Guia de estilo do projeto

Ícone de paleta ao lado do nome do fluxo. Cada projeto tem o seu guia:
estilo visual padrão, fotografia realista e natural, iluminação, qualidade
visual pretendida, proporção preferida, características permanentes dos
ambientes e regras de continuidade de roupas e objetos.

- **Padrão dos projetos novos:** fotorrealista, vertical **9:16**, sem
  textos, legendas, logos ou marcas-d'água. Nós de imagem novos já nascem na
  proporção preferida.
- Projetos criados antes desta versão recebem o guia **desligado**, para
  continuarem gerando como antes (dá para ligar no mesmo diálogo).
- O guia só diz **como** a imagem deve parecer: as instruções pedem para
  mostrar apenas o que a cena descreve, sem inventar acontecimentos.

## Ver as instruções antes de gerar

Botão **Ver instruções** no nó de Imagem: mostra os personagens (com as fotos
que vão ser enviadas e a ficha), as referências avulsas, o guia de estilo e o
**texto final** enviado ao modelo — exatamente a mesma montagem usada na
geração. Ordem do texto: o que é cada imagem anexada → regra de separação de
pessoas → guia de estilo → a cena, exatamente como foi escrita.

## Historinha: copy → storyboard

Botão **Historinha** (ícone de livro) ao lado do nome do fluxo. Cada projeto
tem uma historinha, com três abas:

1. **Copy** — cole o texto completo e clique em **Salvar copy**. O texto é
   guardado exatamente como foi colado; nenhuma função do app o altera.
   **Interpretar historinha** transforma a copy em cenas.
2. **Personagens** — quem foi identificado na copy, com o status da ligação
   com a biblioteca (veja abaixo). Dá para escolher o personagem da
   biblioteca, confirmar, cadastrar ali mesmo (o nome já vem preenchido) ou
   adicionar manualmente alguém da biblioteca.
3. **Storyboard** — cards numerados (leves, para 50+ cenas) e um painel de
   edição da cena selecionada: trecho exato da copy (não editável),
   personagens, quem fala, fala, ação, ambiente, emoções, figurino, objetos,
   passagem de tempo, continuidade, enquadramento, câmera, descrição visual,
   movimento para o Google Flow e o **prompt final** (automático, ou editado
   à mão). Ações: aprovar, marcar como revisada, dividir, unir com a próxima,
   mover, filtrar (pendentes, revisadas, aprovadas, com alerta), **aprovar o
   storyboard completo**, versões anteriores e histórico de revisões.

**Fidelidade à copy (regras aplicadas pelo app, não só pedidas ao modelo):**

- Toda cena aponta para um trecho **literal** da copy (posição + texto). Cena
  cujo trecho não existe na copy é descartada, com aviso — é assim que um
  acontecimento inventado é barrado.
- Uma passagem pode virar várias imagens (mesmo trecho, "imagem 1 de 2").
- Personagem não citado no trecho, fala que não está no trecho, objeto ou
  ambiente que não aparece na copy, pronome ("ela") e grupo ("a família")
  viram **alertas para revisão humana** — nunca um acontecimento novo. Objeto
  fora da copy fica só como detalhe visual de composição.
- Trechos da copy sem nenhuma cena aparecem como aviso no storyboard.
- Não há limite artificial de cenas (testado com 16, 30, 36 e 60).

**Ligação com a biblioteca de personagens (conservadora):**

- Automática só com o **mesmo nome** (ignorando acentos e tratamentos como
  "Dona", "Seu"): "Dona Maria" ↔ "Maria".
- Só o primeiro nome ("Seu João" ↔ "João Pedro") ou dois cadastrados com o
  mesmo nome → **ambíguo**, pede confirmação.
- Nomes parecidos ("Mariana" × "Maria") **nunca** são ligados.
- Sem correspondência → **não cadastrado**, com botão para cadastrar. Cena
  com personagem sem cadastro avisa que ele vai sem foto.
- A ligação usa o id estável do personagem; o que a pessoa confirma não é
  desfeito por uma nova interpretação.

**Revisão e segurança das alterações:**

- Editar uma cena a marca como **revisada**; editar uma cena aprovada a
  devolve para revisão. O storyboard completo aprovado perde a aprovação
  geral se algo mudar depois.
- **Reinterpretar** mantém as cenas **aprovadas** como estão; as outras são
  substituídas e a versão anterior inteira fica em "Versões anteriores"
  (restaurável).
- Interpretação que falha, é cancelada, devolve algo inválido ou termina
  depois de a copy ter sido alterada **não mexe no storyboard**.
- Alterar e salvar a copy reencontra cada cena no texto novo; a cena cujo
  trecho sumiu fica sinalizada (nada é apagado).

**Prompt automático de cada cena:** usa o mesmo compositor do nó de Imagem —
ficha permanente e fotos dos personagens ligados, ação/ambiente/emoções/
figurino/objetos/continuidade/enquadramento da cena, o guia de estilo do
projeto (ou o padrão fotorrealista) e sempre **vertical 9:16, sem texto na
imagem**. O trecho da copy vai junto só como referência de fidelidade, com a
instrução de não escrevê-lo na imagem.

**Quem interpreta:**

- Provedor **Simulado** (padrão) → **interpretação SIMULADA**, por regras
  locais no navegador, sem IA e sem custo. Ela separa falas ("Nome: fala",
  travessão + "disse Fulano") e frases de narração; reconhece nomes com
  tratamento, falantes e nomes repetidos; ambiente por palavras de lugar
  ("na cozinha" — "para a escola" é destino, não cenário) com continuidade;
  passagem de tempo ("mais tarde", "à noite", "no dia seguinte"); roupas e
  objetos citados; emoções com a palavra da copy; e divide "X, e depois Y" em
  duas imagens. Serve para testar o fluxo — **revise todas as cenas**.
- Provedor **Backend** → `POST /api/story/*`. Com o servidor em modo
  simulado, usa as mesmas regras (sem custo). Em modo `openai`, usa um modelo
  de linguagem (`STORY_MODEL`, padrão `gpt-5-mini`) com saída estruturada
  (esquema JSON estrito) e instruções de fidelidade; antes, mostra o custo
  estimado e só segue com confirmação. A copy é dividida em partes por
  parágrafo (`STORY_CHUNK_CHARS`), uma chamada por parte; o servidor confere
  que cada trecho citado existe na parte e o navegador valida tudo de novo
  contra a copy inteira. A copy não vai para os logs.

Tudo (copy, cenas, ligações com a biblioteca, prompts, aprovações, versões
anteriores e histórico) fica salvo no IndexedDB (tabela `storyboards`, um por
projeto) e volta depois de recarregar. Apagar o projeto apaga a historinha.

Limitações desta etapa: a interpretação real (modelo de linguagem) ainda não
foi testada com a API de verdade — só com respostas simuladas; a geração em
lote das cenas fica para a próxima etapa; o ZIP do projeto ainda não inclui
o storyboard.

## Armazenamento e exportação

Projetos (fluxos) e imagens geradas são salvos **automaticamente** no
navegador, no IndexedDB (`src/persistence/`):

- Cada imagem é gravada assim que fica pronta — não depende de download.
- Ao atualizar a página ou fechar e reabrir o app, os fluxos e as imagens
  voltam como estavam.
- Gerar de novo só apaga a imagem antiga **depois** que a nova foi salva; se a
  geração falhar, as imagens anteriores são mantidas.
- Apagar uma imagem, um nó ou um fluxo apaga os arquivos correspondentes.
- A biblioteca de personagens usa a tabela `characters`; as fotos dela ficam
  na tabela de arquivos como parte da biblioteca (não de um projeto). A
  historinha (copy + storyboard) usa a tabela `storyboards`. Tabelas
  reservadas para as próximas etapas: cenas, prompts e versões de imagem.
- Fluxos da versão anterior (que ficavam no `localStorage`) são copiados para
  o banco na primeira abertura. A cópia antiga **não é apagada**.

**Exportar ZIP** (ícone de arquivo ao lado do nome do fluxo, ou no card do
fluxo na tela inicial): baixa todas as imagens prontas do fluxo, em ordem, com
nomes padronizados, mais um `manifest.json`:

```
campanha-gelatina_2026-10-15_14-52.zip
├── manifest.json
├── imagens/
│   ├── 001_grupo-01_imagem-01.png
│   └── 002_grupo-02_imagem-01.png
├── referencias/          ← fotos originais dos nós de referência
│   └── 01_pote-verde/01_pote.webp
└── personagens/          ← fotos dos personagens usados no projeto
    └── dona-maria_a1b2c3/01_maria-frente.png
```

Grupo = nó de imagem, na ordem do canvas (de cima para baixo, depois da
esquerda para a direita). O manifest traz, para cada arquivo, o prompt, o
modelo, o tamanho, as dimensões, o provedor e o hash SHA-256 (para conferir a
integridade). Ele também lista os nós de referência, os personagens usados
(com a ficha atual, ou marcados como excluídos da biblioteca) e o guia de
estilo do projeto; cada imagem registra quais fotos e qual versão da ficha
foram usadas.

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
- O ZIP do projeto ainda não pode ser importado de volta para o app (o
  backup da biblioteca de personagens pode).

## Telas

**Tela inicial** (abre ao carregar o app) — menu lateral com três abas:
- **Fluxos**: lista os fluxos salvos como cards. Clique num card pra abrir,
  no ícone de arquivo pra exportar o ZIP, no ícone de lixeira pra apagar, ou
  em **+ Novo fluxo** pra criar um e já entrar nele.
- **Personagens**: biblioteca de personagens, com backup (exportar/importar).
- **Configuração**: escolha o provedor de geração (simulado ou backend
  seguro). Se uma API key de versão anterior ainda estiver salva no
  navegador, aparece um botão pra apagá-la.

**Tela do fluxo** — canvas do React Flow com:
- Botão de voltar (seta) + nome do fluxo no canto superior esquerdo. Clique
  no nome pra renomear. Ao lado, os botões de exportar o fluxo em ZIP, do
  guia de estilo e da **Historinha** (copy, interpretação e storyboard).
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
