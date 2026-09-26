import { Ban, CircleCheckBig, CircleOff, FlaskConical, type LucideIcon } from 'lucide-react'

export type DecisionId = 'play' | 'train' | 'ban' | 'stop'
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
    id: 'play',
    question: 'Chi mi conviene giocare?',
    navLabel: 'Chi mi conviene giocare?',
    destination: 'Scegli il campione',
    route: '/app/fit',
    answerRoute: '/app/fit',
    cta: 'Vedi chi giocare',
    copy: 'I campioni sostenuti dal tuo profilo e dai dati disponibili.',
    icon: CircleCheckBig,
    tone: 'positive',
  },
  {
    id: 'train',
    question: 'Chi dovrei allenare per capire se fa per me?',
    navLabel: 'Chi dovrei allenare per capire se fa per me?',
    destination: 'Prepara una prova',
    route: '/app/fit?section=training&training=plan',
    answerRoute: '/app/fit?section=training&training=plan',
    cta: 'Vedi chi allenare',
    copy: 'Il campione da provare nelle prossime partite per chiarire un dubbio.',
    icon: FlaskConical,
    tone: 'info',
  },
  {
    id: 'ban',
    question: 'Chi dovrei bannare?',
    navLabel: 'Chi dovrei bannare?',
    destination: 'Scegli il ban',
    route: '/app/fit?section=matchups&relation=enemies',
    answerRoute: '/app/fit?section=matchups&relation=enemies',
    cta: 'Vedi chi bannare',
    copy: 'Gli avversari che ti penalizzano, considerando tutti i tuoi campioni o uno in particolare.',
    icon: Ban,
    tone: 'warning',
  },
  {
    id: 'stop',
    question: 'Chi non dovrei più giocare?',
    navLabel: 'Chi non dovrei più giocare?',
    destination: 'Metti in pausa',
    route: '/app/fit?section=choices&decision=pause',
    answerRoute: '/app/fit?section=choices&decision=pause',
    cta: 'Vedi chi mettere in pausa',
    copy: 'I campioni da mettere in pausa e i segnali negativi ancora da verificare.',
    icon: CircleOff,
    tone: 'negative',
  },
]
