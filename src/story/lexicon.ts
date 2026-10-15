// Vocabulário usado pelo interpretador SIMULADO (regras locais, não é IA).
// Ele só reconhece o que está escrito — nada é inventado.

export const ENVIRONMENTS: Array<[RegExp, string]> = [
  [/\bcozinha\b/i, 'cozinha'],
  [/\bsala\b/i, 'sala'],
  [/\bquarto\b/i, 'quarto'],
  [/\bbanheiro\b/i, 'banheiro'],
  [/\bvaranda\b/i, 'varanda'],
  [/\bjardim\b/i, 'jardim'],
  [/\bquintal\b/i, 'quintal'],
  [/\bfarm[áa]cia\b/i, 'farmácia'],
  [/\bmercado\b|\bsupermercado\b/i, 'mercado'],
  [/\bpadaria\b/i, 'padaria'],
  [/\bescrit[óo]rio\b/i, 'escritório'],
  [/\bconsult[óo]rio\b/i, 'consultório'],
  [/\bacademia\b/i, 'academia'],
  [/\bparque\b/i, 'parque'],
  [/\bpraia\b/i, 'praia'],
  [/\brua\b|\bcal[çc]ada\b/i, 'rua'],
  [/\bcarro\b/i, 'carro'],
  [/\b[ôo]nibus\b/i, 'ônibus'],
  [/\bloja\b/i, 'loja'],
  [/\bigreja\b/i, 'igreja'],
  [/\bescola\b/i, 'escola'],
  [/\bhospital\b/i, 'hospital'],
]

export const TIME_SHIFTS: RegExp[] = [
  /\bno dia seguinte\b/i,
  /\bna manh[ãa] seguinte\b/i,
  /\b(?:uma|duas|tr[êe]s|quatro|algumas|\d+)\s+(?:semanas?|dias?|meses|m[êe]s|horas?|anos?)\s+depois\b/i,
  /\b(?:dias|semanas|meses|horas|anos|minutos)\s+depois\b/i,
  /\bmais tarde\b/i,
  /\b(?:de|pela)\s+manh[ãa]\b/i,
  /\b(?:à|a|de)\s+tarde\b/i,
  /\b(?:à|a|de)\s+noite\b/i,
  /\bat[ée] que\b/i,
]

export const EMOTIONS: Array<[RegExp, string]> = [
  [/\bsorri(?:u|ndo|a)?\b|\bsorriso\b/i, 'sorrindo'],
  [/\bri(?:u|ndo)?\b|\bgargalha/i, 'rindo'],
  [/\bchor(?:a|ou|ando)\b|\bl[áa]grimas?\b/i, 'chorando / emocionada'],
  [/\bfeliz(?:es)?\b|\balegr/i, 'feliz'],
  [/\btriste(?:s)?\b|\btristeza\b/i, 'triste'],
  [/\bpreocupad[oa]s?\b|\bpreocupa[çc][ãa]o\b/i, 'preocupada'],
  [/\bsurpres[oa]s?\b|\bespantad[oa]\b/i, 'surpresa'],
  [/\banimad[oa]s?\b|\bempolgad[oa]\b/i, 'animada'],
  [/\bcansad[oa]s?\b|\bexaust[oa]\b/i, 'cansada'],
  [/\birritad[oa]s?\b|\bbrav[oa]\b|\bnervos[oa]\b/i, 'irritada'],
  [/\baliviad[oa]s?\b|\bal[íi]vio\b/i, 'aliviada'],
  [/\bassustad[oa]s?\b|\bmedo\b/i, 'assustada'],
  [/\bdesconfiad[oa]s?\b/i, 'desconfiada'],
  [/\borgulhos[oa]s?\b/i, 'orgulhosa'],
  [/\bfrustrad[oa]s?\b|\bdesanimad[oa]\b/i, 'frustrada'],
]

export const OBJECTS: string[] = [
  'pote', 'gelatina', 'celular', 'telefone', 'xícara', 'chá', 'café', 'espelho', 'balança', 'remédio', 'remédios',
  'frasco', 'garrafa', 'copo', 'prato', 'caixa', 'carta', 'bolsa', 'chave', 'livro', 'computador', 'notebook',
  'receita', 'panela', 'colher', 'geladeira', 'mesa', 'sofá', 'cama', 'porta', 'janela', 'foto', 'fotografia',
  'presente', 'sacola', 'fita métrica', 'calça', 'vestido', 'cápsula', 'cápsulas', 'suplemento', 'shake', 'bolo',
]

export const CLOTHING = /\b(vestido|blusa|camisa|camiseta|cal[çc]a|saia|pijama|avental|jaqueta|casaco|terno|uniforme|roupa|moletom|bermuda|shorts|chap[ée]u|biqu[ií]ni|mai[ôo])\b((?:\s+(?:de|da|do|com|em)?\s*[a-zà-ÿ]+){0,3})/i

export const SPEECH_VERBS =
  'disse|diz|pergunta|perguntou|responde|respondeu|fala|falou|grita|gritou|exclama|exclamou|comenta|comentou|explica|explicou|conta|contou|sussurra|sussurrou|completa|completou|repete|repetiu'

export const NAME_STOPWORDS = new Set([
  'Ela', 'Ele', 'Elas', 'Eles', 'Eu', 'Nós', 'Você', 'Vocês', 'Mas', 'E', 'O', 'A', 'Os', 'As', 'Um', 'Uma', 'No', 'Na',
  'Nos', 'Nas', 'De', 'Do', 'Da', 'Em', 'Com', 'Quando', 'Depois', 'Então', 'Aí', 'Hoje', 'Ontem', 'Amanhã', 'Agora',
  'Isso', 'Esse', 'Essa', 'Este', 'Esta', 'Aquele', 'Aquela', 'Foi', 'Era', 'Já', 'Até', 'Sim', 'Não', 'Oi', 'Olá',
  'Pois', 'Porque', 'Por', 'Para', 'Pra', 'Que', 'Se', 'Sem', 'Mais', 'Muito', 'Todo', 'Toda', 'Todos', 'Todas',
  'Cena', 'Narrador', 'Narradora', 'Fim', 'Duas', 'Três', 'Dois', 'Semanas', 'Meses', 'Dias', 'Minha', 'Meu',
  'Seu', 'Sua', 'Dona', 'Nossa', 'Nosso', 'Deus', 'Gente', 'Olha', 'Veja', 'Obrigada', 'Obrigado', 'Tudo',
])

export const HONORIFIC_PREFIX = /\b(Dona|Seu|Sr\.|Sra\.|Srta\.|Dr\.|Dra\.|Tia|Tio|Vó|Vô|Vovó|Vovô|Dom|Professora?)\s+([A-ZÀ-Ý][a-zà-ÿ]+(?:\s+[A-ZÀ-Ý][a-zà-ÿ]+)?)/g
