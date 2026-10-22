import { act, cleanup, configure, getConfig, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppToastProvider, useToast } from './toast'

const defaultAsyncWrapper = getConfig().asyncWrapper

function NotificationActions() {
  const { notify } = useToast()
  return <>
    <button type="button" onClick={() => {
      for (let index = 1; index <= 6; index += 1) {
        notify(`Operazione ${index}`, {
          description: `Risultato da leggere per l’operazione ${index}. La bozza rimane disponibile.`,
          tone: index === 3 || index === 6 ? 'error' : 'success',
        })
      }
    }}>Sei operazioni</button>
    {['Prima', 'Seconda', 'Terza'].map((title) => <button key={title} type="button" onClick={() => notify(title, { description: `Dettagli ${title}` })}>Notifica {title}</button>)}
    <button type="button" onClick={() => notify('Salvataggio non riuscito', { description: 'Un errore da leggere senza perdere il controllo della pagina. '.repeat(100), tone: 'error' })}>Errore lungo</button>
    <button type="button">Rinomina gruppo</button>
  </>
}

function renderNotifications() {
  const user = userEvent.setup({ advanceTimers: async (delay) => { await vi.advanceTimersByTimeAsync(delay) } })
  render(<AppToastProvider><NotificationActions /></AppToastProvider>)
  return user
}

function notifications() {
  return within(screen.getByRole('region', { name: 'Notifiche (F8)' }))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-17T12:00:00Z'))
  // Testing Library's default microtask drain waits for a real timer; keep
  // user interactions inside act while this test deliberately pauses time.
  configure({ asyncWrapper: async (callback) => { return await act(callback) } })
  Object.defineProperty(HTMLElement.prototype, 'hasPointerCapture', { configurable: true, value: () => false })
})

afterEach(() => {
  cleanup()
  configure({ asyncWrapper: defaultAsyncWrapper })
  Reflect.deleteProperty(HTMLElement.prototype, 'hasPointerCapture')
  vi.useRealTimers()
})

describe('notifiche accessibili durante operazioni successive', () => {
  it('limita la pila anche quando il puntatore sospende la scadenza', async () => {
    const user = renderNotifications()
    await user.click(screen.getByRole('button', { name: 'Sei operazioni' }))
    await user.hover(notifications().getByRole('list'))
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })

    expect(notifications().getAllByRole('button', { name: 'Chiudi notifica' })).toHaveLength(1)
    expect(notifications().getByText('Operazione 1')).toBeVisible()
  })

  it('conserva ogni risultato, compresi gli errori, fino alla sua presentazione', async () => {
    const user = renderNotifications()
    await user.click(screen.getByRole('button', { name: 'Sei operazioni' }))

    for (let index = 1; index <= 6; index += 1) {
      expect(notifications().getByText(`Operazione ${index}`)).toBeVisible()
      expect(notifications().getByRole('listitem')).toHaveAttribute('data-tone', index === 3 || index === 6 ? 'error' : 'success')
      expect(notifications().getAllByRole('button', { name: 'Chiudi notifica' })).toHaveLength(1)
      const remaining = 6 - index
      if (remaining) expect(notifications().getByText(`${remaining} ${remaining === 1 ? 'notifica in attesa' : 'notifiche in attesa'}`)).toBeVisible()
      else expect(notifications().queryByText(/notific.*in attesa/)).not.toBeInTheDocument()
      await user.click(notifications().getByRole('button', { name: 'Chiudi notifica' }))
    }
    expect(notifications().queryByRole('button', { name: 'Chiudi notifica' })).not.toBeInTheDocument()
  })

  it('chiude soltanto la notifica scelta dopo rimozione e aggiunta nello stesso millisecondo', async () => {
    const user = renderNotifications()
    await user.click(screen.getByRole('button', { name: 'Notifica Prima' }))
    await user.click(screen.getByRole('button', { name: 'Notifica Seconda' }))
    const first = notifications().getByText('Prima').closest('li')!
    await user.click(within(first).getByRole('button', { name: 'Chiudi notifica' }))
    await user.click(screen.getByRole('button', { name: 'Notifica Terza' }))
    const second = notifications().getByText('Seconda').closest('li')!
    await user.click(within(second).getByRole('button', { name: 'Chiudi notifica' }))

    expect(notifications().getByText('Terza')).toBeVisible()
    expect(notifications().queryByText('Seconda')).not.toBeInTheDocument()
  })

  it('avvia la scadenza della notifica successiva solo quando viene mostrata', async () => {
    const user = renderNotifications()
    await user.click(screen.getByRole('button', { name: 'Notifica Prima' }))
    await user.click(screen.getByRole('button', { name: 'Notifica Seconda' }))
    await user.hover(notifications().getByRole('list'))
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    await user.unhover(notifications().getByRole('list'))
    await act(async () => { await vi.advanceTimersByTimeAsync(4200) })

    expect(notifications().queryByText('Prima')).not.toBeInTheDocument()
    expect(notifications().getByText('Seconda')).toBeVisible()
    await act(async () => { await vi.advanceTimersByTimeAsync(4199) })
    expect(notifications().getByText('Seconda')).toBeVisible()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(notifications().queryByText('Seconda')).not.toBeInTheDocument()
  })

  it('consente di raggiungere le notifiche con F8 e chiuderle con Escape', async () => {
    const user = renderNotifications()
    await user.click(screen.getByRole('button', { name: 'Notifica Prima' }))
    await user.click(screen.getByRole('button', { name: 'Notifica Seconda' }))
    await user.keyboard('[F8]{Tab}')
    const first = notifications().getByText('Prima').closest('li')!
    expect(first).toContainElement(document.activeElement as HTMLElement)
    await user.keyboard('{Escape}')

    expect(notifications().queryByText('Prima')).not.toBeInTheDocument()
    expect(notifications().getByText('Seconda')).toBeVisible()
    await user.click(notifications().getByRole('button', { name: 'Chiudi notifica' }))
    expect(notifications().queryByRole('button', { name: 'Chiudi notifica' })).not.toBeInTheDocument()
  })

  it('rende i dettagli lunghi raggiungibili da tastiera lasciando accessibile la chiusura', async () => {
    const user = renderNotifications()
    await user.click(screen.getByRole('button', { name: 'Errore lungo' }))
    await user.keyboard('[F8]{Tab}{Tab}')

    expect(notifications().getByRole('region', { name: 'Dettagli della notifica' })).toHaveFocus()
    expect(notifications().getByText('Salvataggio non riuscito')).toBeVisible()
    await user.keyboard('{Tab}')
    expect(notifications().getByRole('button', { name: 'Chiudi notifica' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(notifications().queryByText('Salvataggio non riuscito')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Rinomina gruppo' }))
    expect(screen.getByRole('button', { name: 'Rinomina gruppo' })).toHaveFocus()
  })
})
