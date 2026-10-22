import { describe, expect, it } from 'vitest'
import { stripPythonWhitespace } from './python-text'

describe('strip Python condiviso', () => {
  const whitespace = [
    ...Array.from({ length: 5 }, (_, index) => String.fromCodePoint(9 + index)),
    ...Array.from({ length: 5 }, (_, index) => String.fromCodePoint(28 + index)),
    '\u0085', '\u00a0', '\u1680',
    ...Array.from({ length: 11 }, (_, index) => String.fromCodePoint(0x2000 + index)),
    '\u2028', '\u2029', '\u202f', '\u205f', '\u3000',
  ]

  it.each(whitespace)('rimuove %j soltanto dai margini', (value) => {
    expect(stripPythonWhitespace(`${value}utility${value}`)).toBe('utility')
    expect(stripPythonWhitespace(`${value}${value}`)).toBe('')
    expect(stripPythonWhitespace(`A${value}B`)).toBe(`A${value}B`)
  })

  it.each(['\ufeff', '\u200b', '\u180e'])('preserva il carattere non whitespace Python %j', (value) => {
    expect(stripPythonWhitespace(` ${value}utility${value} `)).toBe(`${value}utility${value}`)
  })

  it('mantiene stringhe vuote, testo e spazi interni senza altre normalizzazioni', () => {
    expect(stripPythonWhitespace('')).toBe('')
    expect(stripPythonWhitespace(' \tÉquipe  A\nB\u0085')).toBe('Équipe  A\nB')
    expect(stripPythonWhitespace('E\u0301quipe')).toBe('E\u0301quipe')
  })
})
