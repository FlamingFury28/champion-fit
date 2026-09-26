import { describe, expect, it } from 'vitest'
import { credibleBounds, getSetting, setSetting } from './algorithm-settings'
import { historicalSettingsDraft, settingOptionLabel } from '../pages/AlgorithmSettingsPage'

describe('algorithm settings helpers', () => {
  it('updates a nested draft without mutating the active settings', () => {
    const active = { evidence: { credible_mass: 0.9 }, training: { budget: 20 } }
    const draft = setSetting(active, 'training.budget', 40)

    expect(getSetting(active, 'training.budget')).toBe(20)
    expect(getSetting(draft, 'training.budget')).toBe(40)
    expect(draft).not.toBe(active)
  })

  it('prefers generic credible bounds and falls back to the legacy 90 percent fields', () => {
    expect(credibleBounds({ credible_lower: 42, credible_upper: 66, credible_lower_90: 40, credible_upper_90: 68 }))
      .toEqual({ lower: 42, upper: 66 })
    expect(credibleBounds({ credible_lower_90: 40, credible_upper_90: 68 }))
      .toEqual({ lower: 40, upper: 68 })
  })

  it('uses readable labels for context options', () => {
    expect(settingOptionLabel('context.queue', '420', '420')).toBe('Classificata · Solo/Duo')
    expect(settingOptionLabel('context.days', 'all', 'all')).toBe('Tutto lo storico')
    expect(settingOptionLabel('recommendations.queue', 'auto', 'auto')).toBe('Automatica · più giocata nel perimetro')
    expect(settingOptionLabel('evidence.min_games', 20, '20')).toBe('20')
  })

  it('completa una revisione storica con il gruppo raccomandazioni corrente', () => {
    const historical = { evidence: { credible_mass: 0.9 }, context: { queue: '420' } }
    const defaults = { recommendations: { limit: 6, trial_budget: 3, queue: 'auto' }, evidence: { credible_mass: 0.8 } }
    const draft = historicalSettingsDraft(historical, defaults)
    expect(draft).toEqual({ ...historical, recommendations: defaults.recommendations })
    expect(historical).not.toHaveProperty('recommendations')
  })
})
