import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { MatchupItemDto } from '../api/types'
import { MatchupList } from './MatchupList'

function matchup(overrides: Partial<MatchupItemDto>): MatchupItemDto {
  return {
    champion: 'Zed',
    icon_url: '',
    games: 2,
    wins_against: 0,
    losses_to: 2,
    win_rate_against: 0,
    positive_evidence: 0,
    negative_evidence: 2,
    effective_evidence: 2,
    weighted_win_rate_against: 0,
    posterior_win_rate: 44,
    posterior_lift_pp: -6,
    relative_delta_pp: -6,
    baseline_win_rate: 50,
    credible_lower_90: 31,
    credible_upper_90: 57,
    probability_worse_than_baseline: 72,
    probability_meaningful_advantage: 10,
    probability_meaningful_disadvantage: 72,
    direction_probability: 72,
    direction_confidence: 44,
    effective_sample_size: 2,
    personal_effective_sample_size: 2,
    quality_coverage: 100,
    recent_90d_games: 2,
    exposure_rate: 2,
    matchup_score: 12,
    reliability: 'exploratory',
    actionable: false,
    prior_source: 'account_role',
    prior_games: 30,
    recommendation: 'loses_to',
    ...overrides,
  }
}

describe('MatchupList', () => {
  it('riserva il primo ban consigliato al primo segnale operativo', () => {
    render(<MatchupList direction="loses" items={[
      matchup({ champion: 'Zed' }),
      matchup({ champion: 'Fizz', actionable: true, reliability: 'indicative', effective_sample_size: 9 }),
    ]} />)

    expect(screen.getByText('da osservare')).toBeInTheDocument()
    expect(screen.getByText('#1 ban consigliato')).toBeInTheDocument()
    expect(screen.getAllByText('2 partite osservate · incontrato nel 2% delle partite')).toHaveLength(2)
    expect(screen.getAllByText('rispetto al tuo rendimento abituale')).toHaveLength(2)
    expect(screen.getAllByText('−6 pp')).toHaveLength(2)
    const rows = screen.getAllByRole('article')
    expect(within(rows[0]!).getByText('Zed')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('Esplorativo')).toBeInTheDocument()
    expect(within(rows[0]!).queryByText('#1 ban consigliato')).not.toBeInTheDocument()
    expect(within(rows[1]!).getByText('Fizz')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('Indicativo')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('#1 ban consigliato')).toBeInTheDocument()
  })

  it('non etichetta come ban una lista composta soltanto da segnali esplorativi', () => {
    render(<MatchupList direction="loses" items={[matchup({ champion: 'Zed' })]} />)

    expect(screen.queryByText('#1 ban consigliato')).not.toBeInTheDocument()
    expect(screen.getByText('da osservare')).toBeInTheDocument()
  })
})
