import './onboarding.scss'

const CONSENT_KEY = 'hushfernConsent'
const CONSENT_VERSION = 1

type ConsentStatus = 'granted' | 'declined'

interface ConsentRecord {
  status: ConsentStatus
  version: number
  decidedAt: string
}

const panel = requireElement<HTMLElement>('consentPanel')
const title = requireElement<HTMLElement>('onboarding-title')
const summary = requireElement<HTMLElement>('onboardingSummary')
const explanation = requireElement<HTMLElement>('consentExplanation')
const enableButton = requireElement<HTMLButtonElement>('enableProtection')
const declineButton = requireElement<HTMLButtonElement>('declineProtection')
const status = requireElement<HTMLElement>('decisionStatus')

let consentGranted = false

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing required element: ${id}`)
  return element as T
}

function hasGrantedConsent(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ConsentRecord>
  return (
    candidate.status === 'granted' &&
    candidate.version === CONSENT_VERSION &&
    typeof candidate.decidedAt === 'string'
  )
}

function readConsent(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(CONSENT_KEY, (result) => {
      const error = chrome.runtime.lastError
      if (error) {
        reject(new Error(error.message))
        return
      }
      resolve(result[CONSENT_KEY])
    })
  })
}

function writeConsent(statusValue: ConsentStatus): Promise<void> {
  const consent: ConsentRecord = {
    status: statusValue,
    version: CONSENT_VERSION,
    decidedAt: new Date().toISOString(),
  }

  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [CONSENT_KEY]: consent }, () => {
      const error = chrome.runtime.lastError
      if (error) {
        reject(new Error(error.message))
        return
      }
      resolve()
    })
  })
}

function renderConsentState(): void {
  panel.dataset.state = consentGranted ? 'granted' : 'off'
  enableButton.hidden = consentGranted

  if (consentGranted) {
    title.textContent = 'Protection is enabled'
    summary.textContent = 'Hushfern can now analyze visible webpage text locally and blur content that crosses your chosen threshold.'
    explanation.textContent = 'Your choice is stored only in this Chrome profile. Turning protection off immediately stops new analysis and restores hidden text.'
    declineButton.textContent = 'Turn off protection'
    return
  }

  title.textContent = 'Before Hushfern starts'
  summary.textContent = 'Hushfern needs permission to read visible webpage text so it can identify and blur potentially toxic content on your device.'
  explanation.textContent = 'By enabling protection, you allow Hushfern to inspect visible page text for on-device toxicity analysis. You can turn it off at any time.'
  enableButton.textContent = 'Enable protection'
  declineButton.textContent = 'Not now'
}

async function makeDecision(nextStatus: ConsentStatus): Promise<void> {
  enableButton.disabled = true
  declineButton.disabled = true
  status.dataset.state = 'saving'
  status.textContent = nextStatus === 'granted' ? 'Enabling protection…' : 'Saving your choice…'

  try {
    await writeConsent(nextStatus)
    consentGranted = nextStatus === 'granted'
    renderConsentState()
    status.dataset.state = 'saved'
    status.textContent = consentGranted
      ? 'Protection enabled. Open webpages will begin using Hushfern.'
      : 'Protection is off. Hushfern will not analyze webpage text.'
  } catch (error) {
    console.error('[Hushfern Onboarding] Could not save consent:', error)
    status.dataset.state = 'error'
    status.textContent = 'Your choice could not be saved. Please try again.'
  } finally {
    enableButton.disabled = false
    declineButton.disabled = false
    const focusTarget = consentGranted ? declineButton : enableButton
    focusTarget.focus({ preventScroll: true })
  }
}

enableButton.addEventListener('click', () => void makeDecision('granted'))
declineButton.addEventListener('click', () => void makeDecision('declined'))

void readConsent()
  .then((value) => {
    consentGranted = hasGrantedConsent(value)
    renderConsentState()
  })
  .catch((error) => {
    console.error('[Hushfern Onboarding] Could not read consent:', error)
    renderConsentState()
    panel.dataset.state = 'error'
    status.dataset.state = 'error'
    status.textContent = 'Hushfern could not read your current choice. Protection remains off.'
  })
