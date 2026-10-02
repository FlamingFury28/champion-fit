import { CircleCheckBig, Trophy, type LucideIcon } from 'lucide-react'

export type DecisionId = 'best' | 'tournament'
export type DecisionTone = 'positive' | 'info' | 'warning' | 'negative'

export interface PrimaryDecision {
  id: DecisionId
  question: string
  navLabel: string
  destination: string
  route: string
  answerRoute: string
  cta: string
  copy: string
  icon: LucideIcon
  tone: DecisionTone
}

export const primaryDecisions: PrimaryDecision[] = [
  {
    id: 'best',
    question: 'Quali giochi meglio?',
    navLabel: 'Quali giochi meglio?',
    destination: 'Confronta il rendimento',
    route: '/app/fit?section=best',
    answerRoute: '/app/fit?section=best',
    cta: 'Apri il confronto',
    copy: 'Confronta i risultati osservati per campione, ruolo, modalità e periodo.',
    icon: CircleCheckBig,
    tone: 'positive',
  },
  {
    id: 'tournament',
    question: 'Piano da 400 partite',
    navLabel: 'Piano da 400 partite',
    destination: 'Distribuisci le partite',
    route: '/app/fit?section=tournament',
    answerRoute: '/app/fit?section=tournament',
    cta: 'Apri il piano',
    copy: 'Distribuisci un budget di partite tra i candidati per ridurre l’incertezza della scelta.',
    icon: Trophy,
    tone: 'info',
  },
]
