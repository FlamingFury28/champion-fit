import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, ThumbsDown, ThumbsUp } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ApiError, postJson } from '../api/client'
import type { ObservedRecommendationDto, RecommendationFeedbackInputDto, RecommendationPreference } from '../api/types'
import { pct } from '../app/filters'
import { roleLabel, tagLabel, translateModelText } from '../app/labels'
import { ChampionAvatar, StatusBadge, Surface } from './ui'

function recommendationName(item: ObservedRecommendationDto) {
  return item.name || item.champion
}

function preferenceLabel(value: RecommendationPreference | null) {
  if (value === 'like') return 'Mi piace'
  if (value === 'dislike') return 'Non fa per me'
  if (value === 'neutral') return 'Neutro'
  return 'Non indicata'
}

function confidenceLabel(value: number | string) {
  if (typeof value === 'number') return pct(value <= 1 ? value * 100 : value, 0)
  return value || 'copertura indicativa'
}

function catalogTagLabel(value: string) {
  return tagLabel(value.includes(':') ? value.slice(value.indexOf(':') + 1) : value)
}

export function RecommendationFeedback({ item, accounts, allowAllAccountsShortcut, feedbackRevision }: {
  item: ObservedRecommendationDto
  accounts: string[]
  allowAllAccountsShortcut: boolean
  feedbackRevision: number
}) {
  void allowAllAccountsShortcut
  const queryClient = useQueryClient()
  const [selectedAccounts, setSelectedAccounts] = useState(accounts)
  const feedback = useMutation({
    mutationFn: (preference: RecommendationPreference) => postJson<unknown>('/api/recommendation-feedback', {
      accounts: selectedAccounts,
      champion: item.champion,
      role: item.role,
      preference,
      expected_revision: feedbackRevision,
    } satisfies RecommendationFeedbackInputDto),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['api', 'recommendations'] }),
        queryClient.invalidateQueries({ queryKey: ['api', 'recommendation-feedback'] }),
      ])
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['api', 'recommendations'] }),
          queryClient.invalidateQueries({ queryKey: ['api', 'recommendation-feedback'] }),
        ])
      }
    },
  })
  const toggleAccount = (account: string) => setSelectedAccounts((current) => current.includes(account)
    ? current.filter((value) => value !== account)
    : [...current, account])
  const accountScopeLabel = selectedAccounts.length === accounts.length
    ? `tutti i ${accounts.length} account selezionati`
    : selectedAccounts.length ? `${selectedAccounts.length} di ${accounts.length} account selezionati` : 'nessun account selezionato'
  const submit = (value: RecommendationPreference) => {
    if (selectedAccounts.length && !feedback.isPending) feedback.mutate(value)
  }

  return <div className="recommendation-feedback">
    <div><strong>Preferenza dichiarata</strong><span>Attuale: {preferenceLabel(item.feedback)}. Modifica l’ordine dei suggerimenti, non i risultati osservati.</span></div>
    {accounts.length > 1 ? <details className="recommendation-feedback__account-picker">
      <summary>Account · {accountScopeLabel}</summary>
      <fieldset>
        <legend>Applica agli account selezionati</legend>
        <p>{selectedAccounts.length === accounts.length ? 'Il giudizio si applica a tutti gli account selezionati nel perimetro.' : 'Il giudizio vale solo per gli account spuntati.'}</p>
        <div className="recommendation-feedback__accounts">{accounts.map((account) => <label key={account}><input type="checkbox" checked={selectedAccounts.includes(account)} onChange={() => toggleAccount(account)} />{account}</label>)}</div>
      </fieldset>
    </details> : <p className="recommendation-feedback__scope">{accounts[0] ? `Si applica a ${accounts[0]}.` : 'Nessun account attivo per questa preferenza.'}</p>}
    <div className="recommendation-feedback__actions" aria-label={`Preferenza per ${recommendationName(item)}`}>
      <button type="button" className="button button--secondary button--compact" aria-pressed={item.feedback === 'like'} disabled={!selectedAccounts.length || feedback.isPending} onClick={() => submit('like')}><ThumbsUp aria-hidden="true" /> Mi piace</button>
      <button type="button" className="button button--ghost button--compact" aria-pressed={item.feedback === 'neutral'} disabled={!selectedAccounts.length || feedback.isPending} onClick={() => submit('neutral')}>Neutro</button>
      <button type="button" className="button button--secondary button--compact" aria-pressed={item.feedback === 'dislike'} disabled={!selectedAccounts.length || feedback.isPending} onClick={() => submit('dislike')}><ThumbsDown aria-hidden="true" /> Non fa per me</button>
    </div>
    {feedback.isPending ? <span role="status">Salvataggio della preferenza…</span> : null}
    {feedback.isError ? <p className="field-error" role="alert">{feedback.error instanceof ApiError && feedback.error.status === 409 ? 'Le preferenze sono cambiate altrove. Ho ricaricato la revisione corrente: riprova il giudizio.' : feedback.error.message}</p> : null}
  </div>
}

export function ObservedRecommendationCard({ item, index, detailHref, feedbackAccounts, allowAllAccountsShortcut = false, feedbackRevision, showFeedback = true }: {
  item: ObservedRecommendationDto
  index?: number
  detailHref?: string
  feedbackAccounts: string[]
  allowAllAccountsShortcut?: boolean
  feedbackRevision: number
  showFeedback?: boolean
}) {
  const performance = item.performance
  const observedPerformance = performance && performance.games > 0 ? performance : null
  const similarity = item.similarity == null ? null : item.similarity * 100
  const familiarLabel = observedPerformance ? 'Già giocato' : item.feedback === 'like' ? 'Piace dichiarato' : 'Scelta nota'
  const comparableAccountCount = performance?.comparable_accounts.length ?? 0
  return <Surface className="recommendation-card observed-recommendation" data-kind={item.kind}>
    <div className="recommendation-card__heading">
      <span className="row-rank">{index == null ? '•' : String(index + 1).padStart(2, '0')}</span>
      <ChampionAvatar name={recommendationName(item)} src={item.icon_url} />
      <span className="answer-ranking__identity"><strong>{recommendationName(item)}</strong><small>{roleLabel(item.role, true)}</small></span>
      <StatusBadge tone={item.kind === 'familiar' ? 'positive' : 'info'}>{item.kind === 'familiar' ? familiarLabel : 'Da scoprire'}</StatusBadge>
    </div>
    <div className="compact-stat-list">
      {observedPerformance ? <article><div><strong>Media degli account esposti</strong><span>{observedPerformance.games} {observedPerformance.games === 1 ? 'partita unica' : 'partite uniche'} · {observedPerformance.wins} {observedPerformance.wins === 1 ? 'vittoria' : 'vittorie'} e {observedPerformance.losses} {observedPerformance.losses === 1 ? 'sconfitta' : 'sconfitte'} in {observedPerformance.observations} {observedPerformance.observations === 1 ? 'osservazione account-partita' : 'osservazioni account-partita'}</span></div><b>{pct(observedPerformance.win_rate, 1)}</b></article> : <article><div><strong>Risultati osservati</strong><span>{item.feedback === 'like' ? 'Preferenza dichiarata senza partite in questo contesto' : 'Nessuna partita con questo campione nel perimetro selezionato'}</span></div></article>}
      {performance?.interval_low != null && performance.interval_high != null ? <article><div><strong>Intervallo binomiale al {confidenceLabel(performance.confidence)}</strong><span>{pct(performance.interval_low, 1)}–{pct(performance.interval_high, 1)}</span></div></article> : null}
      {item.kind === 'discovery' ? <article><div><strong>Affinità di catalogo</strong><span>Somiglianza di caratteristiche, non probabilità di vittoria</span></div><b>{similarity == null ? 'Non stimata' : pct(similarity, 0)}</b></article> : null}
      {performance && performance.baseline_games > 0 ? <article><div><strong>Differenza negli account confrontabili ({comparableAccountCount})</strong><span>{comparableAccountCount}/{item.account_count} account esposti hanno dati per entrambe le scelte. La differenza usa solo questi account, non sottrae le due medie complessive.</span></div>{performance.lift_pp != null ? <b>{performance.lift_pp > 0 ? '+' : ''}{performance.lift_pp.toLocaleString('it-IT', { maximumFractionDigits: 1 })} pp</b> : null}</article> : null}
    </div>
    {item.reasons.length ? <ul className="recommendation-reasons">{item.reasons.map((reason, reasonIndex) => <li key={`${reason}-${reasonIndex}`}>{translateModelText(reason)}</li>)}</ul> : null}
    {item.source_champions.length ? <div className="recommendation-sources"><strong>Somiglia alle tue scelte</strong>{item.source_champions.map((source) => <span key={`${source.champion}-${source.games}`}>{source.name || source.champion} · {source.source_kind === 'explicit_feedback' ? 'preferenza dichiarata' : `${source.games} partite`} · {pct(source.similarity * 100, 0)}{source.matched_tags.length ? ` · ${source.matched_tags.map(catalogTagLabel).join(', ')}` : ''}</span>)}</div> : null}
    {observedPerformance && observedPerformance.games < 5 ? <p className="recommendation-sample-note">Il campione è già utile per descrivere i tuoi gusti; con {observedPerformance.games} {observedPerformance.games === 1 ? 'partita' : 'partite'} il confronto dei risultati resta instabile.</p> : null}
    {showFeedback ? <RecommendationFeedback key={feedbackAccounts.join('\u0000')} item={item} accounts={feedbackAccounts} allowAllAccountsShortcut={allowAllAccountsShortcut} feedbackRevision={feedbackRevision} /> : null}
    {detailHref ? <nav className="recommendation-card__actions"><Link className="button button--compact" state={{ championSheetFromList: true }} to={detailHref}>Apri la scheda <ArrowRight aria-hidden="true" /></Link></nav> : null}
  </Surface>
}
