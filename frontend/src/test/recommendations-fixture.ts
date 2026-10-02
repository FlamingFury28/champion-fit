import type { ObservedRecommendationDto, RecommendationsResponseDto } from '../api/types'

export function observedRecommendation(overrides: Partial<ObservedRecommendationDto> = {}): ObservedRecommendationDto {
  return {
    champion: 'Ahri', name: 'Ahri', role: 'MIDDLE', icon_url: '/ahri.png', kind: 'familiar',
    preference_score: 0.8, similarity: null, games: 1, account_count: 1, selected_account_count: 1,
    source_champions: [], reasons: ['Hai già scelto Ahri in questo ruolo.'], feedback: null,
    performance: {
      games: 1, observations: 1, wins: 1, losses: 0, win_rate: 100,
      interval_low: 20.7, interval_high: 100, confidence: 0.9, baseline_games: 0,
      baseline_win_rate: null, baseline_low: null, baseline_high: null, lift_pp: null,
      comparable_accounts: [], missing_accounts: [], missing_baseline_accounts: ['Alpha#EUW'],
      per_account: { 'Alpha#EUW': { games: 1, wins: 1, losses: 0, win_rate: 100 } },
      supported: false, direction: 'positive', method: 'observed_binomial',
    },
    ...overrides,
  }
}

export function discoveryRecommendation(overrides: Partial<ObservedRecommendationDto> = {}): ObservedRecommendationDto {
  return observedRecommendation({
    champion: 'Orianna', name: 'Orianna', icon_url: '/orianna.png', kind: 'discovery',
    preference_score: 0.7, similarity: 0.75, games: 0, account_count: 0, selected_account_count: 1,
    source_champions: [{ champion: 'Ahri', name: 'Ahri', games: 1, similarity: 0.75, matched_tags: ['style:duel', 'style:sustained'] }],
    reasons: ['Condivide controllo e danni magici con Ahri.'],
    performance: null,
    ...overrides,
  })
}

export function recommendationsFixture(overrides: Partial<RecommendationsResponseDto> = {}): RecommendationsResponseDto {
  return {
    model_version: 'observed_preferences_v2', algorithm_revision: 4, algorithm_fingerprint: 'fingerprint-4',
    context: { accounts: ['Alpha#EUW'], role: 'MIDDLE', queue: '420', days: 'all', suspended_accounts: [], unresolved_accounts: [] }, feedback_revision: 7,
    coverage: { selected_accounts: ['Alpha#EUW'], active_accounts: ['Alpha#EUW'], missing_accounts: [], games: 1, observations: 1 },
    profile: [{ tag: 'mage', label: 'Mago', games: 1, accounts: 1, share: 1 }],
    known: [observedRecommendation()], discover: [discoveryRecommendation()],
    trial_plan: { budget: 3, items: [
      { champion: 'Orianna', role: 'MIDDLE', games: 1, reason: 'Affinità con Ahri.' },
      { champion: 'Syndra', role: 'MIDDLE', games: 1, reason: 'Condivide il profilo mago.' },
      { champion: 'Viktor', role: 'MIDDLE', games: 1, reason: 'Amplia il profilo controllo.' },
    ] },
    notes: ['Le percentuali descrivono solo le partite osservate.'], candidate: null,
    ...overrides,
  }
}
