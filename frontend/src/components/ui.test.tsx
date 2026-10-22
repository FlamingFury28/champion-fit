import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect, useState } from 'react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChampionAvatar, DataTable, Drawer, EmptyState, ErrorState, EvidenceBar, Modal, Skeleton, StatusBadge } from './ui'

function FocusHarness({ initialOpen = false, navigate = false, removeOpener = false, unavailableOpener = '' }) {
  const [open, setOpen] = useState(initialOpen)
  const [closed, setClosed] = useState(false)
  useEffect(() => {
    if (closed && navigate) document.getElementById('destination')?.focus()
  }, [closed, navigate])
  return <main id="main-content" tabIndex={-1}>
    {!(closed && removeOpener) ? <button type="button" hidden={closed && unavailableOpener === 'hidden'} disabled={closed && unavailableOpener === 'disabled'} style={closed && unavailableOpener === 'invisible' ? { visibility: 'hidden' } : undefined} onClick={() => setOpen(true)}>Apri scheda</button> : null}
    <button id="destination" type="button">Nuova pagina</button>
    <Drawer open={open} onOpenChange={(next) => { setOpen(next); if (!next) setClosed(true) }} title="Scheda" description="Dettagli"><input aria-label="Nota" /></Drawer>
  </main>
}

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

  it('mantiene il fallback per l’URL fallito e riprova una nuova icona con il nome aggiornato', () => {
    const { rerender } = render(<ChampionAvatar name="Ahri" src="/old-patch/Ahri.png" />)
    const originalImage = screen.getByRole('img', { name: 'Ahri' }).querySelector('img')!
    fireEvent.error(originalImage)
    expect(screen.getByRole('img', { name: 'Ahri' }).querySelector('img')).toBeNull()
    expect(screen.getByText('A')).toBeVisible()

    rerender(<ChampionAvatar name="Ahri" src="/old-patch/Ahri.png" />)
    expect(screen.getByRole('img', { name: 'Ahri' }).querySelector('img')).toBeNull()

    rerender(<ChampionAvatar name="Wukong" src="/new-patch/MonkeyKing.png" />)
    expect(screen.getByRole('img', { name: 'Wukong' }).querySelector('img')).toHaveAttribute('src', '/new-patch/MonkeyKing.png')
    expect(screen.queryByRole('img', { name: 'Ahri' })).not.toBeInTheDocument()
    expect(screen.queryByText('A')).not.toBeInTheDocument()
  })

  it('chiude il dialog con il controllo nominato', async () => {
    const onOpenChange = vi.fn()
    render(<Modal open onOpenChange={onOpenChange} title="Conferma"><button type="button">Azione</button></Modal>)
    expect(screen.getByRole('dialog', { name: 'Conferma' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Chiudi' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('restituisce il focus al controllo che ha aperto il drawer', async () => {
    const user = userEvent.setup()
    render(<FocusHarness />)
    const opener = screen.getByRole('button', { name: 'Apri scheda' })
    await user.click(opener)
    await user.click(screen.getByRole('button', { name: 'Chiudi' }))
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('rispetta il focus scelto dalla navigazione dopo la chiusura', async () => {
    const user = userEvent.setup()
    render(<FocusHarness navigate />)
    await user.click(screen.getByRole('button', { name: 'Apri scheda' }))
    await user.click(screen.getByRole('button', { name: 'Chiudi' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Nuova pagina' })).toHaveFocus())
  })

  it.each(['hidden', 'invisible', 'disabled'])('usa il contenuto principale se l’opener diventa %s mentre il drawer è aperto', async (unavailableOpener) => {
    const user = userEvent.setup()
    render(<FocusHarness unavailableOpener={unavailableOpener} />)
    await user.click(screen.getByRole('button', { name: 'Apri scheda' }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(document.getElementById('main-content')).toHaveFocus())
  })

  it.each([true, false])('usa il contenuto principale se manca un opener valido (link diretto: %s)', async (initialOpen) => {
    const user = userEvent.setup()
    render(<FocusHarness initialOpen={initialOpen} removeOpener />)
    if (!initialOpen) await user.click(screen.getByRole('button', { name: 'Apri scheda' }))
    await user.click(screen.getByRole('button', { name: 'Chiudi' }))
    await waitFor(() => expect(document.getElementById('main-content')).toHaveFocus())
  })
})
