import './analytics.scss'

const ANALYTICS_KEY = 'localGuardianAnalytics'
const DEFAULT_RANGE = 30
const ALLOWED_RANGES = new Set([1, 7, 30, 90])

interface MetricTotals {
  analyzed: number
  toxic: number
  falsePositives: number
}

interface AnalyticsDay extends MetricTotals {
  domains: Record<string, MetricTotals>
  hours: Record<string, MetricTotals>
}

interface AnalyticsModel {
  days: Record<string, AnalyticsDay>
  totals: MetricTotals
  updatedAt: string | number | null
}

interface DatePoint extends MetricTotals {
  date: Date
  key: string
  domains: Record<string, MetricTotals>
  hours: Record<string, MetricTotals>
}

interface ChartPoint extends MetricTotals {
  label: string
  tableLabel: string
}

const loadingElement = requireElement<HTMLElement>('analyticsLoading')
const emptyElement = requireElement<HTMLElement>('analyticsEmpty')
const contentElement = requireElement<HTMLElement>('analyticsContent')
const analyzedElement = requireElement<HTMLElement>('summaryAnalyzed')
const toxicElement = requireElement<HTMLElement>('summaryToxic')
const rateElement = requireElement<HTMLElement>('summaryRate')
const rangeLabelElement = requireElement<HTMLElement>('summaryRange')
const chartElement = requireElement<HTMLElement>('historyChart')
const chartScrollElement = requireElement<HTMLElement>('chartScroll')
const chartTooltipElement = requireElement<HTMLElement>('chartTooltip')
const chartEmptyElement = requireElement<HTMLElement>('chartEmpty')
const historyTableElement = requireElement<HTMLElement>('historyTable')
const domainRowsElement = requireElement<HTMLTableSectionElement>('domainRows')
const domainEmptyElement = requireElement<HTMLElement>('domainEmpty')
const lifetimeElement = requireElement<HTMLElement>('lifetimeTotal')
const lastUpdatedElement = requireElement<HTMLElement>('lastUpdated')
const rangeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-range]'))

let selectedRange = DEFAULT_RANGE
let analytics: AnalyticsModel = emptyAnalytics()

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing required element: ${id}`)
  return element as T
}

function emptyTotals(): MetricTotals {
  return { analyzed: 0, toxic: 0, falsePositives: 0 }
}

function emptyAnalytics(): AnalyticsModel {
  return { days: {}, totals: emptyTotals(), updatedAt: null }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readCount(record: Record<string, unknown>, key: keyof MetricTotals): number {
  const aliases: Record<keyof MetricTotals, string[]> = {
    analyzed: ['analyzed', 'analyzedCount'],
    toxic: ['toxic', 'toxicCount'],
    falsePositives: ['falsePositives', 'falsePositiveCount'],
  }

  for (const candidate of aliases[key]) {
    const numeric = Number(record[candidate])
    if (Number.isFinite(numeric) && numeric >= 0) return Math.round(numeric)
  }
  return 0
}

function normalizeTotals(value: unknown): MetricTotals {
  const record = asRecord(value)
  return {
    analyzed: readCount(record, 'analyzed'),
    toxic: readCount(record, 'toxic'),
    falsePositives: readCount(record, 'falsePositives'),
  }
}

function addTotals(target: MetricTotals, source: MetricTotals): void {
  target.analyzed += source.analyzed
  target.toxic += source.toxic
  target.falsePositives += source.falsePositives
}

function isDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime())
}

function normalizeAnalytics(value: unknown): AnalyticsModel {
  const source = asRecord(value)
  const sourceDays = asRecord(source.days)
  const days: Record<string, AnalyticsDay> = {}
  const derivedTotals = emptyTotals()

  for (const [date, dayValue] of Object.entries(sourceDays)) {
    if (!isDateKey(date)) continue
    const dayRecord = asRecord(dayValue)
    const totals = normalizeTotals(dayRecord)
    const domains: Record<string, MetricTotals> = {}
    const hours: Record<string, MetricTotals> = {}

    for (const [domain, domainValue] of Object.entries(asRecord(dayRecord.domains))) {
      const normalizedDomain = domain.trim().toLowerCase()
      if (!normalizedDomain) continue
      domains[normalizedDomain] = normalizeTotals(domainValue)
    }

    for (const [hour, hourValue] of Object.entries(asRecord(dayRecord.hours))) {
      if (!/^(?:0\d|1\d|2[0-3])$/.test(hour)) continue
      hours[hour] = normalizeTotals(hourValue)
    }

    days[date] = { ...totals, domains, hours }
    addTotals(derivedTotals, totals)
  }

  const suppliedTotalsRecord = asRecord(source.totals)
  const suppliedTotals = normalizeTotals(suppliedTotalsRecord)
  const totals: MetricTotals = {
    analyzed: 'analyzed' in suppliedTotalsRecord || 'analyzedCount' in suppliedTotalsRecord
      ? suppliedTotals.analyzed
      : derivedTotals.analyzed,
    toxic: 'toxic' in suppliedTotalsRecord || 'toxicCount' in suppliedTotalsRecord
      ? suppliedTotals.toxic
      : derivedTotals.toxic,
    falsePositives:
      'falsePositives' in suppliedTotalsRecord || 'falsePositiveCount' in suppliedTotalsRecord
        ? suppliedTotals.falsePositives
        : derivedTotals.falsePositives,
  }

  const updatedAt =
    typeof source.updatedAt === 'string' || typeof source.updatedAt === 'number' ? source.updatedAt : null

  return { days, totals, updatedAt }
}

function readAnalytics(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(ANALYTICS_KEY, (result) => {
      const error = chrome.runtime.lastError
      if (error) {
        reject(new Error(error.message))
        return
      }
      resolve(result[ANALYTICS_KEY])
    })
  })
}

function toDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function pointsForRange(model: AnalyticsModel, range: number): DatePoint[] {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const points: DatePoint[] = []

  for (let offset = range - 1; offset >= 0; offset -= 1) {
    const date = new Date(today)
    date.setDate(today.getDate() - offset)
    const key = toDateKey(date)
    const day = model.days[key]
    points.push({
      date,
      key,
      analyzed: day?.analyzed ?? 0,
      toxic: day?.toxic ?? 0,
      falsePositives: day?.falsePositives ?? 0,
      domains: day?.domains ?? {},
      hours: day?.hours ?? {},
    })
  }

  return points
}

function aggregatePoints(points: DatePoint[]): MetricTotals {
  const totals = emptyTotals()
  for (const point of points) addTotals(totals, point)
  return totals
}

function hasAnyActivity(model: AnalyticsModel): boolean {
  if (model.totals.analyzed || model.totals.toxic || model.totals.falsePositives) return true
  return Object.values(model.days).some(
    (day) =>
      day.analyzed > 0 ||
      day.toxic > 0 ||
      day.falsePositives > 0 ||
      Object.keys(day.domains).length > 0,
  )
}

function formatNumber(value: number): string {
  return value.toLocaleString()
}

function formatDayLabel(date: Date, includeMonth: boolean): string {
  return new Intl.DateTimeFormat(undefined, includeMonth ? { month: 'short', day: 'numeric' } : { day: 'numeric' }).format(
    date,
  )
}

function rangeLabel(range: number): string {
  return range === 1 ? 'Today' : `Last ${range} days`
}

function formatHourLabel(hour: number): string {
  const date = new Date()
  date.setHours(hour, 0, 0, 0)
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(date)
}

function chartPointsForSelection(points: DatePoint[]): ChartPoint[] {
  if (selectedRange !== 1) {
    return points.map((point) => ({
      analyzed: point.analyzed,
      toxic: point.toxic,
      falsePositives: point.falsePositives,
      label: formatDayLabel(point.date, true),
      tableLabel: point.date.toLocaleDateString(),
    }))
  }

  const hours = points[0]?.hours ?? {}
  return Array.from({ length: 24 }, (_, hour) => {
    const totals = hours[String(hour).padStart(2, '0')] ?? emptyTotals()
    return {
      ...totals,
      label: formatHourLabel(hour),
      tableLabel: formatHourLabel(hour),
    }
  })
}

function chartDetail(point: ChartPoint): string {
  return `${point.label}: ${formatNumber(point.analyzed)} analyzed, ${formatNumber(point.toxic)} hidden`
}

function showChartTooltip(point: ChartPoint, target: HTMLElement): void {
  chartTooltipElement.textContent = chartDetail(point)
  chartTooltipElement.hidden = false

  const targetRect = target.getBoundingClientRect()
  const tooltipRect = chartTooltipElement.getBoundingClientRect()
  const horizontalPadding = 10
  const left = Math.min(
    Math.max(horizontalPadding, targetRect.left + targetRect.width / 2 - tooltipRect.width / 2),
    window.innerWidth - tooltipRect.width - horizontalPadding,
  )
  const top = Math.max(horizontalPadding, targetRect.top - tooltipRect.height - 8)
  chartTooltipElement.style.left = `${Math.round(left)}px`
  chartTooltipElement.style.top = `${Math.round(top)}px`
}

function hideChartTooltip(): void {
  chartTooltipElement.hidden = true
}

function renderSummary(points: DatePoint[]): void {
  const totals = aggregatePoints(points)
  const rate = totals.analyzed > 0 ? (totals.toxic / totals.analyzed) * 100 : 0

  analyzedElement.textContent = formatNumber(totals.analyzed)
  toxicElement.textContent = formatNumber(totals.toxic)
  rangeLabelElement.textContent = rangeLabel(selectedRange)
  rateElement.textContent = `${rate.toLocaleString(undefined, { maximumFractionDigits: 1 })}% of analyzed content`
  lifetimeElement.textContent = `${formatNumber(analytics.totals.analyzed)} analyzed all time`
}

function renderChart(points: DatePoint[]): void {
  const chartPoints = chartPointsForSelection(points)
  const maximum = Math.max(0, ...chartPoints.flatMap((point) => [point.analyzed, point.toxic]))
  chartElement.replaceChildren()
  historyTableElement.replaceChildren()
  hideChartTooltip()

  const hasRangeActivity = chartPoints.some(
    (point) => point.analyzed > 0 || point.toxic > 0,
  )
  const hasTodayTotalsWithoutHourlyDetail =
    selectedRange === 1 &&
    !hasRangeActivity &&
    Boolean(points[0] && (points[0].analyzed || points[0].toxic))
  chartEmptyElement.hidden = hasRangeActivity
  chartEmptyElement.textContent = hasTodayTotalsWithoutHourlyDetail
    ? 'Hourly activity begins after this update. Today’s total is shown above.'
    : 'No activity was recorded in this date range.'
  chartScrollElement.hidden = !hasRangeActivity

  if (!hasRangeActivity) return

  chartElement.setAttribute(
    'aria-label',
    selectedRange === 1 ? 'Hourly Hushfern protection activity for today' : 'Daily Hushfern protection activity',
  )
  chartElement.style.setProperty('--day-count', String(chartPoints.length))
  chartElement.style.setProperty('--chart-min-width', selectedRange === 90 ? '1040px' : selectedRange === 30 ? '680px' : '100%')

  const labelInterval = selectedRange === 1 ? 3 : selectedRange === 90 ? 14 : selectedRange === 30 ? 5 : 1
  for (const [index, point] of chartPoints.entries()) {
    const column = document.createElement('div')
    column.className = 'day-column'
    column.dataset.label = index % labelInterval === 0 || index === chartPoints.length - 1 ? point.label : ''
    column.tabIndex = 0
    column.setAttribute('role', 'img')
    column.setAttribute('aria-label', chartDetail(point))
    column.title = chartDetail(point)
    column.addEventListener('mouseenter', () => showChartTooltip(point, column))
    column.addEventListener('mouseleave', hideChartTooltip)
    column.addEventListener('focus', () => showChartTooltip(point, column))
    column.addEventListener('blur', hideChartTooltip)

    const analyzedBar = document.createElement('span')
    analyzedBar.className = 'chart-bar chart-bar-analyzed'
    analyzedBar.style.setProperty('--bar-height', maximum > 0 ? `${(point.analyzed / maximum) * 100}%` : '0%')

    const toxicBar = document.createElement('span')
    toxicBar.className = 'chart-bar chart-bar-toxic'
    toxicBar.style.setProperty('--bar-height', maximum > 0 ? `${(point.toxic / maximum) * 100}%` : '0%')

    column.append(analyzedBar, toxicBar)
    chartElement.append(column)
  }

  const accessibleTable = document.createElement('table')
  const caption = document.createElement('caption')
  caption.textContent = `Hushfern activity for ${rangeLabel(selectedRange).toLowerCase()}`
  const head = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const label of [selectedRange === 1 ? 'Time' : 'Date', 'Analyzed', 'Hidden']) {
    const cell = document.createElement('th')
    cell.scope = 'col'
    cell.textContent = label
    headRow.append(cell)
  }
  head.append(headRow)

  const body = document.createElement('tbody')
  for (const point of chartPoints) {
    const row = document.createElement('tr')
    const values = [point.tableLabel, point.analyzed, point.toxic]
    for (const [index, value] of values.entries()) {
      const cell = document.createElement(index === 0 ? 'th' : 'td')
      if (index === 0) (cell as HTMLTableCellElement).scope = 'row'
      cell.textContent = String(value)
      row.append(cell)
    }
    body.append(row)
  }

  accessibleTable.append(caption, head, body)
  historyTableElement.append(accessibleTable)
}

function renderDomains(points: DatePoint[]): void {
  const domains = new Map<string, MetricTotals>()
  for (const point of points) {
    for (const [domain, totals] of Object.entries(point.domains)) {
      const aggregate = domains.get(domain) ?? emptyTotals()
      addTotals(aggregate, totals)
      domains.set(domain, aggregate)
    }
  }

  const sorted = [...domains.entries()]
    .filter(([, totals]) => totals.analyzed || totals.toxic)
    .sort(([, left], [, right]) => right.toxic - left.toxic || right.analyzed - left.analyzed)
    .slice(0, 10)

  domainRowsElement.replaceChildren()
  domainEmptyElement.hidden = sorted.length > 0
  domainRowsElement.closest('table')!.hidden = sorted.length === 0

  for (const [domain, totals] of sorted) {
    const row = document.createElement('tr')
    for (const [index, value] of [domain, totals.analyzed, totals.toxic].entries()) {
      const cell = document.createElement(index === 0 ? 'th' : 'td')
      if (index === 0) (cell as HTMLTableCellElement).scope = 'row'
      cell.textContent = typeof value === 'number' ? formatNumber(value) : value
      if (typeof value === 'string') cell.title = value
      row.append(cell)
    }
    domainRowsElement.append(row)
  }
}

function renderUpdatedAt(): void {
  if (analytics.updatedAt === null) {
    lastUpdatedElement.textContent = 'History updates automatically while this page is open.'
    return
  }

  const date = new Date(analytics.updatedAt)
  lastUpdatedElement.textContent = Number.isNaN(date.getTime())
    ? 'History updates automatically while this page is open.'
    : `Last updated ${date.toLocaleString()}`
}

function render(): void {
  loadingElement.hidden = true
  const hasActivity = hasAnyActivity(analytics)
  emptyElement.hidden = hasActivity
  contentElement.hidden = !hasActivity

  rangeButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.range) === selectedRange))
  })

  if (!hasActivity) return

  const points = pointsForRange(analytics, selectedRange)
  renderSummary(points)
  renderChart(points)
  renderDomains(points)
  renderUpdatedAt()
}

async function initialize(): Promise<void> {
  try {
    analytics = normalizeAnalytics(await readAnalytics())
    render()
  } catch (error) {
    console.error('[Hushfern Analytics] Could not load analytics:', error)
    loadingElement.textContent = 'Your local history could not be loaded. Refresh this page to try again.'
  }
}

for (const button of rangeButtons) {
  button.addEventListener('click', () => {
    const nextRange = Number(button.dataset.range)
    if (!ALLOWED_RANGES.has(nextRange) || nextRange === selectedRange) return
    selectedRange = nextRange
    render()
  })
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return
  if (changes[ANALYTICS_KEY]) {
    analytics = normalizeAnalytics(changes[ANALYTICS_KEY].newValue)
    render()
  }
})

void initialize()
