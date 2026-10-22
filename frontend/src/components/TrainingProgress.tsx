import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { scopeQuery, type ScopeSnapshot } from '../api/client'
import { startTrainingPlan, trainingProgressKey, trainingProgressQuery, validPlanId, type StartPlanInput } from '../api/training-progress'
import type { TrainingPlanResponseDto } from '../api/types'
import { queueLabel, roleLabel } from '../app/labels'
import { nextPlannedGame } from '../app/next-planned-game'
import { ErrorState, StatusBadge, Surface } from './ui'
import './TrainingProgress.css'

const storageKey = 'champion-fit:followed-plan:v1'
function savedPlan() {
  try { const id = localStorage.getItem(storageKey); return validPlanId(id) ? id : '' } catch { return '' }
}

export function TrainingProgress({ plan, scope, filters, ready, refreshPreview }: {
  plan?: TrainingPlanResponseDto; scope: ScopeSnapshot
  filters: { budget: number; role?: string; queue?: string; days?: string }
  ready: boolean; refreshPreview: () => void
}) {
  const client = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [remembered, setRemembered] = useState(savedPlan)
  const [storageWarning, setStorageWarning] = useState(false)
  const id = params.has('tracked_plan') ? params.get('tracked_plan') ?? '' : remembered
  const query = useQuery(trainingProgressQuery(id))
  const request = useRef<StartPlanInput | null>(null)
  const sending = useRef(false)
  const mutation = useMutation({ mutationFn: startTrainingPlan,
    onSuccess: (data) => {
      client.setQueryData(trainingProgressKey(data.id), data)
      try { localStorage.setItem(storageKey, data.id) } catch { /* URL retains recovery access. */ }
    },
  })
  const remember = (value: string) => {
    setRemembered(value)
    try { localStorage.setItem(storageKey, value); setStorageWarning(false) } catch { setStorageWarning(true) }
    setParams((previous) => { const next = new URLSearchParams(previous); next.set('tracked_plan', value); return next }, { replace: true })
  }
  const start = () => {
    if (!ready || !plan?.plan_fingerprint || sending.current) return
    const values = { ...scopeQuery(scope), ...filters }
    const context: Record<string, string[]> = {}
    Object.entries(values).forEach(([key, value]) => {
      if (value !== undefined && value !== '' && (!Array.isArray(value) || value.length)) context[key] = Array.isArray(value) ? value : [String(value)]
    })
    if (request.current?.fingerprint !== plan.plan_fingerprint) request.current = { id: crypto.randomUUID(), fingerprint: plan.plan_fingerprint, params: context }
    sending.current = true
    mutation.mutate(request.current, { onSuccess: (data) => remember(data.id), onSettled: () => { sending.current = false } })
  }
  const data = query.data
  const nextGame = data ? nextPlannedGame(data) : null
  if (!id && !plan?.plan_fingerprint) return null
  return <Surface className="training-progress" aria-label="Avanzamento del piano">
    {id ? <>
      <div className="training-progress__heading"><strong>Piano seguito</strong>
        {data ? <StatusBadge tone={data.remaining ? 'info' : 'positive'}>{data.remaining ? `${data.completed}/${data.planned} completate · ${data.remaining} rimanenti` : `Completato · ${data.planned} partite`}</StatusBadge> : null}
        <button type="button" className="button button--ghost button--compact" onClick={() => { remember(''); mutation.reset(); request.current = null }}>Smetti di seguire</button>
      </div>
      {!validPlanId(id) ? <p role="alert">Il link del piano non è valido.</p> : query.isPending ? <p role="status">Carico l’avanzamento…</p> : null}
      {query.isError ? <ErrorState title="Avanzamento non aggiornato" error={query.error} onRetry={() => void query.refetch()} /> : null}
      {data ? <>
        <p className="training-progress__copy">Dal {new Date(data.started_at).toLocaleString('it-IT')} · {queueLabel(data.queue)} · {data.accounts.join(', ') || 'Account non disponibili'}. Assegnazioni conservate anche quando cambi i filtri.</p>
        <progress max={data.planned} value={data.completed} aria-label="Partite completate del piano" />
        {data.unavailable_accounts.length || data.companion_unavailable ? <p role="alert">Alcuni account non sono disponibili o hanno la riconciliazione sospesa: i relativi conteggi sono incompleti.</p> : null}
        <div className="training-progress__next" role="status">
          {query.isFetching ? <p className="training-progress__copy">Aggiorno il suggerimento…</p>
            : query.isError ? <p className="training-progress__copy">Suggerimento sospeso: aggiorna l’avanzamento.</p>
              : data.unavailable_accounts.length || data.companion_unavailable ? <p className="training-progress__copy">Suggerimento sospeso finché i conteggi non sono completi.</p>
                : data.remaining === 0 ? <p className="training-progress__copy">Piano completato: nessuna partita da suggerire.</p>
                  : nextGame ? <>
                    <h3>Prossima partita: {nextGame.champion} · {roleLabel(nextGame.role)}</h3>
                    <p className="training-progress__copy">Più partite rimanenti nel piano: {nextGame.remaining}. Account: {nextGame.account} ({nextGame.accountRemaining} da completare).</p>
                    {data.companions.length ? <p className="training-progress__copy">{data.companion_mode === 'exclude' ? 'Senza' : 'Con'}: {data.companions.join(', ')}.</p> : null}
                  </> : <p className="training-progress__copy">Nessuna assegnazione disponibile da suggerire.</p>}
        </div>
        <details><summary>Dettaglio delle partite rimanenti</summary>
          <ul>{data.items.map((item) => <li key={`${item.champion}-${item.role}`}><strong>{item.champion} · {roleLabel(item.role)}</strong><span>{item.completed}/{item.planned} · {item.remaining} rimanenti</span><small>{item.accounts.map((entry) => `${entry.account}: ${entry.completed}/${entry.planned}`).join(' · ')}</small></li>)}</ul>
          {data.companions.length ? <p>{data.companion_mode === 'exclude' ? 'Senza' : 'Con'}: {data.companions.join(', ')}.</p> : null}
          {data.budget_total > data.planned ? <p>{data.budget_total - data.planned} partite del budget non erano assegnate.</p> : null}
          {data.extra ? <p>{data.extra} partite oltre le assegnazioni, escluse dal completamento.</p> : null}
          <p className="training-progress__copy">Il suggerimento dà priorità al campione e ruolo con più partite rimanenti, poi all’account con più partite da completare. A parità usa l’ordine alfabetico.</p>
          <a className="text-link" href={`?${new URLSearchParams({ ...Object.fromEntries(params), tracked_plan: id })}`}>Link a questo piano</a>
        </details>
      </> : null}
    </> : <div className="training-progress__heading"><div><strong>Segui i tuoi progressi</strong><p className="training-progress__copy">Salva queste assegnazioni per ritrovare le partite rimanenti e il prossimo campione da giocare.</p></div>
      <button type="button" className="button button--secondary button--compact" disabled={!ready || !plan?.budget_assigned || mutation.isPending} onClick={start}>{mutation.isPending ? 'Salvo il piano…' : 'Segui questo piano'}</button>
    </div>}
    <p className="training-progress__copy">Conteggio automatico sui dati importati manualmente. Nessuna sincronizzazione Riot automatica.</p>
    {!id && mutation.isError ? <ErrorState title="Piano non confermato" error={mutation.error} onRetry={start} /> : null}
    {!id && mutation.isError ? <button type="button" className="text-link" onClick={refreshPreview}>Aggiorna anteprima del piano</button> : null}
    {storageWarning ? <p role="status">Il browser non può ricordare il piano: conserva il link nella barra degli indirizzi.</p> : null}
  </Surface>
}
