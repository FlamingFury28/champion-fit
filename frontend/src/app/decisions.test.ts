import { describe, expect, it } from 'vitest'
import { primaryDecisions } from './decisions'

describe('primaryDecisions', () => {
  it('mantiene una domanda univoca per ciascuna risposta operativa', () => {
    expect(primaryDecisions.map(({ id, question, route }) => ({ id, question, route }))).toEqual([
      { id: 'play', question: 'Chi mi conviene giocare?', route: '/app/fit' },
      { id: 'train', question: 'Chi dovrei allenare per capire se fa per me?', route: '/app/fit?section=training&training=plan' },
      { id: 'ban', question: 'Chi dovrei bannare?', route: '/app/fit?section=matchups&relation=enemies' },
      { id: 'stop', question: 'Chi non dovrei più giocare?', route: '/app/fit?section=choices&decision=pause' },
    ])
    expect(new Set(primaryDecisions.map((decision) => decision.route)).size).toBe(primaryDecisions.length)
  })
})
