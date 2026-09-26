import { describe, expect, it } from 'vitest'
import type { BlacklistItemDto, ChampionListItemDto, PlanItemDto, RecommendationDto } from '../api/types'
import { buildChampionDecisions } from './champion-decisions'

const recommendation = { champion: 'Ahri', role: 'MIDDLE', actionable: true } as RecommendationDto
const pause = { champion: 'Ahri', role: 'MIDDLE', tier: 'strong', icon_url: '/ahri.png' } as BlacklistItemDto
const plan = { champion: 'Ahri', role: 'MIDDLE', allocated_games: 12, icon_url: '/ahri.png' } as PlanItemDto
const personal = { champion: 'Ahri', role: 'MIDDLE', record_kind: 'account', allocated_games: 12 } as ChampionListItemDto

describe('buildChampionDecisions', () => {
  it('unifies every source for one champion and role and exposes the contradiction', () => {
    const result = buildChampionDecisions(
      { recommendations: [recommendation], pauses: [pause], plan: [plan], champions: [personal] },
      { role: 'ALL', search: '', decision: 'all' },
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      champion: 'Ahri',
      role: 'MIDDLE',
      recommendation,
      pause,
      plan,
      personal,
      conflict: true,
    })
  })

  it('keeps missing signals absent instead of manufacturing a decision', () => {
    const result = buildChampionDecisions(
      { recommendations: [], pauses: [], plan: [], champions: [personal] },
      { role: 'MIDDLE', search: 'ahr', decision: 'all' },
    )

    expect(result[0]).toMatchObject({ recommendation: null, pause: null, plan: null, conflict: false })
  })

  it('uses only a negative signal for the pause filter', () => {
    const result = buildChampionDecisions(
      { recommendations: [recommendation], pauses: [], plan: [plan], champions: [personal] },
      { role: 'ALL', search: '', decision: 'pause' },
    )

    expect(result).toEqual([])
  })
})
