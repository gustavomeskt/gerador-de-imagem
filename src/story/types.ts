// Tipos do storyboard de uma historinha.
//
// Regra principal: a COPY ORIGINAL NUNCA É ALTERADA. Cada cena aponta para o
// trecho exato da copy que a originou (posição + texto literal). Ajustes no
// storyboard mudam só as cenas.

export type SceneStatus = 'pending' | 'reviewed' | 'approved'

export const SCENE_STATUS_LABELS: Record<SceneStatus, string> = {
  pending: 'Pendente',
  reviewed: 'Revisada',
  approved: 'Aprovada',
}

// Como um personagem da copy foi ligado à biblioteca.
//   auto        — nome igual a um personagem cadastrado (correspondência confiável)
//   confirmed   — a pessoa confirmou a correspondência
//   manual      — escolhido manualmente na biblioteca
//   ambiguous   — há candidatos, mas precisa de confirmação
//   unregistered— ninguém na biblioteca corresponde: precisa ser cadastrado
export type MatchStatus = 'auto' | 'confirmed' | 'manual' | 'ambiguous' | 'unregistered'

export interface StoryCharacter {
  key: string // id estável dentro do storyboard
  name: string // como aparece na copy
  mentions: string[] // formas encontradas na copy ("Dona Maria", "Maria")
  libraryId: string | null // personagem da biblioteca (id estável)
  matchStatus: MatchStatus
  candidates: string[] // ids da biblioteca que podem corresponder (casos ambíguos)
}

export interface SourceSpan {
  start: number // posição na copy (inclusive)
  end: number // posição na copy (exclusive)
}

export interface StoryScene {
  id: string
  source: SourceSpan
  excerpt: string // copy.slice(start, end) — sempre literal
  part?: { index: number; total: number } // passagem dividida em várias imagens
  characterKeys: string[]
  speakerKey: string | null
  dialogue: string // fala (parte do trecho), quando houver
  environment: string
  action: string
  emotions: string
  wardrobe: string
  objects: string[]
  timeShift: string // passagem de tempo indicada na copy
  continuity: string // notas de continuidade (mesmo ambiente, mesma roupa…)
  framing: string // enquadramento
  camera: string // posição e ângulo da câmera
  visualDescription: string // composição (não acrescenta acontecimentos)
  motion: string // orientação de movimento para animação (só a ação descrita)
  flags: string[] // pontos que precisam de revisão humana
  status: SceneStatus
  prompt: string // último prompt calculado (salvo junto)
  promptOverride?: string // prompt editado manualmente
  origin: 'interpreted' | 'manual' | 'split' | 'merged'
  updatedAt: number
}

export interface StoryHistoryEntry {
  at: number
  action: string // texto curto do que aconteceu
}

export interface StorySnapshot {
  at: number
  reason: string
  copy: string
  characters: StoryCharacter[]
  scenes: StoryScene[]
}

export interface Storyboard {
  projectId: string
  copy: string // texto original, exatamente como foi salvo
  copySavedAt: number | null
  characters: StoryCharacter[]
  scenes: StoryScene[]
  interpretation: { mode: 'simulated' | 'openai'; model: string; at: number; warnings: string[] } | null
  approvedAt: number | null // storyboard completo aprovado
  history: StoryHistoryEntry[] // registro de revisões e aprovações
  snapshots: StorySnapshot[] // versões anteriores restauráveis
  createdAt: number
  updatedAt: number
}

// --- saída "crua" do interpretador (IA ou simulado), antes da validação ---

export interface RawScene {
  quote: string // trecho LITERAL da copy
  characters: string[] // nomes, como na lista de personagens
  speaker: string | null
  dialogue: string | null
  environment: string
  action: string
  emotions: string
  wardrobe: string
  objects: string[]
  timeShift: string
  continuity: string
  framing: string
  camera: string
  visualDescription: string
  motion: string
  ambiguities: string[]
}

export interface RawInterpretation {
  characters: Array<{ name: string; mentions: string[] }>
  scenes: RawScene[]
}
