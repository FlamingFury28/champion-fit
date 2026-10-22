import { describe, expect, it } from 'vitest'
import { canonicalQueueFilter } from './queue-filter'

describe('canonicalQueueFilter', () => {
  it.each([
    ['NORMALDRAFT', '400'],
    ['NORMAL_DRAFT', '400'],
    ['DRAFTPICK', '400'],
    ['RANKEDSOLO', '420'],
    ['RANKEDSOLO/DUO', '420'],
    ['RANKED_SOLO_5X5', '420'],
    ['RANKEDFLEX', '440'],
    ['RANKED_FLEX_SR', '440'],
    ['NORMALBLIND', '430'],
    ['NORMAL_BLIND', '430'],
    ['NORMAL_BLIND_PICK', '430'],
    ['BLINDPICK', '430'],
    ['QUICKPLAY', '490'],
    ['NORMALQUICKPLAY', '490'],
    ['NORMAL_QUICKPLAY', '490'],
    ['normal draft', '400'],
    [' ranked solo/duo ', '420'],
    [' ranked_flex_sr ', '440'],
    [' Ranked Flex ', '440'],
    ['normal blind pick', 'NORMALBLINDPICK'],
    ['4 4 0', '440'],
    ['440', '440'],
    ['420', '420'],
    ['480', '480'],
    ['700', '700'],
    ['450', '450'],
    ['00440', '00440'],
    ['queue440', '440'],
    [' QUEUE 440 ', '440'],
  ])('follows the backend single-pass canonicalization for %j', (input, expected) => {
    expect(canonicalQueueFilter(input)).toBe(expected)
  })

  it.each([
    null, '', 'all',
  ])('preserves the distinct missing, empty and exact aggregate values: %j', (input) => {
    expect(canonicalQueueFilter(input)).toBe(input)
  })

  it.each([
    ['ALL', 'ALL'],
    [' all ', 'ALL'],
    ['All', 'ALL'],
    ['QUEUEall', 'ALL'],
    ['unknown', 'UNKNOWN'],
    ['SWIFTPLAY', 'SWIFTPLAY'],
    ['Clash', 'CLASH'],
    ['-440', '-440'],
    ['4.40', '4.40'],
    ['\ufeff440', '\ufeff440'],
    ['440\ufeff', '440\ufeff'],
    ['\ufeffall\ufeff', '\ufeffALL\ufeff'],
    ['RANKED\tFLEX', 'RANKED\tFLEX'],
    ['RANKED\u00a0FLEX', 'RANKED\u00a0FLEX'],
  ])('does not accept extra sentinels or aliases for %j', (input, expected) => {
    expect(canonicalQueueFilter(input)).toBe(expected)
    expect(canonicalQueueFilter(input)).not.toBe('all')
  })

  const pythonWhitespace = [
    ...Array.from({ length: 5 }, (_, index) => index + 9),
    ...Array.from({ length: 5 }, (_, index) => index + 28),
    133, 160, 5760,
    ...Array.from({ length: 11 }, (_, index) => index + 8192),
    8232, 8233, 8239, 8287, 12288,
  ]

  it.each(pythonWhitespace)('strips Python whitespace U+%i around valid queues', (point) => {
    const space = String.fromCodePoint(point)
    expect(canonicalQueueFilter(`${space}ranked_flex_sr${space}`)).toBe('440')
    expect(canonicalQueueFilter(`${space}440${space}`)).toBe('440')
    expect(canonicalQueueFilter(`${space}all${space}`)).toBe('ALL')
  })

  it.each([' ', '\u0085\u001c\u001f', 'QUEUE', ' queue ', 'QUE UE'])('keeps a nonempty invalid filter on the wire: %j', (input) => {
    expect(canonicalQueueFilter(input)).toBe(input)
  })

  it.each([
    'QUEUEQUEUE440',
    'QUEUERANKED_FLEX_SR',
    'QUEUENORMAL_DRAFT',
    'QUEUEQUEUEall',
    'QUEUENORMALBLIND',
    'QUEUEQUEUE',
    'QUE UEQUEUE440',
  ])('preserves %j instead of making a second backend normalization accept it', (input) => {
    expect(canonicalQueueFilter(input)).toBe(input)
  })
})
