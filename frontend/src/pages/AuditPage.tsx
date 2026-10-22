import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ClipboardCheck, Save } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useBlocker, useSearchParams } from 'react-router'
import { ApiError } from '../api/client'
import { invalidateAfterAnnotation } from '../api/invalidation'
import { saveAnnotation } from '../api/mutations'
import { annotationQuery, matchHistoryQuery, matchesQuery, queryKeys, type MatchHistoryFilters } from '../api/queries'
import type { AnnotationDto, AnnotationUpsertInput, MatchDto, MatchesResponseDto } from '../api/types'
import { formatDate, pct } from '../app/filters'
import { anomalyFlagsLabel, apiErrorLabel, queueLabel, roleLabel } from '../app/labels'
import { technicalText } from '../app/presentation'
import { useScope } from '../app/scope'
import { useToast } from '../components/toast'
import { ChampionAvatar, Drawer, EmptyState, ErrorState, FilterBar, PageHeader, Skeleton, StatusBadge } from '../components/ui'

const flags = [['contaminated', 'Sconfitte poco informative'], ['all', 'Tutte'], ['afk', 'Giocatori inattivi (AFK) o quasi inattivi'], ['loss', 'Tutte le sconfitte']]
const annotationFlags = [
  { key: 'invincible', label: 'Partita impossibile da vincere', effect: 'Su una sconfitta azzera il peso negativo nel calcolo.' },
  { key: 'carryable_loss', label: 'Sconfitta recuperabile', effect: 'Aggiunge contesto descrittivo; oggi non modifica il punteggio.' },
  { key: 'afk_player', label: 'Giocatore inattivo (AFK) in squadra', effect: 'Su una sconfitta azzera il peso negativo nel calcolo.' },
  { key: 'griefer', label: 'Giocatore che sabota', effect: 'Su una sconfitta azzera il peso negativo nel calcolo.' },
  { key: 'team_collapse', label: 'Crollo della squadra', effect: 'Aggiunge contesto descrittivo; oggi non modifica il punteggio.' },
] as const

function annotationValues(matchId: string, annotation: AnnotationDto | null, revision: string | null): AnnotationUpsertInput {
  return {
    match_id: matchId,
    invincible: Boolean(annotation?.invincible),
    carryable_loss: Boolean(annotation?.carryable_loss),
    afk_player: Boolean(annotation?.afk_player),
    griefer: Boolean(annotation?.griefer),
    team_collapse: Boolean(annotation?.team_collapse),
    manual_label: annotation?.manual_label ?? '',
    note: annotation?.note ?? '',
    confidence: annotation?.confidence ?? 1,
    expected_revision: revision,
  }
}

function confirmRemoteReplacement(remote: AnnotationUpsertInput) {
  const indicators = annotationFlags.filter(({ key }) => remote[key]).map(({ label }) => label).join('; ') || 'Nessuno'
  return window.confirm(`L’annotazione è cambiata altrove. La versione corrente contiene:\n\nIndicatori: ${indicators}\nEtichetta: ${remote.manual_label || '(vuota)'}\nNota: ${remote.note || '(vuota)'}\nSicurezza: ${pct(remote.confidence * 100, 0)}\n\nVuoi sostituire tutti questi campi con la tua bozza?`)
}

function AnnotationEditor({ match, annotation, revision, refreshError, isRefreshing, onRefresh, onClose, onDirtyChange, onSavingChange }: {
  match: MatchDto
  annotation: AnnotationDto | null
  revision: string | null
  refreshError: Error | null
  isRefreshing: boolean
  onRefresh: () => void
  onClose: (saved?: boolean) => void
  onDirtyChange: (dirty: boolean) => void
  onSavingChange: (saving: boolean) => void
}) {
  const [editor, setEditor] = useState(() => {
    const values = annotationValues(match.match_id, annotation, revision)
    return { baseline: values, values }
  })
  const { values, baseline } = editor
  const [conflict, setConflict] = useState<{ revision: string | null } | null>(null)
  const dirty = JSON.stringify(values) !== JSON.stringify(baseline)
  const draftNeedsProtection = dirty || conflict !== null
  const waitingForNewRevision = conflict !== null && revision === conflict.revision
  const remoteChanged = revision !== baseline.expected_revision
  useEffect(() => { onDirtyChange(draftNeedsProtection) }, [draftNeedsProtection, onDirtyChange])
  const submissionInFlight = useRef(false)
  const queryClient = useQueryClient()
  const { notify } = useToast()
  const mutation = useMutation({
    mutationFn: saveAnnotation,
    onSuccess: async (saved, submitted) => {
      const values = { ...submitted, expected_revision: saved.revision }
      setEditor({ baseline: values, values })
      await Promise.all([
        invalidateAfterAnnotation(queryClient),
        queryClient.invalidateQueries({ queryKey: queryKeys.annotation(match.match_id) }),
      ])
      notify('Annotazione salvata', { description: match.match_id, tone: 'success' })
      onClose(true)
    },
    onError: async (error, submitted) => {
      if (error instanceof ApiError && error.status === 409) {
        setConflict({ revision: submitted.expected_revision })
        await queryClient.invalidateQueries({ queryKey: queryKeys.annotation(match.match_id) })
        notify('Annotazione aggiornata altrove', { description: 'La tua bozza è conservata. Prima di riprovare verifica la versione corrente dell’annotazione.', tone: 'error' })
        return
      }
      notify('Salvataggio non riuscito', { description: apiErrorLabel(error.message), tone: 'error' })
    },
    onSettled: () => {
      submissionInFlight.current = false
      onSavingChange(false)
    },
  })
  // A clean editor follows fresh server data. A dirty editor keeps both its
  // original revision and draft until the user explicitly approves replacement.
  if (remoteChanged && !draftNeedsProtection && !mutation.isPending && !refreshError) {
    const values = annotationValues(match.match_id, annotation, revision)
    setEditor({ baseline: values, values })
  }
  const setValues = (update: (current: AnnotationUpsertInput) => AnnotationUpsertInput) => {
    if (!submissionInFlight.current) setEditor((current) => ({ ...current, values: update(current.values) }))
  }
  const toggle = (key: keyof Pick<AnnotationUpsertInput, 'invincible' | 'carryable_loss' | 'afk_player' | 'griefer' | 'team_collapse'>) => setValues((current) => ({ ...current, [key]: !current[key] }))
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (submissionInFlight.current || mutation.isPending || isRefreshing) return
    if (refreshError || waitingForNewRevision) { onRefresh(); return }
    let submitted = values
    if (remoteChanged) {
      const remote = annotationValues(match.match_id, annotation, revision)
      if (!confirmRemoteReplacement(remote)) return
      submitted = { ...values, expected_revision: revision }
      setEditor({ baseline: remote, values: submitted })
    }
    submissionInFlight.current = true
    setConflict(null)
    onSavingChange(true)
    mutation.mutate(submitted)
  }
  const status = conflict !== null && isRefreshing ? 'Aggiornamento dell’annotazione corrente. La tua bozza è conservata.'
    : mutation.isPending ? 'Salvataggio in corso…'
    : refreshError ? 'Non riesco ad aggiornare l’annotazione corrente. La tua bozza è conservata: ricarica prima di salvare.'
      : waitingForNewRevision ? 'La versione corrente dell’annotazione non è ancora aggiornata. La tua bozza è conservata: ricarica prima di salvare.'
      : remoteChanged ? 'L’annotazione è cambiata altrove. La tua bozza è conservata: prima di salvarla dovrai confrontare e confermare la sostituzione della versione corrente.'
        : isRefreshing ? 'Aggiornamento dell’annotazione corrente. La tua bozza è conservata.'
          : mutation.isError ? apiErrorLabel(mutation.error.message)
            : 'Le informazioni del modulo sostituiranno l’annotazione corrente.'

  return (
    <form className="annotation-form" onSubmit={submit} aria-busy={mutation.isPending}>
      <div className="annotation-match"><ChampionAvatar name={match.champion} src={match.icon_url} size="lg" /><div><strong>{match.champion} · {roleLabel(match.role)}</strong><span>{match.account} · {formatDate(match.date_utc ?? match.date)}</span><small>{match.match_id}</small></div></div>
      <fieldset disabled={mutation.isPending}><legend>Indicatori manuali</legend>{annotationFlags.map(({ key, label, effect }) => { const descriptionId = `annotation-${key}-description`; return <label className="switch-row" key={key}><span><strong>{label}</strong><small id={descriptionId}>{effect}</small></span><input aria-label={label} aria-describedby={descriptionId} type="checkbox" checked={Boolean(values[key])} onChange={() => toggle(key)} /></label> })}</fieldset>
      <label>Etichetta manuale<input aria-label="Etichetta manuale" aria-describedby="annotation-label-description" disabled={mutation.isPending} value={values.manual_label} onChange={(event) => setValues((current) => ({ ...current, manual_label: event.target.value }))} maxLength={40} placeholder="es. scelta dei campioni sfavorevole" /><small id="annotation-label-description">Descrive la partita senza cambiare il peso automatico.</small></label>
      <label>Nota<textarea aria-label="Nota" aria-describedby="annotation-note-description" disabled={mutation.isPending} value={values.note} onChange={(event) => setValues((current) => ({ ...current, note: event.target.value }))} maxLength={1000} rows={5} placeholder="Contesto utile per la revisione futura…" /><small id="annotation-note-description">Contesto descrittivo per una revisione successiva.</small></label>
      <label>Quanto sei sicuro dell’annotazione · {pct(values.confidence * 100, 0)}<input aria-label="Sicurezza dell’annotazione" aria-describedby="annotation-confidence-description" disabled={mutation.isPending} type="range" min={0} max={1} step={0.05} value={values.confidence} onChange={(event) => setValues((current) => ({ ...current, confidence: Number(event.target.value) }))} /><small id="annotation-confidence-description">Valore solo descrittivo: non cambia il calcolo.</small></label>
      <div className="mutation-status" aria-live="polite">{status}</div>
      <div className="dialog-actions"><button className="button button--ghost" type="button" disabled={mutation.isPending} onClick={() => onClose()}>Annulla</button><button className="button" type="submit" disabled={mutation.isPending || isRefreshing}><Save aria-hidden="true" /> {conflict !== null && isRefreshing ? 'Ricarico annotazione…' : mutation.isPending ? 'Salvo…' : refreshError || waitingForNewRevision ? 'Ricarica annotazione' : 'Salva annotazione'}</button></div>
    </form>
  )
}

function AnnotationForm({ match, onClose, onDirtyChange, onSavingChange }: { match: MatchDto; onClose: (saved?: boolean) => void; onDirtyChange: (dirty: boolean) => void; onSavingChange: (saving: boolean) => void }) {
  const annotation = useQuery(annotationQuery(match.match_id))
  if (!annotation.data) {
    if (annotation.isError) return <ErrorState error={annotation.error} onRetry={() => void annotation.refetch()} />
    return <Skeleton lines={5} label="Caricamento annotazione" />
  }
  return <AnnotationEditor
    match={match}
    annotation={annotation.data.item}
    revision={annotation.data.revision}
    refreshError={annotation.error}
    isRefreshing={annotation.isFetching}
    onRefresh={() => { void annotation.refetch() }}
    onClose={onClose}
    onDirtyChange={onDirtyChange}
    onSavingChange={onSavingChange}
  />
}

function selectedFlag(params: URLSearchParams, embedded: boolean) {
  return flags.some(([value]) => value === params.get('flag')) ? params.get('flag')! : embedded ? 'all' : 'contaminated'
}

export function AuditPage({ embedded = false, filters }: { embedded?: boolean; filters?: MatchHistoryFilters }) {
  return filters ? <PaginatedAudit embedded={embedded} filters={filters} /> : <LegacyAudit embedded={embedded} />
}

function LegacyAudit({ embedded }: { embedded: boolean }) {
  const { scope, scopeReady } = useScope()
  const [params] = useSearchParams()
  const matches = useQuery({ ...matchesQuery(scope, selectedFlag(params, embedded)), enabled: scopeReady })
  return <AuditContent embedded={embedded} matches={matches} />
}

function PaginatedAudit({ embedded, filters }: { embedded: boolean; filters: MatchHistoryFilters }) {
  const { scope, scopeReady } = useScope()
  const [params] = useSearchParams()
  const history = useInfiniteQuery({ ...matchHistoryQuery(scope, selectedFlag(params, embedded), filters), enabled: scopeReady })
  // Imports may move page boundaries. Keep each account's observation once.
  const items = [...new Map(history.data?.pages.flatMap((page) => page.items).map((match) => [JSON.stringify([match.account, match.match_id]), match]) ?? []).values()]
  const data = history.data ? { items, total: history.data.pages[0]?.total } : undefined
  return <AuditContent embedded={embedded} matches={{
    data, isPending: history.isPending, isFetching: history.isFetching,
    isError: history.isError && !history.isFetchNextPageError,
    error: history.error, refetch: history.refetch,
  }} pagination={{
    hasMore: history.hasNextPage,
    loading: history.isFetchingNextPage,
    error: history.isFetchNextPageError ? history.error : null,
    load: () => { if (!history.isFetching) void history.fetchNextPage({ cancelRefetch: false }) },
  }} />
}

type MatchQueryState = {
  data?: MatchesResponseDto
  isPending: boolean
  isFetching: boolean
  isError: boolean
  error: Error | null
  refetch: () => unknown
}

function AuditContent({ embedded, matches, pagination }: {
  embedded: boolean
  matches: MatchQueryState
  pagination?: { hasMore: boolean; loading: boolean; error: Error | null; load: () => void }
}) {
  const [params, setParams] = useSearchParams()
  const defaultFlag = embedded ? 'all' : 'contaminated'
  const flag = selectedFlag(params, embedded)
  const visibleCount = matches.data?.items.length ?? 0
  const resultCount = pagination ? `${visibleCount} di ${matches.data?.total ?? visibleCount} partite` : `${visibleCount} partite`
  const [selected, setSelected] = useState<MatchDto | null>(null)
  const [annotationDirty, setAnnotationDirty] = useState(false)
  const [annotationSaving, setAnnotationSaving] = useState(false)
  const blockedDuringSave = useRef(false)
  const needsProtection = Boolean(selected) && (annotationDirty || annotationSaving)
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (!needsProtection) return false
    const leavesAudit = currentLocation.pathname !== nextLocation.pathname
      || (embedded && new URLSearchParams(nextLocation.search).get('section') === 'style')
    if (!leavesAudit) return false
    blockedDuringSave.current = annotationSaving
    return true
  })

  useEffect(() => {
    if (blocker.state !== 'blocked') return
    // A request finishing cannot revive an attempted exit made while saving.
    if (blockedDuringSave.current || annotationSaving || !annotationDirty) { blocker.reset(); return }
    if (window.confirm('Chiudere senza salvare le modifiche all’annotazione?')) blocker.proceed()
    else blocker.reset()
  }, [annotationDirty, annotationSaving, blocker])

  useEffect(() => {
    if (!needsProtection) return
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [needsProtection])

  const closeAnnotation = (saved = false) => {
    if (!saved && annotationSaving) return
    if (!saved && annotationDirty && !window.confirm('Chiudere senza salvare le modifiche all’annotazione?')) return
    setAnnotationDirty(false)
    setAnnotationSaving(false)
    setSelected(null)
  }

  return (
    <div className="page-stack">
      <PageHeader level={embedded ? 2 : 1} eyebrow="Contesto / Partite da rivedere" title="Partite e annotazioni" copy={pagination ? 'Apri una partita per annotarla. “Mostra” restringe solo questo elenco; le statistiche mantengono i quattro filtri in alto.' : flag === 'all' ? 'Rivedi fino a 24 partite nei dati selezionati. Alcuni indicatori cambiano il peso automatico; etichette, note, grado di sicurezza e contesto restano descrittivi.' : 'Rivedi fino a 24 partite con l’indicatore selezionato. Solo le annotazioni di partita impossibile da vincere, giocatore inattivo (AFK) o giocatore che sabota cambiano il peso automatico di una sconfitta.'} />
      <FilterBar><label>Mostra<select value={flag} onChange={(event) => setParams((current) => {
        const next = new URLSearchParams(current)
        if (event.target.value === defaultFlag) next.delete('flag')
        else next.set('flag', event.target.value)
        return next
      }, { replace: true })}>{flags.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><span className="filter-help"><ClipboardCheck aria-hidden="true" /> Apri una riga per annotarla</span><span className="filter-count" role="status">{pagination?.loading ? 'Caricamento altre partite…' : matches.isFetching && !matches.isPending ? 'Aggiornamento risultati…' : resultCount}</span></FilterBar>
      {matches.isPending ? <Skeleton lines={9} label="Caricamento revisione partite" /> : null}
      {matches.isError && matches.error ? <ErrorState error={matches.error} onRetry={() => void matches.refetch()} /> : null}
      {matches.data?.items.length ? <div className="audit-list" aria-busy={matches.isFetching && !matches.isPending}>{matches.data.items.map((match) => {
        const anomalyLabels = [
          match.explicit_afk || match.suspected_quasi_afk ? 'inattività (AFK)' : null,
          match.early_surrender ? 'resa anticipata' : null,
          match.annotation_manual_label ? `etichetta manuale ${match.annotation_manual_label}` : null,
          anomalyFlagsLabel(match.anomaly_flags) !== 'Nessuna anomalia' ? anomalyFlagsLabel(match.anomaly_flags) : null,
        ].filter(Boolean).join('; ') || 'nessuna anomalia descrittiva'
        const reason = technicalText(match.reason) || anomalyFlagsLabel(match.anomaly_flags) || 'Nessuna anomalia descrittiva.'
        const lossWeightLabel = match.win ? '' : ` Peso salvato della sconfitta ${Number(match.loss_attribution_weight).toFixed(2)}.`
        const accessibleLabel = `Apri annotazione: ${match.win ? 'vittoria' : 'sconfitta'} con ${match.champion}, ruolo ${roleLabel(match.role, true)}, account ${match.account}, ${queueLabel(match.queue)}, ${match.duration_minutes} minuti, ${formatDate(match.date_utc ?? match.date)}. Qualità ${pct(match.match_quality_score * 100, 0)}.${lossWeightLabel} Anomalie: ${anomalyLabels}. Motivo: ${reason}.`
        return <article key={`${match.account}-${match.match_id}`}>
        <button type="button" onClick={() => { setAnnotationDirty(false); setSelected(match) }} aria-label={accessibleLabel}>
          <span className={match.win ? 'result-block result-block--win' : 'result-block result-block--loss'}>{match.win ? 'VITTORIA' : 'SCONFITTA'}</span>
          <ChampionAvatar name={match.champion} src={match.icon_url} />
          <div className="audit-identity"><strong>{match.champion}</strong><span>{roleLabel(match.role, true)} · {match.account}</span><small>{queueLabel(match.queue)} · {match.duration_minutes} min · {formatDate(match.date_utc ?? match.date)}</small></div>
          <div className="audit-quality"><strong>{pct(match.match_quality_score * 100, 0)}</strong><span>qualità</span>{match.win ? null : <small>peso salvato della sconfitta {Number(match.loss_attribution_weight).toFixed(2)}</small>}</div>
          <div className="audit-flags">{match.explicit_afk || match.suspected_quasi_afk ? <StatusBadge tone="negative">Inattività (AFK)</StatusBadge> : null}{match.early_surrender ? <StatusBadge tone="warning">resa</StatusBadge> : null}{match.annotation_manual_label ? <StatusBadge tone="info">{match.annotation_manual_label}</StatusBadge> : null}</div>
          <p>{reason}</p>
        </button>
      </article>
      })}</div> : !matches.isPending && !matches.isError ? <EmptyState title={flag === 'all' ? 'Nessuna partita nei dati selezionati' : 'Nessun risultato per questo indicatore'} description="Modifica il filtro oppure cambia gli account considerati." /> : null}
      {pagination?.error ? <p role="alert">Impossibile caricare altre partite. {apiErrorLabel(pagination.error.message)} Le partite già caricate sono ancora disponibili.</p> : null}
      {pagination?.hasMore ? <div className="matches-pagination"><span>{resultCount}</span><button className="button button--secondary" type="button" disabled={matches.isFetching} onClick={pagination.load}>{pagination.loading ? 'Caricamento…' : pagination.error ? 'Riprova a caricare altre partite' : 'Carica altre partite'}</button></div> : null}
      <Drawer open={Boolean(selected)} onOpenChange={(open) => !open && closeAnnotation()} title="Annotazione della partita" description="Il salvataggio conserva tutti i campi; solo gli indicatori con un effetto sul calcolo cambiano il peso automatico.">{selected ? <AnnotationForm key={`${selected.account}-${selected.match_id}`} match={selected} onClose={closeAnnotation} onDirtyChange={setAnnotationDirty} onSavingChange={setAnnotationSaving} /> : null}</Drawer>
    </div>
  )
}
