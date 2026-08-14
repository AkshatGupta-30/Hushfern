import './popup.css'

const SETTINGS_KEY = 'localGuardianSettings'
const DEFAULT_SETTINGS: LocalGuardianSettings = {
  toxicityThreshold: 50,
  blurIntensity: 8,
}

interface LocalGuardianSettings {
  toxicityThreshold: number
  blurIntensity: number
}

interface PageStats {
  toxicCount: number
  analyzedCount: number
  hostname: string
  enabled: boolean
}

type ActivityState = 'loading' | 'active' | 'disabled' | 'unsupported' | 'unavailable' | 'error'

const toxicityInput = requireElement<HTMLInputElement>('toxicityThreshold')
const blurInput = requireElement<HTMLInputElement>('blurIntensity')
const toxicityValue = requireElement<HTMLOutputElement>('toxicityValue')
const blurValue = requireElement<HTMLOutputElement>('blurValue')
const settingsStatus = requireElement<HTMLElement>('settingsStatus')
const pageActivity = requireElement<HTMLElement>('pageActivity')
const pageStatus = requireElement<HTMLElement>('pageStatus')
const activityTitle = requireElement<HTMLElement>('activity-title')
const activityCounts = requireElement<HTMLElement>('activityCounts')
const activityMessage = requireElement<HTMLElement>('activityMessage')
const hostnameElement = requireElement<HTMLElement>('hostname')
const toxicCountElement = requireElement<HTMLElement>('toxicCount')
const analyzedCountElement = requireElement<HTMLElement>('analyzedCount')
const refreshButton = requireElement<HTMLButtonElement>('refreshStats')
const analyticsButton = requireElement<HTMLButtonElement>('openAnalytics')
const resumeButton = requireElement<HTMLButtonElement>('resumeProtection')

let currentSettings = { ...DEFAULT_SETTINGS }
let activeTabId: number | undefined
let pendingSettingsWrites = 0
let activeSettingsWrite = false
let latestPendingSettings: LocalGuardianSettings | null = null

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing required element: ${id}`)
  return element as T
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

function normalizeSettings(value: unknown): LocalGuardianSettings {
  const stored = value && typeof value === 'object' ? (value as Partial<LocalGuardianSettings>) : {}
  return {
    toxicityThreshold: clampInteger(stored.toxicityThreshold, 40, 80, DEFAULT_SETTINGS.toxicityThreshold),
    blurIntensity: clampInteger(stored.blurIntensity, 3, 10, DEFAULT_SETTINGS.blurIntensity),
  }
}

function readLocalStorage(key: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      const error = chrome.runtime.lastError
      if (error) {
        reject(new Error(error.message))
        return
      }
      resolve(result)
    })
  })
}

function writeLocalStorage(value: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      const error = chrome.runtime.lastError
      if (error) {
        reject(new Error(error.message))
        return
      }
      resolve()
    })
  })
}

function updateRangeTrack(input: HTMLInputElement): void {
  const min = Number(input.min)
  const max = Number(input.max)
  const value = Number(input.value)
  const percentage = ((value - min) / (max - min)) * 100
  input.style.setProperty('--range-progress', `${percentage}%`)
}

function renderSettings(settings: LocalGuardianSettings): void {
  currentSettings = settings
  toxicityInput.value = String(settings.toxicityThreshold)
  blurInput.value = String(settings.blurIntensity)
  toxicityValue.value = `${settings.toxicityThreshold}%`
  toxicityValue.textContent = `${settings.toxicityThreshold}%`
  toxicityInput.setAttribute('aria-valuetext', `${settings.toxicityThreshold} percent`)
  blurValue.value = `${settings.blurIntensity}px`
  blurValue.textContent = `${settings.blurIntensity}px`
  blurInput.setAttribute('aria-valuetext', `${settings.blurIntensity} pixels`)
  updateRangeTrack(toxicityInput)
  updateRangeTrack(blurInput)
}

function runSettingsWrite(settingsToWrite: LocalGuardianSettings): void {
  activeSettingsWrite = true
  void writeLocalStorage({ [SETTINGS_KEY]: settingsToWrite })
    .then(() => {
      pendingSettingsWrites = Math.max(0, pendingSettingsWrites - 1)
      activeSettingsWrite = false
      const nextSettings = latestPendingSettings
      latestPendingSettings = null

      if (nextSettings) {
        pendingSettingsWrites = 1
        runSettingsWrite(nextSettings)
      } else if (pendingSettingsWrites === 0) {
        settingsStatus.textContent = 'Saved locally'
        settingsStatus.dataset.state = 'saved'
      }
    })
    .catch((error: unknown) => {
      activeSettingsWrite = false
      const nextSettings = latestPendingSettings
      latestPendingSettings = null
      console.error('[LocalGuardian Popup] Could not save settings:', error)
      if (nextSettings) {
        pendingSettingsWrites = 1
        runSettingsWrite(nextSettings)
      } else {
        pendingSettingsWrites = 0
        settingsStatus.textContent = 'Save failed'
        settingsStatus.dataset.state = 'error'
      }
    })
}

function persistSettings(): void {
  settingsStatus.textContent = 'Saving'
  settingsStatus.dataset.state = 'saving'

  const settingsToWrite = { ...currentSettings }
  if (activeSettingsWrite) {
    latestPendingSettings = settingsToWrite
    pendingSettingsWrites = 2
    return
  }

  pendingSettingsWrites = 1
  runSettingsWrite(settingsToWrite)
}

function handleThresholdInput(): void {
  currentSettings.toxicityThreshold = clampInteger(toxicityInput.value, 40, 80, 50)
  toxicityValue.value = `${currentSettings.toxicityThreshold}%`
  toxicityValue.textContent = `${currentSettings.toxicityThreshold}%`
  toxicityInput.setAttribute('aria-valuetext', `${currentSettings.toxicityThreshold} percent`)
  updateRangeTrack(toxicityInput)
  persistSettings()
}

function handleBlurInput(): void {
  currentSettings.blurIntensity = clampInteger(blurInput.value, 3, 10, 8)
  blurValue.value = `${currentSettings.blurIntensity}px`
  blurValue.textContent = `${currentSettings.blurIntensity}px`
  blurInput.setAttribute('aria-valuetext', `${currentSettings.blurIntensity} pixels`)
  updateRangeTrack(blurInput)
  persistSettings()
}

function asCount(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : 0
}

function normalizePageStats(value: unknown): PageStats | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<PageStats>
  if (typeof candidate.enabled !== 'boolean') return null

  return {
    toxicCount: asCount(candidate.toxicCount),
    analyzedCount: asCount(candidate.analyzedCount),
    hostname: typeof candidate.hostname === 'string' ? candidate.hostname : '',
    enabled: candidate.enabled,
  }
}

function isSupportedUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    return (
      host === 'reddit.com' ||
      host.endsWith('.reddit.com') ||
      host === 'onlineviewer.net' ||
      host.endsWith('.onlineviewer.net') ||
      host === 'news.ycombinator.com' ||
      host === 'stackoverflow.com' ||
      host.endsWith('.stackoverflow.com')
    )
  } catch {
    return false
  }
}

function renderActivityState(state: ActivityState, stats?: PageStats, host?: string): void {
  pageActivity.dataset.state = state
  activityCounts.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false')
  hostnameElement.hidden = !host
  hostnameElement.textContent = host || ''
  resumeButton.hidden = state !== 'disabled' || !host
  resumeButton.dataset.hostname = host || ''

  if (state === 'active' && stats) {
    pageStatus.textContent = 'Protected'
    activityTitle.textContent = 'Protection is active'
    toxicCountElement.textContent = stats.toxicCount.toLocaleString()
    analyzedCountElement.textContent = stats.analyzedCount.toLocaleString()
    activityMessage.textContent =
      stats.analyzedCount === 0
        ? 'No eligible content has been analyzed on this page yet.'
        : 'Counts update as new content appears on the page.'
    return
  }

  toxicCountElement.textContent = '-'
  analyzedCountElement.textContent = '-'

  const states: Record<Exclude<ActivityState, 'active'>, { badge: string; title: string; message: string }> = {
    loading: {
      badge: 'Loading',
      title: 'Checking this tab',
      message: 'Connecting to the current page.',
    },
    disabled: {
      badge: 'Paused',
      title: 'Protection is paused',
      message: 'LocalGuardian is available on this page but is currently disabled.',
    },
    unsupported: {
      badge: 'Unsupported',
      title: 'This page is not supported',
      message: 'Open Reddit, Hacker News, Stack Overflow, or OnlineViewer to see live activity.',
    },
    unavailable: {
      badge: 'Unavailable',
      title: 'Reload this page',
      message: 'LocalGuardian could not reach the page. Reload it after installing or updating the extension.',
    },
    error: {
      badge: 'Error',
      title: 'Activity could not load',
      message: 'Try refreshing the page activity in a moment.',
    },
  }

  const content = states[state as Exclude<ActivityState, 'active'>]
  pageStatus.textContent = content.badge
  activityTitle.textContent = content.title
  activityMessage.textContent = content.message
}

function queryActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const error = chrome.runtime.lastError
      if (error) {
        reject(new Error(error.message))
        return
      }
      resolve(tabs[0])
    })
  })
}

function requestPageStats(tabId: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_STATS' }, (response) => {
      const error = chrome.runtime.lastError
      if (error) {
        reject(new Error(error.message))
        return
      }
      resolve(response)
    })
  })
}

async function refreshPageStats(showLoading = true): Promise<void> {
  const restoreRefreshFocus = document.activeElement === refreshButton
  if (showLoading) {
    refreshButton.disabled = true
    renderActivityState('loading')
  }

  try {
    const tab = await queryActiveTab()
    activeTabId = tab?.id

    let tabHostname = ''
    try {
      tabHostname = tab?.url ? new URL(tab.url).hostname : ''
    } catch {
      tabHostname = ''
    }

    if (!tab?.id || !isSupportedUrl(tab.url)) {
      renderActivityState('unsupported', undefined, tabHostname)
      return
    }

    try {
      const response = await requestPageStats(tab.id)
      const stats = normalizePageStats(response)
      if (!stats) {
        renderActivityState('error', undefined, tabHostname)
        return
      }
      renderActivityState(stats.enabled ? 'active' : 'disabled', stats, stats.hostname || tabHostname)
    } catch (error) {
      console.info('[LocalGuardian Popup] Page stats are not available:', error)
      renderActivityState('unavailable', undefined, tabHostname)
    }
  } catch (error) {
    console.error('[LocalGuardian Popup] Could not inspect active tab:', error)
    renderActivityState('error')
  } finally {
    refreshButton.disabled = false
    if (restoreRefreshFocus) refreshButton.focus({ preventScroll: true })
  }
}

async function initialize(): Promise<void> {
  renderSettings(DEFAULT_SETTINGS)

  try {
    const stored = await readLocalStorage(SETTINGS_KEY)
    renderSettings(normalizeSettings(stored[SETTINGS_KEY]))
  } catch (error) {
    console.error('[LocalGuardian Popup] Could not load settings:', error)
    settingsStatus.textContent = 'Using defaults'
    settingsStatus.dataset.state = 'error'
  }

  await refreshPageStats()
}

toxicityInput.addEventListener('input', handleThresholdInput)
blurInput.addEventListener('input', handleBlurInput)
toxicityInput.addEventListener('change', () => persistSettings())
blurInput.addEventListener('change', () => persistSettings())
refreshButton.addEventListener('click', () => void refreshPageStats())
analyticsButton.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('analytics.html') })
})

resumeButton.addEventListener('click', async () => {
  const hostname = resumeButton.dataset.hostname
  if (!hostname) return

  resumeButton.disabled = true
  resumeButton.textContent = 'Resuming…'
  try {
    await new Promise<void>((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'UPDATE_WHITELIST', operation: 'removeDomain', value: hostname },
        (result: unknown) => {
          const error = chrome.runtime.lastError
          if (error) {
            reject(new Error(error.message))
            return
          }
          if (!result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== true) {
            reject(new Error('Could not update the site allowlist.'))
            return
          }
          resolve()
        },
      )
    })
    await refreshPageStats(false)
    refreshButton.focus({ preventScroll: true })
  } catch (error) {
    console.error('[LocalGuardian Popup] Could not resume protection:', error)
    renderActivityState('error', undefined, hostname)
    refreshButton.focus({ preventScroll: true })
  } finally {
    resumeButton.disabled = false
    resumeButton.textContent = 'Resume protection on this site'
  }
})

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!message || typeof message !== 'object') return
  const update = message as { type?: string; stats?: unknown; payload?: unknown }
  if (update.type !== 'PAGE_STATS_UPDATED') return
  if (activeTabId && sender.tab?.id && sender.tab.id !== activeTabId) return

  const stats = normalizePageStats(update.stats ?? update.payload)
  if (stats) {
    renderActivityState(stats.enabled ? 'active' : 'disabled', stats, stats.hostname)
  }
})

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[SETTINGS_KEY]) return
  // Chrome emits an onChanged event for each local write before its callback.
  // Ignore those self-echoes so rapid slider input cannot snap back to an
  // earlier persisted value while newer writes are still pending.
  if (pendingSettingsWrites > 0) return
  renderSettings(normalizeSettings(changes[SETTINGS_KEY].newValue))
})

window.setInterval(() => {
  if (document.visibilityState === 'visible') void refreshPageStats(false)
}, 5000)

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshPageStats(false)
})

void initialize()
