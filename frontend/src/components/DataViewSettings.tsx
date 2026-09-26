import { BarChart3, Check, LayoutGrid, List, Radar, ScatterChart, X, type LucideIcon } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useId } from 'react'
import { DATA_VIEW_OPTIONS, type DataViewPreference, useDataViewSettings } from '../app/data-view'
import './DataViewSettings.css'

const VIEW_ICONS: Record<DataViewPreference, LucideIcon> = {
  list: List,
  cards: LayoutGrid,
  bars: BarChart3,
  scatter: ScatterChart,
  radar: Radar,
}

export function DataViewSettings() {
  const { view, storageAvailable, setView } = useDataViewSettings()
  const radioName = useId()
  const current = DATA_VIEW_OPTIONS.find((option) => option.value === view)
  if (!current) return null
  const CurrentIcon = VIEW_ICONS[current.value]

  return (
    <Dialog.Root>
      <Dialog.Trigger className="button button--ghost button--compact data-view-trigger" aria-label="Vista dati">
        <CurrentIcon aria-hidden="true" />
        <span>Vista: {current.label}</span>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content data-view-dialog">
          <div className="dialog-heading">
            <div>
              <Dialog.Title>Visualizzazione dei dati</Dialog.Title>
              <Dialog.Description>La scelta si applica a tutte le pagine.</Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label="Chiudi visualizzazione dati">
              <X aria-hidden="true" />
            </Dialog.Close>
          </div>
          <fieldset className="data-view-options">
            <legend>Scegli come visualizzare i dati</legend>
            {DATA_VIEW_OPTIONS.map((option) => {
              const Icon = VIEW_ICONS[option.value]
              const checked = view === option.value
              return (
                <label className="data-view-option" key={option.value} data-selected={checked}>
                  <input
                    type="radio"
                    name={radioName}
                    value={option.value}
                    checked={checked}
                    onChange={() => setView(option.value)}
                  />
                  <Icon aria-hidden="true" />
                  <span className="data-view-option__copy"><strong>{option.label}</strong><small>{option.description}</small></span>
                  <Check className="data-view-option__check" aria-hidden="true" />
                </label>
              )
            })}
          </fieldset>
          <p className="data-view-fallback">Ogni sezione usa la vista scelta quando i suoi dati lo consentono. Altrimenti mostra barre, schede o un elenco, mantenendo la tua preferenza per le altre pagine.</p>
          <p className="data-view-note" role="status">
            {storageAvailable ? 'Preferenza salvata in questo browser.' : 'La preferenza resta attiva ora, ma il browser non può salvarla.'}
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
