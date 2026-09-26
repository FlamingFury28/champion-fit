import { Dialog, Tooltip } from 'radix-ui'
import { AlertTriangle, ImageOff, RefreshCw, X } from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
  type TableHTMLAttributes,
} from 'react'

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

export function Surface({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={cn('surface', className)} {...props} />
}

export function MetricCard({
  label,
  value,
  detail,
  tone = 'positive',
}: {
  label: string
  value: ReactNode
  detail?: ReactNode
  tone?: 'positive' | 'warning' | 'negative' | 'info' | 'neutral'
}) {
  return (
    <article className="metric-card" data-tone={tone}>
      <p>{label}</p>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </article>
  )
}

export function DecisionSummary({
  answer,
  detail,
  status,
  tone = 'positive',
  action,
}: {
  answer: ReactNode
  detail: ReactNode
  status: string
  tone?: 'positive' | 'warning' | 'negative' | 'info' | 'neutral'
  action?: ReactNode
}) {
  return (
    <section className="decision-summary" data-tone={tone} aria-live="polite">
      <div className="decision-summary__label">
        <span>Risposta attuale</span>
        <StatusBadge tone={tone}>{status}</StatusBadge>
      </div>
      <h2>{answer}</h2>
      <p>{detail}</p>
      {action ? <div className="decision-summary__action">{action}</div> : null}
    </section>
  )
}

export function FilterBar({ children, className }: PropsWithChildren<{ className?: string }>) {
  return <div className={cn('filter-bar', className)}>{children}</div>
}

export function QueryResults({ label, className, ...props }: HTMLAttributes<HTMLDivElement> & { label: string }) {
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Async results can overflow and must remain keyboard-scrollable.
    <div {...props} className={cn('query-results', className)} role="region" aria-label={label} tabIndex={0} />
  )
}

export function DataTable({ label = 'Tabella dati', ...props }: TableHTMLAttributes<HTMLTableElement> & { label?: string }) {
  const tableRef = useRef<HTMLTableElement>(null)

  useEffect(() => {
    const table = tableRef.current
    const headerRow = table?.tHead?.rows[0]
    if (!table || !headerRow) return

    const labels = Array.from(headerRow.cells, (cell) => cell.textContent?.trim() ?? '')
    for (const body of Array.from(table.tBodies)) {
      for (const row of Array.from(body.rows)) {
        Array.from(row.cells).forEach((cell, index) => {
          const columnLabel = labels[index]
          if (columnLabel) cell.dataset.label = columnLabel
        })
      }
    }
  }, [props.children])

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- A scrollable data region must be reachable from the keyboard.
    <div className="data-table-wrap" role="region" aria-label={label} tabIndex={0}>
      <table ref={tableRef} {...props} />
    </div>
  )
}

export function StatusBadge({
  children,
  tone = 'neutral',
}: PropsWithChildren<{ tone?: 'positive' | 'warning' | 'negative' | 'info' | 'neutral' }>) {
  return <span className="status-badge" data-tone={tone}>{children}</span>
}

export function EvidenceBar({
  value,
  label,
  secondary,
}: {
  value: number
  label: string
  secondary?: string
}) {
  const bounded = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
  return (
    <div className="evidence-bar">
      <div className="evidence-bar__label">
        <span>{label}</span>
        {secondary ? <small>{secondary}</small> : null}
      </div>
      <div
        className="evidence-bar__rail"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(bounded)}
      >
        <span style={{ width: `${bounded}%` }} />
      </div>
    </div>
  )
}

export function ChampionAvatar({ name, src, size = 'md' }: { name: string; src?: string; size?: 'sm' | 'md' | 'lg' }) {
  const [failed, setFailed] = useState(false)
  const initials = name.replace(/[^A-Z]/g, '').slice(0, 2) || name.slice(0, 2).toUpperCase()
  return (
    <span className="champion-avatar" data-size={size} role="img" aria-label={name}>
      {src && !failed ? (
        <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span aria-hidden="true">{initials || <ImageOff size={14} />}</span>
      )}
    </span>
  )
}

export function Skeleton({ lines = 3, label = 'Caricamento' }: { lines?: number; label?: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      {Array.from({ length: lines }).map((_, index) => <span key={index} />)}
    </div>
  )
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="state-card state-card--empty">
      <span aria-hidden="true">Ø</span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {action}
    </div>
  )
}

export function ErrorState({ title = 'Impossibile caricare i dati', error, onRetry }: { title?: string; error: Error; onRetry?: () => void }) {
  return (
    <div className="state-card state-card--error" role="alert">
      <AlertTriangle aria-hidden="true" />
      <div>
        <h2>{title}</h2>
        <p>{error.message}</p>
      </div>
      {onRetry ? (
        <button className="button button--secondary" type="button" onClick={onRetry}>
          <RefreshCw size={15} aria-hidden="true" /> Riprova
        </button>
      ) : null}
    </div>
  )
}

export function RefreshNotice({ children }: PropsWithChildren) {
  return (
    <div className="scope-refresh-banner" role="status" aria-live="polite">
      <RefreshCw aria-hidden="true" />
      <span>{children}</span>
    </div>
  )
}

interface OverlayProps extends PropsWithChildren {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
}

export function Modal({ open, onOpenChange, title, description, children }: OverlayProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <div className="dialog-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description ? <Dialog.Description>{description}</Dialog.Description> : null}
            </div>
            <Dialog.Close className="icon-button" aria-label="Chiudi">
              <X aria-hidden="true" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function Drawer({ open, onOpenChange, title, description, children, wide = false }: OverlayProps & { wide?: boolean }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className={`drawer-content${wide ? ' drawer-content--wide' : ''}`}>
          <div className="dialog-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description ? <Dialog.Description>{description}</Dialog.Description> : null}
            </div>
            <Dialog.Close className="icon-button" aria-label="Chiudi">
              <X aria-hidden="true" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function InfoTooltip({ label, children }: PropsWithChildren<{ label: string }>) {
  return (
    <Tooltip.Provider delayDuration={250}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tooltip-content" sideOffset={8}>
            {label}
            <Tooltip.Arrow className="tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}

export function PageHeader({ eyebrow, title, copy, aside, level = 1 }: { eyebrow: string; title: ReactNode; copy: string; aside?: ReactNode; level?: 1 | 2 }) {
  const Heading = level === 2 ? 'h2' : 'h1'
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <Heading>{title}</Heading>
        <p className="page-header__copy">{copy}</p>
      </div>
      {aside ? <aside>{aside}</aside> : null}
    </header>
  )
}
