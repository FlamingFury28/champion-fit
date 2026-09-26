import { BookmarkPlus, Check, Trash2, UserRound, UsersRound, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useScope } from '../app/scope'
import { useToast } from '../components/toast'
import { Modal, PageHeader, StatusBadge, Surface } from '../components/ui'

type ConfirmProfileAction =
  | { kind: 'overwrite'; name: string }
  | { kind: 'delete'; name: string }

export function ProfilePage() {
  const {
    state, scope, availableAccounts, setAccounts,
    saveProfile, deleteProfile, setCompanion, clearCompanion,
  } = useScope()
  const [profileName, setProfileName] = useState('')
  const [companionName, setCompanionName] = useState('')
  const [companionMode, setCompanionMode] = useState<'exclude' | 'only'>('exclude')
  const [confirmAction, setConfirmAction] = useState<ConfirmProfileAction | null>(null)
  const { notify } = useToast()

  const notifyCompanionCleared = (cleared: boolean) => {
    if (!cleared) return
    notify('Filtro sui compagni rimosso', {
      description: 'Il filtro dipendeva dagli account precedenti. Scegli di nuovo il profilo dei compagni per applicarlo alla selezione attiva.',
      tone: 'info',
    })
  }

  const applyProfile = (accounts: string[]) => {
    const result = setAccounts(accounts)
    notifyCompanionCleared(result.companionCleared)
    if (result.missing.length) {
      const applied = result.accounts.length
      notify(applied ? 'Profilo applicato parzialmente' : 'Profilo non applicato', {
        description: applied
          ? `${applied} ${applied === 1 ? 'account disponibile' : 'account disponibili'} applicati. Non più disponibili: ${result.missing.join(' · ')}.`
          : `Gli account del profilo non sono più disponibili: ${result.missing.join(' · ')}.`,
        tone: 'info',
      })
    }
  }

  const persistProfile = (name: string) => {
    saveProfile(name)
    setProfileName('')
    notify('Profilo salvato', { description: `${name} conserva ${scope.accounts.length} account.`, tone: 'success' })
  }

  const submitProfile = (event: FormEvent) => {
    event.preventDefault()
    const name = profileName.trim()
    if (!name) return
    if (Object.prototype.hasOwnProperty.call(state.profiles, name)) {
      setConfirmAction({ kind: 'overwrite', name })
      return
    }
    persistProfile(name)
  }

  const confirmProfileAction = () => {
    if (!confirmAction) return
    if (confirmAction.kind === 'overwrite') {
      persistProfile(confirmAction.name)
    } else {
      deleteProfile(confirmAction.name)
    }
    setConfirmAction(null)
  }

  const applyCompanion = () => {
    const accounts = state.profiles[companionName]
    if (!accounts?.length) return
    const result = setCompanion({ name: companionName, accounts, mode: companionMode })
    if (!result.accounts.length) {
      notify('Filtro sui compagni non applicato', { description: 'Il profilo non contiene account disponibili fuori dalla selezione attiva.', tone: 'info' })
      return
    }
    const unavailable = result.missing.length ? ` Account non disponibili esclusi: ${result.missing.join(' · ')}.` : ''
    notify('Filtro sui compagni aggiornato', { description: `${companionMode === 'exclude' ? 'Esclusione' : 'Presenza esclusiva'} · ${companionName} · ${result.accounts.length} ${result.accounts.length === 1 ? 'account applicato' : 'account applicati'}.${unavailable}`, tone: result.missing.length ? 'info' : 'success' })
  }

  const companionProfiles = Object.entries(state.profiles).map(([name, accounts]) => ({
    name,
    accounts: accounts.filter((account) => availableAccounts.some((item) => item.account === account) && !scope.accounts.includes(account)),
  })).filter(({ accounts }) => accounts.length)

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Impostazioni dei dati"
        title={<>Dati usati</>}
        copy="Scegli account, profili salvati e presenza dei compagni. La selezione si applica alle sezioni operative."
        aside={<StatusBadge tone="info">{scope.accounts.length} account attivi</StatusBadge>}
      />

      <div className="profile-settings-grid">
        <Surface className="account-summary">
          <div className="section-heading"><div><p className="eyebrow"><UserRound aria-hidden="true" /> Account</p><h2>Selezione attiva</h2></div><span>salvataggio automatico</span></div>
          <div className="selected-account-list">
            {availableAccounts.map((account) => {
              const active = scope.accounts.includes(account.account)
              return (
                <button
                  type="button"
                  key={account.account}
                  className={active ? 'account-chip account-chip--active' : 'account-chip'}
                  aria-pressed={active}
                  onClick={() => {
                    if (active && scope.accounts.length === 1) {
                      notify('Mantieni almeno un account attivo', { description: 'L’app richiede un account selezionato per aggiornare le risposte.', tone: 'info' })
                      return
                    }
                    const next = active ? scope.accounts.filter((value) => value !== account.account) : [...scope.accounts, account.account]
                    const result = setAccounts(next)
                    notifyCompanionCleared(result.companionCleared)
                  }}
                >
                  <span>{active ? <Check aria-hidden="true" /> : null}</span>
                  <strong>{account.account}</strong>
                  <small>{account.analyzed_games} partite analizzate</small>
                </button>
              )
            })}
          </div>
          <form className="inline-form" onSubmit={submitProfile}>
            <label>Nome profilo<input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="es. Account principali" maxLength={80} /></label>
            <button className="button" type="submit" disabled={!profileName.trim() || !scope.accounts.length}><BookmarkPlus aria-hidden="true" /> Salva</button>
          </form>
          <div className="saved-profiles">
            {Object.entries(state.profiles).length ? Object.entries(state.profiles).map(([name, accounts]) => (
              <article key={name}>
                <button type="button" className="saved-profile__apply" onClick={() => applyProfile(accounts)}>
                  <strong>{name}</strong><small>{accounts.length} account · {accounts.join(' · ')}</small>
                </button>
                <button type="button" className="icon-button" aria-label={`Elimina profilo ${name}`} onClick={() => setConfirmAction({ kind: 'delete', name })}><Trash2 aria-hidden="true" /></button>
              </article>
            )) : <p className="micro-empty">Nessun profilo salvato. La selezione corrente viene comunque conservata.</p>}
          </div>
        </Surface>

        <Surface className="companion-panel">
          <div className="section-heading"><div><p className="eyebrow"><UsersRound aria-hidden="true" /> Compagni</p><h2>Filtro di presenza</h2></div></div>
          <p className="section-copy">Scegli un profilo salvato per escludere le partite condivise oppure usare soltanto quelle giocate insieme.</p>
          <label>Profilo dei compagni
            <select value={companionName} onChange={(event) => setCompanionName(event.target.value)}>
              <option value="">Scegli un profilo</option>
              {companionProfiles.map(({ name, accounts }) => (
                <option key={name} value={name}>{name} · {accounts.length} {accounts.length === 1 ? 'account applicabile' : 'account applicabili'}</option>
              ))}
            </select>
          </label>
          <div className="segmented-control" aria-label="Modalità del filtro sui compagni">
            <button type="button" aria-pressed={companionMode === 'exclude'} onClick={() => setCompanionMode('exclude')}>Escludi</button>
            <button type="button" aria-pressed={companionMode === 'only'} onClick={() => setCompanionMode('only')}>Solo insieme</button>
          </div>
          <button className="button" type="button" disabled={!companionName} onClick={applyCompanion}>Applica filtro</button>
          {state.companion ? (
            <div className="active-companion">
              <StatusBadge tone="warning">{state.companion.mode === 'exclude' ? 'Escludi' : 'Solo'} · {state.companion.name} · {state.companion.accounts.length} {state.companion.accounts.length === 1 ? 'account' : 'account'}</StatusBadge>
              <button type="button" className="icon-button" aria-label="Rimuovi filtro sui compagni" onClick={clearCompanion}><X aria-hidden="true" /></button>
            </div>
          ) : <p className="micro-empty">Nessun filtro sui compagni attivo.</p>}
        </Surface>
      </div>

      <Modal
        open={Boolean(confirmAction)}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title={confirmAction?.kind === 'overwrite' ? 'Sovrascrivere questo profilo?' : 'Eliminare questo profilo?'}
        description={confirmAction?.kind === 'overwrite'
          ? `Il profilo “${confirmAction.name}” esiste già. La selezione di account salvata verrà sostituita con quella corrente.`
          : `Il profilo “${confirmAction?.name ?? ''}” verrà eliminato dai profili salvati.`}
      >
        <div className="dialog-actions">
          <button className="button button--ghost" type="button" onClick={() => setConfirmAction(null)}>Annulla</button>
          <button className={confirmAction?.kind === 'delete' ? 'button button--danger' : 'button'} type="button" onClick={confirmProfileAction}>
            {confirmAction?.kind === 'overwrite' ? 'Conferma sovrascrittura' : 'Conferma eliminazione'}
          </button>
        </div>
      </Modal>
    </div>
  )
}
