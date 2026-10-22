import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { FriendsResponseDto } from '../src/api/types'

const PATH = '/app/team/friends?min_games=1&queue=420'
const sortControls = [
  { name: 'Partite', field: 'games' },
  { name: 'Percentuale di vittorie osservata', field: 'winrate' },
  { name: 'Ultima partita', field: 'last_game' },
] as const

async function expectHitTestable(button: Locator) {
  // A clipped thead can still satisfy Playwright's visibility check. Check
  // ancestors and actual pointer targeting before giving its button focus.
  await expect.poll(() => button.evaluate((element) => {
    const clipped: string[] = []
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      if (style.clip !== 'auto' || style.clipPath !== 'none') clipped.push(`${parent.tagName}: ${style.clip}; ${style.clipPath}`)
    }
    return clipped
  })).toEqual([])
  await button.scrollIntoViewIfNeeded()
  const geometry = await button.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return {
      hit: hit !== null && (hit === element || element.contains(hit)),
      height: rect.height,
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
    }
  })
  expect(geometry.hit).toBe(true)
  expect(geometry.height).toBeGreaterThanOrEqual(44)
  expect(geometry.left).toBeGreaterThanOrEqual(0)
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1)
}

async function tabToControl(page: Page, region: Locator, table: Locator, index: number) {
  await region.focus()
  await expect(region).toBeFocused()
  for (let position = 0; position <= index; position += 1) {
    await page.keyboard.press('Tab')
    await expect(table.getByRole('button', { name: sortControls[position]!.name, exact: true })).toBeFocused()
  }
}

function nextSort(page: Page, field: string) {
  const current = (new URL(page.url()).searchParams.get('sort') ?? 'games:desc').split(',')
  const existing = current.find((item) => item.split(':')[0] === field)?.split(':')[1]
  const direction = existing === 'desc' ? 'asc' : 'desc'
  return { direction, value: [`${field}:${direction}`, ...current.filter((item) => item.split(':')[0] !== field)].join(',') }
}

for (const mobileWidth of [390, 320]) {
  test(`ordinamento compagni: controlli visibili e tastiera a ${mobileWidth}px e desktop dopo refresh @smoke`, async ({ page, browserName }, testInfo) => {
    const unexpectedWrites: string[] = []
    await page.route('https://ddragon.leagueoflegends.com/**', (route) => route.abort())
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.route('**/api/**', (route) => {
      if (route.request().method() === 'GET') return route.fallback()
      unexpectedWrites.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
      return route.abort()
    })
    await page.addInitScript(() => {
      localStorage.setItem('champion-fit-profile-accounts', JSON.stringify(['Alpha#EUW']))
      localStorage.setItem('champion-fit:data-view:v2', JSON.stringify({ view: 'list' }))
    })
    await page.setViewportSize({ width: mobileWidth, height: 844 })
    await page.goto(PATH)
    const region = page.getByRole('region', { name: 'Classifica dei compagni di squadra', exact: true })
    const table = region.getByRole('table')
    await expect(table.locator('tbody tr').first()).toBeVisible()

    for (const width of [mobileWidth, 1440]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 })
      await page.reload()
      await expect(table.locator('tbody tr').first()).toBeVisible()

      for (const { name } of sortControls) {
        const button = table.getByRole('button', { name, exact: true })
        await expect(button).not.toBeFocused()
        await expectHitTestable(button)
      }
      const headerFits = await table.locator('thead').evaluate((head) => head.scrollWidth <= head.clientWidth + 1)
      expect(headerFits).toBe(true)
      if (browserName === 'chromium' && width === mobileWidth) {
        const audit = await new AxeBuilder({ page }).include('.friends-ranking').withTags(['wcag2a', 'wcag2aa']).analyze()
        expect(audit.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))).toEqual([])
      }

      // Traverse all three controls with real Tab presses before any sorting.
      await tabToControl(page, region, table, sortControls.length - 1)

      for (let index = 0; index < sortControls.length; index += 1) {
        const control = sortControls[index]!
        const sort = nextSort(page, control.field)
        await tabToControl(page, region, table, index)
        const received = page.waitForResponse((response) => {
          const url = new URL(response.url())
          return response.request().method() === 'GET' && url.pathname === '/api/friends'
            && url.searchParams.get('sort') === sort.value
        })
        await page.keyboard.press('Enter')
        const response = await received
        expect(response.status()).toBe(200)
        const request = new URL(response.url())
        expect(request.searchParams.getAll('account')).toEqual(['Alpha#EUW'])
        expect(request.searchParams.get('min_shared_games')).toBe('1')
        expect(request.searchParams.get('queue')).toBe('420')
        const body = await response.json() as FriendsResponseDto
        expect(body.items.filter((item) => item.friend === 'DuoFriend#EUW')).toHaveLength(4)
        expect(new URL(page.url()).searchParams.get('sort')).toBe(sort.value)
        await expect(page.getByRole('combobox', { name: 'Ordine principale', exact: true })).toHaveValue(`${control.field}:${sort.direction}`)
        await expect(table.getByRole('columnheader', { name: control.name, exact: true })).toHaveAttribute('aria-sort', sort.direction === 'asc' ? 'ascending' : 'descending')
        await expect(table.locator('tbody tr td:last-child')).toHaveText(body.items.map((item) => new Date(item.last_game).toLocaleDateString('it-IT', { timeZone: 'UTC' })))
      }

      const persisted = new URL(page.url()).searchParams.get('sort')!
      const primary = persisted.split(',')[0]!
      const direction = primary.split(':')[1]
      await page.reload()
      await expect(table.locator('tbody tr').first()).toBeVisible()
      expect(new URL(page.url()).searchParams.get('sort')).toBe(persisted)
      await expect(page.getByRole('combobox', { name: 'Ordine principale', exact: true })).toHaveValue(primary)
      await expect(table.getByRole('columnheader', { name: 'Ultima partita', exact: true })).toHaveAttribute('aria-sort', direction === 'asc' ? 'ascending' : 'descending')
      for (const { name } of sortControls) await expectHitTestable(table.getByRole('button', { name, exact: true }))
      await page.screenshot({ path: testInfo.outputPath(`keyboard-sort-${width}.png`), fullPage: true })
      await table.locator('thead').screenshot({ path: testInfo.outputPath(`sort-controls-${width}.png`) })
    }
    expect(unexpectedWrites).toEqual([])
  })
}
