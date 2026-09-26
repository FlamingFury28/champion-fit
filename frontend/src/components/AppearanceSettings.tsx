import { Check, Monitor, Moon, Palette, RotateCcw, Sun, X, type LucideIcon } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useId } from 'react'
import { useAppearance } from '../app/appearance'
import { Surface } from './ui'

interface AppearanceOption<T extends string> {
  value: T
  label: string
  icon?: LucideIcon
  swatch?: boolean
}

function ChoiceGroup<T extends string>({ legend, options, value, onChange }: {
  legend: string
  options: readonly AppearanceOption<T>[]
  value: T
  onChange: (value: T) => void
}) {
  const name = useId()
  return (
    <fieldset className="appearance-group">
      <legend>{legend}</legend>
      <div className="appearance-options">
        {options.map(({ value: option, label, icon: Icon, swatch }) => (
          <label className="appearance-option" key={option}>
            <input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)} />
            {Icon ? <Icon aria-hidden="true" /> : null}
            {swatch ? <span className="appearance-swatch" data-swatch={option} aria-hidden="true" /> : null}
            <span>{label}</span>
            <Check className="appearance-option__check" aria-hidden="true" />
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function AppearanceControls() {
  const { preferences, resolvedTheme, storageAvailable, updatePreferences, resetPreferences } = useAppearance()
  return (
    <div className="appearance-controls">
      <ChoiceGroup legend="Tema" value={preferences.theme} onChange={(theme) => updatePreferences({ theme })} options={[
        { value: 'dark', label: 'Scuro', icon: Moon },
        { value: 'light', label: 'Chiaro', icon: Sun },
        { value: 'system', label: 'Sistema', icon: Monitor },
      ]} />
      <ChoiceGroup legend="Colore di accento" value={preferences.accent} onChange={(accent) => updatePreferences({ accent })} options={[
        { value: 'mint', label: 'Menta', swatch: true },
        { value: 'sky', label: 'Cielo', swatch: true },
        { value: 'amber', label: 'Ambra', swatch: true },
      ]} />
      <ChoiceGroup legend="Densità" value={preferences.density} onChange={(density) => updatePreferences({ density })} options={[
        { value: 'comfortable', label: 'Comoda' },
        { value: 'compact', label: 'Compatta' },
      ]} />
      <div className="appearance-footer">
        <p className="appearance-note" role="status">
          {storageAvailable ? 'Preferenze salvate in questo browser.' : 'Preferenze attive per questa sessione: il browser non consente il salvataggio.'}
          {preferences.theme === 'system' ? ` Tema del sistema: ${resolvedTheme === 'dark' ? 'scuro' : 'chiaro'}.` : ''}
        </p>
        <button type="button" className="button button--ghost button--compact" onClick={resetPreferences}><RotateCcw aria-hidden="true" /> Ripristina aspetto</button>
      </div>
    </div>
  )
}

export function AppearanceSettings({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <Dialog.Root>
        <Dialog.Trigger className="button button--ghost button--compact appearance-trigger"><Palette aria-hidden="true" /><span>Aspetto</span></Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content appearance-dialog">
            <div className="dialog-heading">
              <div><Dialog.Title>Il tuo spazio di analisi</Dialog.Title><Dialog.Description>Scegli tema, colore e spaziatura. Le modifiche si applicano subito.</Dialog.Description></div>
              <Dialog.Close className="icon-button" aria-label="Chiudi impostazioni aspetto"><X aria-hidden="true" /></Dialog.Close>
            </div>
            <AppearanceControls />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    )
  }
  return (
    <Surface className="appearance-settings">
      <div className="section-heading"><div><p className="eyebrow"><Palette aria-hidden="true" /> Aspetto</p><h2>Il tuo spazio di analisi</h2></div></div>
      <p className="section-copy">Scegli tema, colore e spaziatura. Le modifiche si applicano subito.</p>
      <AppearanceControls />
    </Surface>
  )
}
