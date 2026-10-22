import { stripPythonWhitespace } from './python-text'

const dayMilliseconds = 86_400_000

function utcDate(year: number, month: number, day: number) {
  const date = new Date(0)
  // Date.UTC would reinterpret years 0..99 as 1900..1999.
  date.setUTCFullYear(year, month - 1, day)
  return date
}

function canonicalDate(date: Date) {
  const year = date.getUTCFullYear()
  if (year < 1 || year > 9999) return ''
  return `${String(year).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

/** The date.fromisoformat forms accepted by the Friends API, as a date input value. */
export function normalizeDateFilter(raw: string | null | undefined): string {
  const value = stripPythonWhitespace(raw ?? '')
  const calendar = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(value)
  if (calendar) {
    const year = Number(calendar[1])
    const month = Number(calendar[2])
    const day = Number(calendar[3])
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return ''
    const date = utcDate(year, month, day)
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return ''
    return canonicalDate(date)
  }

  const weekDate = /^(\d{4})-W(\d{2})(?:-([1-7]))?$/.exec(value) ?? /^(\d{4})W(\d{2})([1-7])?$/.exec(value)
  if (!weekDate) return ''
  const year = Number(weekDate[1])
  const week = Number(weekDate[2])
  const weekday = Number(weekDate[3] ?? 1)
  if (year < 1 || week < 1 || week > 53) return ''
  // ISO week 1 contains January 4; a week belongs to its Thursday's year.
  const january4 = utcDate(year, 1, 4)
  const monday = january4.getTime() - ((january4.getUTCDay() || 7) - 1) * dayMilliseconds
  const date = new Date(monday + ((week - 1) * 7 + weekday - 1) * dayMilliseconds)
  const thursday = new Date(date.getTime() + (4 - weekday) * dayMilliseconds)
  return thursday.getUTCFullYear() === year ? canonicalDate(date) : ''
}
