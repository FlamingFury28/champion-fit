import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { ApiError, scopeQuery, type ScopeSnapshot } from '../api/client'
import { saveRecommendationFeedback } from '../api/mutations'
import { recommendationFeedbackQuery } from '../api/queries'
import type { RecommendationFeedbackInputDto, RecommendationFeedbackOptionDto, RecommendationPreference } from '../api/types'
import { roleLabel } from '../app/labels'
import { DataTable, ErrorState, FilterBar, Skeleton, StatusBadge, Surface } from './ui'

const CONCRETE_ROLES = new Set(['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'SUPPORT'])

interface PreferenceRequest {
  input: RecommendationFeedbackInputDto
  target: string
}

function preferenceLabel(value: RecommendationPreference) {
  if (value === 'like') return 'Mi piace'
  if (value === 'dislike') return 'Non fa per me'
  return 'Neutro'
}

function optionMatchesSearch(item: { champion: string; name: string }, search: string) {
  const needle = search.trim().toLocaleLowerCase('it')
  return !needle
    || item.name.toLocaleLowerCase('it').includes(needle)
    || item.champion.toLocaleLowerCase('it').includes(needle)
}

function rolesForAccounts(option: RecommendationFeedbackOptionDto | undefined, accounts: string[]) {
  const firstAccount = accounts[0]
  if (!option || !firstAccount) return []
  const byAccount = option.roles_by_account
  const candidates: string[] = byAccount && Object.keys(byAccount).length
    ? byAccount[firstAccount] ?? []
    : option.roles
  return candidates.filter((role, index) => CONCRETE_ROLES.has(role)
    && candidates.indexOf(role) === index
    && accounts.every((account) => (byAccount?.[account] ?? option.roles).includes(role)))
}

export function PreferenceEditor({ scope, enabled = true }: { scope: ScopeSnapshot; enabled?: boolean }) {
  const identity = JSON.stringify(scopeQuery({ accounts: scope.accounts, companion: null }).account ?? [])
  return <ScopedPreferenceEditor key={identity} scope={scope} enabled={enabled} />
}

function ScopedPreferenceEditor({ scope, enabled }: { scope: ScopeSnapshot; enabled: boolean }) {
  const queryClient = useQueryClient()
  const feedback = useQuery({ ...recommendationFeedbackQuery(scope), enabled })
  const data = feedback.data
  const [search, setSearch] = useState('')
  const [champion, setChampion] = useState('')
  const [role, setRole] = useState('')
  const [selectedAccountsDraft, setSelectedAccountsDraft] = useState<string[] | null>(null)
  const [conflictRevision, setConflictRevision] = useState<number | null>(null)

  const options = useMemo(() => {
    return (data?.options ?? []).filter((item) => optionMatchesSearch(item, search))
  }, [data?.options, search])
  const effectiveChampion = options.some((item) => item.champion === champion) ? champion : ''
  const selectedOption = data?.options.find((item) => item.champion === effectiveChampion)
  const selectedAccounts = data
    ? (selectedAccountsDraft ?? data.accounts).filter((account) => data.accounts.includes(account))
    : []
  const roles = rolesForAccounts(selectedOption, selectedAccounts)
  const effectiveRole = roles.includes(role) ? role : ''

  const refresh = async () => {
    await Promise.all([
      // The revision is global, so every cached account scope becomes stale after a write.
      queryClient.invalidateQueries({ queryKey: ['api', 'recommendation-feedback'] }),
      queryClient.invalidateQueries({ queryKey: ['api', 'recommendations'] }),
    ])
  }
  const mutation = useMutation({
    mutationFn: ({ input }: PreferenceRequest) => saveRecommendationFeedback(input),
    onMutate: () => { setConflictRevision(null) },
    onSuccess: refresh,
    onError: async (error, request) => {
      if (error instanceof ApiError && error.status === 409) {
        setConflictRevision(request.input.expected_revision)
        await refresh()
      }
    },
  })
  const needsConflictRefresh = conflictRevision !== null && (!data || data.revision <= conflictRevision)
  const conflictStatus = conflictRevision === null ? null
    : feedback.isFetching ? 'Le preferenze sono cambiate altrove. Sto ricaricando il registro corrente; la tua bozza è conservata.'
      : feedback.error ? 'Non riesco ad aggiornare il registro corrente. La tua bozza è conservata: ricarica le preferenze prima di riprovare.'
        : needsConflictRefresh ? 'Il registro corrente non è ancora aggiornato. La tua bozza è conservata: ricarica le preferenze prima di riprovare.'
          : 'Le preferenze sono cambiate altrove. Ho ricaricato il registro corrente: riprova il giudizio.'
  const save = (preference: RecommendationPreference, accounts: string[], targetChampion = effectiveChampion, targetRole = effectiveRole) => {
    if (needsConflictRefresh) {
      if (!feedback.isFetching) void feedback.refetch()
      return
    }
    if (!data || !accounts.length || !targetChampion || !targetRole || mutation.isPending) return
    const name = data.options.find((item) => item.champion === targetChampion)?.name || targetChampion
    mutation.mutate({
      input: {
        accounts,
        champion: targetChampion,
        role: targetRole,
        preference,
        expected_revision: data.revision,
      },
      target: `${preferenceLabel(preference)} · ${name} · ${roleLabel(targetRole)} · ${accounts.join(', ')}`,
    })
  }
  const toggleAccount = (account: string) => setSelectedAccountsDraft((current) => {
    const selected = current ?? data?.accounts ?? []
    return selected.includes(account) ? selected.filter((item) => item !== account) : [...selected, account]
  })
  const updateSearch = (value: string) => {
    setSearch(value)
    const current = data?.options.find((item) => item.champion === champion)
    if (current && !optionMatchesSearch(current, value)) {
      setChampion('')
      setRole('')
    }
  }
  const updateChampion = (value: string) => {
    setChampion(value)
    const option = data?.options.find((item) => item.champion === value)
    setRole(rolesForAccounts(option, selectedAccounts)[0] ?? '')
  }

  return <Surface className="preference-editor" aria-labelledby="preference-editor-title">
    <div className="section-heading"><div><p className="eyebrow">Preferenze esplicite</p><h2 id="preference-editor-title">Dichiara cosa ti piace</h2></div>{data ? <StatusBadge tone="neutral">{data.items.length} salvate</StatusBadge> : null}</div>
    <p className="section-copy">Puoi scegliere qualunque campione del catalogo, anche senza partite o fuori dalle proposte mostrate. Il giudizio cambia l’ordine o esclude una proposta; non inventa risultati.</p>
    {!enabled || feedback.isPending ? <Skeleton lines={3} label="Caricamento delle preferenze" /> : null}
    {feedback.isError ? <ErrorState title="Preferenze non disponibili" error={feedback.error} onRetry={() => void feedback.refetch()} /> : null}
    {data ? <>
      <FilterBar>
        <label>Cerca nel catalogo<input value={search} onChange={(event) => updateSearch(event.target.value)} placeholder="es. Orianna" /></label>
        <label>Campione<select aria-label="Campione della preferenza" value={effectiveChampion} onChange={(event) => updateChampion(event.target.value)}><option value="">Scegli un campione…</option>{options.map((item) => <option key={item.champion} value={item.champion}>{item.name}{item.classified ? '' : ' · senza classificazione'}</option>)}</select></label>
        <label>Ruolo<select aria-label="Ruolo della preferenza" value={effectiveRole} disabled={!effectiveChampion || !roles.length} onChange={(event) => setRole(event.target.value)}><option value="">Scegli un ruolo…</option>{roles.map((item) => <option key={item} value={item}>{roleLabel(item)}</option>)}</select></label>
      </FilterBar>
      {data.accounts.length > 0 && (data.accounts.length > 1 || selectedAccountsDraft !== null) ? <details className="recommendation-feedback__account-picker">
        <summary>Account · {selectedAccounts.length}/{data.accounts.length} selezionati</summary>
        <fieldset><legend>Applica agli account spuntati</legend><div className="recommendation-feedback__accounts">{data.accounts.map((account) => <label key={account}><input type="checkbox" checked={selectedAccounts.includes(account)} onChange={() => toggleAccount(account)} />{account}</label>)}</div></fieldset>
      </details> : data.accounts.length === 1 ? <p className="recommendation-feedback__scope">Si applica a {data.accounts[0]}.</p> : <p className="context-note">Non ci sono account attivi a cui applicare la preferenza.</p>}
      <div className="recommendation-feedback__actions" aria-label="Salva la nuova preferenza">
        {needsConflictRefresh ? <button type="button" className="button button--secondary button--compact" disabled={feedback.isFetching || mutation.isPending} onClick={() => void feedback.refetch()}>{feedback.isFetching ? 'Ricarico preferenze…' : 'Ricarica preferenze'}</button> : <>
        <button type="button" className="button button--secondary button--compact" disabled={!effectiveChampion || !effectiveRole || !selectedAccounts.length || mutation.isPending} onClick={() => save('like', selectedAccounts)}>Mi piace</button>
        <button type="button" className="button button--secondary button--compact" disabled={!effectiveChampion || !effectiveRole || !selectedAccounts.length || mutation.isPending} onClick={() => save('dislike', selectedAccounts)}>Non fa per me</button>
        </>}
      </div>
      {data.suspended_accounts.length ? <p className="context-note">Account sospesi, non modificabili: {data.suspended_accounts.join(', ')}.</p> : null}
      {data.unresolved_accounts.length ? <p className="context-note">Account non risolti: {data.unresolved_accounts.join(', ')}.</p> : null}
      {conflictStatus ? <p className="field-error" role={feedback.isFetching ? 'status' : 'alert'}>{conflictStatus}<br />{mutation.variables?.target}</p>
        : mutation.isPending ? <span role="status"><span>Salvataggio della preferenza…</span> {mutation.variables?.target}</span>
          : mutation.isError ? <p className="field-error" role="alert">{mutation.error.message}<br />{mutation.variables?.target}</p> : null}
      {mutation.isSuccess && !mutation.isPending ? <span role="status"><span>Preferenza salvata.</span> {mutation.variables?.target}</span> : null}
      <div className="section-heading"><div><h3>Preferenze salvate</h3><p className="section-copy">Qui restano visibili anche i campioni esclusi dalle proposte.</p></div></div>
      {data.items.length ? <DataTable label="Registro delle preferenze dichiarate"><thead><tr><th>Campione</th><th>Ruolo</th><th>Account</th><th>Stato</th><th>Modifica</th></tr></thead><tbody>{data.items.map((item) => {
        const option = data.options.find((candidate) => candidate.champion === item.champion)
        return <tr key={`${item.account}-${item.champion}-${item.role}`}><th scope="row">{option?.name || item.champion}</th><td>{roleLabel(item.role)}</td><td>{item.account}</td><td>{preferenceLabel(item.preference)}</td><td><button type="button" className="button button--ghost button--compact" disabled={mutation.isPending || needsConflictRefresh} onClick={() => save('neutral', [item.account], item.champion, item.role)}>Imposta Neutro</button></td></tr>
      })}</tbody></DataTable> : <p className="context-note">Nessuna preferenza dichiarata. Scegli un campione, un ruolo e almeno un account per iniziare.</p>}
      <p className="context-note">Le liste sotto mostrano solo le proposte ordinate restituite dal motore e non sono un catalogo completo. L’ordine usa frequenze osservate e preferenze esplicite; “Non fa per me” esclude le proposte. La somiglianza di catalogo non è una probabilità di vittoria e non viene aggiunto un prior statistico.</p>
    </> : null}
  </Surface>
}
