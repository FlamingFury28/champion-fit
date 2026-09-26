import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AlgorithmSettingSchemaDto } from '../api/types'
import { SettingControl } from './AlgorithmSettingsPage'

const lossWeights: AlgorithmSettingSchemaDto = {
  path: 'attribution.loss_weights',
  label: 'Pesi delle sconfitte',
  description: 'Un peso per ogni fascia di durata.',
  type: 'number[]',
  group: 'Attribuzione',
}

const historyPeriod: AlgorithmSettingSchemaDto = {
  path: 'history.period',
  label: 'Periodo storico',
  description: 'Limite delle partite analizzate.',
  type: 'period',
  group: 'Contesto',
  min: 0,
  max: 100000,
  options: ['days', 'games'],
}

describe('controlli impostazioni algoritmi', () => {
  it('mantiene una frazione digitabile e la applica alla perdita di focus', async () => {
    const onChange = vi.fn()
    render(<SettingControl field={lossWeights} value={[1, 1]} onChange={onChange} />)
    const input = screen.getByRole('textbox', { name: 'Pesi delle sconfitte' })
    expect(input).toHaveAttribute('aria-describedby', expect.stringContaining('description'))
    await userEvent.clear(input)
    await userEvent.type(input, '0.25, 1')
    expect(input).toHaveValue('0.25, 1')
    expect(onChange).not.toHaveBeenCalled()
    await userEvent.tab()
    expect(onChange).toHaveBeenCalledWith([0.25, 1])
  })

  it('scarta una bozza del periodo quando il reset torna a un valore precedente', async () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <SettingControl resetKey={0} field={historyPeriod} value={{ value: 180, unit: 'days' }} onChange={onChange} />,
    )
    const input = screen.getByRole('spinbutton', { name: 'Periodo storico' })
    await userEvent.clear(input)
    await userEvent.type(input, '21')
    expect(input).toHaveValue(21)

    rerender(
      <SettingControl resetKey={1} field={historyPeriod} value={{ value: 90, unit: 'games' }} onChange={onChange} />,
    )
    expect(screen.getByRole('spinbutton', { name: 'Periodo storico' })).toHaveValue(90)
    expect(screen.getByRole('combobox', { name: 'Unità del periodo' })).toHaveValue('games')

    rerender(
      <SettingControl resetKey={2} field={historyPeriod} value={{ value: 180, unit: 'days' }} onChange={onChange} />,
    )
    expect(screen.getByRole('spinbutton', { name: 'Periodo storico' })).toHaveValue(180)
    expect(screen.getByRole('combobox', { name: 'Unità del periodo' })).toHaveValue('days')
  })
})
