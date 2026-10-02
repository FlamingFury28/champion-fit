import { describe, expect, it } from 'vitest'
import { primaryDecisions } from './decisions'

describe('primaryDecisions', () => {
  it('espone soltanto i due percorsi competitivi principali', () => {
    expect(primaryDecisions.map(({ id, question, route }) => ({ id, question, route }))).toEqual([
      { id: 'best', question: 'Quali giochi meglio?', route: '/app/fit?section=best' },
      { id: 'tournament', question: 'Piano da 400 partite', route: '/app/fit?section=tournament' },
    ])
    expect(new Set(primaryDecisions.map((decision) => decision.route)).size).toBe(primaryDecisions.length)
  })
})
