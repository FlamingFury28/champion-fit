import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DataTable, EmptyState, ErrorState, EvidenceBar, Modal, Skeleton, StatusBadge } from './ui'

describe('componenti UI accessibili', () => {
  it('espone skeleton, empty ed error state con semantica esplicita', async () => {
    const retry = vi.fn()
    const { rerender } = render(<Skeleton label="Caricamento tabella" />)
    expect(screen.getByRole('status', { name: 'Caricamento tabella' })).toBeInTheDocument()
    rerender(<EmptyState title="Nessun dato" description="Sincronizza un account." />)
    expect(screen.getByRole('heading', { name: 'Nessun dato' })).toBeInTheDocument()
    rerender(<ErrorState error={new Error('offline')} onRetry={retry} />)
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('usa una tabella reale e un progressbar nominato', () => {
    render(<><DataTable label="Compatibilità dei campioni"><tbody><tr><th>Ahri</th><td>52%</td></tr></tbody></DataTable><EvidenceBar value={72} label="Evidenza" /><StatusBadge tone="positive">Validato</StatusBadge></>)
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Compatibilità dei campioni' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('progressbar', { name: 'Evidenza' })).toHaveAttribute('aria-valuenow', '72')
    expect(screen.getByText('Validato')).toHaveAttribute('data-tone', 'positive')
  })

  it('chiude il dialog con il controllo nominato', async () => {
    const onOpenChange = vi.fn()
    render(<Modal open onOpenChange={onOpenChange} title="Conferma"><button type="button">Azione</button></Modal>)
    expect(screen.getByRole('dialog', { name: 'Conferma' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Chiudi' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
