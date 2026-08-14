console.log('[LocalGuardian Content] Content script injected.');

const SETTINGS_STORAGE_KEY = 'localGuardianSettings';
const WHITELIST_STORAGE_KEY = 'localGuardianWhitelist';

const DEFAULT_SETTINGS: LocalGuardianSettings = {
  toxicityThreshold: 50,
  blurIntensity: 8,
};

const COMMENT_CONTAINER_SELECTOR = [
  'shreddit-comment',
  '[data-testid="comment"]',
  'div[data-test-id="comment"]',
  'tr.athing.comtr',
  '.comment-body',
  '.js-comment',
].join(', ');

const DIRECT_TEXT_BLOCK_SELECTOR = [
  '.commtext',
  '.comment-copy',
  '.js-comment-text',
  '[itemprop="text"]',
].join(', ');

const TEXT_BLOCK_SELECTOR = `p, ${DIRECT_TEXT_BLOCK_SELECTOR}`;
const SCAN_SELECTOR = `${COMMENT_CONTAINER_SELECTOR}, ${DIRECT_TEXT_BLOCK_SELECTOR}`;
const MIN_TEXT_LENGTH = 15;
const MAX_ANALYSIS_TEXT_LENGTH = 50_000;
const MAX_TEXT_WHITELIST_ENTRIES = 100;
const MAX_DOMAIN_WHITELIST_ENTRIES = 100;
const BATCH_SIZE = 10;
const QUEUE_DELAY_MS = 250;
const HOSTNAME = window.location.hostname.trim().toLowerCase();

interface LocalGuardianSettings {
  toxicityThreshold: number;
  blurIntensity: number;
}

interface WhitelistTextEntry {
  text: string;
  domain: string;
  addedAt: number;
}

interface WhitelistDomainEntry {
  domain: string;
  addedAt: number;
}

interface LocalGuardianWhitelist {
  texts: WhitelistTextEntry[];
  domains: WhitelistDomainEntry[];
}

interface QueueItem {
  id: string;
  token: string;
  text: string;
  normalizedText: string;
  element: HTMLElement;
  attempts: number;
}

interface AnalysisResult {
  id: string;
  isToxic: boolean;
  score: number;
}

type HiddenContentPart =
  | {
      kind: 'element';
      element: Element;
      originalAriaHidden: string | null;
    }
  | {
      kind: 'text';
      wrapper: HTMLSpanElement;
    };

interface AnalysisRecord {
  element: HTMLElement;
  text: string;
  normalizedText: string;
  score: number;
  token: string;
  flagged: boolean;
  originalTitle: string | null;
  originalTabIndex: string | null;
  hiddenContent: HiddenContentPart[];
  disclosure: HTMLElement | null;
  feedback: HTMLElement | null;
}

interface PageStats {
  toxicCount: number;
  analyzedCount: number;
  hostname: string;
  enabled: boolean;
}

const processedNodes = new WeakSet<HTMLElement>();
const allowedTextByElement = new WeakMap<HTMLElement, string>();
const recordsByElement = new WeakMap<HTMLElement, AnalysisRecord>();
const recordsByFeedback = new WeakMap<HTMLElement, AnalysisRecord>();
const trackedRecords = new Set<AnalysisRecord>();
const internallyMutatingElements = new WeakSet<HTMLElement>();

let settings = { ...DEFAULT_SETTINGS };
let whitelistedTexts = new Set<string>();
let whitelistedDomains = new Set<string>();
let domainWhitelisted = false;
let textQueue: QueueItem[] = [];
let queueTimer: ReturnType<typeof setTimeout> | null = null;
let requestInFlight = false;
let lastPublishedStats = '';

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function normalizeSettings(value: unknown): LocalGuardianSettings {
  const candidate = isRecord(value) ? value : {};
  return {
    toxicityThreshold: clampInteger(candidate.toxicityThreshold, 40, 80, DEFAULT_SETTINGS.toxicityThreshold),
    blurIntensity: clampInteger(candidate.blurIntensity, 3, 10, DEFAULT_SETTINGS.blurIntensity),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_ANALYSIS_TEXT_LENGTH);
}

function normalizeDomain(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().slice(0, 253) : '';
}

function normalizeWhitelist(value: unknown): LocalGuardianWhitelist {
  const candidate = isRecord(value) ? value : {};
  const texts: WhitelistTextEntry[] = [];
  const domains: WhitelistDomainEntry[] = [];
  const seenTexts = new Set<string>();
  const seenDomains = new Set<string>();

  if (Array.isArray(candidate.texts)) {
    for (const rawEntry of candidate.texts) {
      const rawText = typeof rawEntry === 'string' ? rawEntry : isRecord(rawEntry) ? rawEntry.text : '';
      const text = normalizeText(typeof rawText === 'string' ? rawText : '');
      if (!text || seenTexts.has(text)) continue;

      seenTexts.add(text);
      texts.push({
        text,
        domain: isRecord(rawEntry) ? normalizeDomain(rawEntry.domain) : '',
        addedAt: isRecord(rawEntry) && typeof rawEntry.addedAt === 'number' ? rawEntry.addedAt : 0,
      });
      if (texts.length >= MAX_TEXT_WHITELIST_ENTRIES) break;
    }
  }

  if (Array.isArray(candidate.domains)) {
    for (const rawEntry of candidate.domains) {
      const domain = normalizeDomain(typeof rawEntry === 'string' ? rawEntry : isRecord(rawEntry) ? rawEntry.domain : '');
      if (!domain || seenDomains.has(domain)) continue;

      seenDomains.add(domain);
      domains.push({
        domain,
        addedAt: isRecord(rawEntry) && typeof rawEntry.addedAt === 'number' ? rawEntry.addedAt : 0,
      });
      if (domains.length >= MAX_DOMAIN_WHITELIST_ENTRIES) break;
    }
  }

  return { texts, domains };
}

function applyWhitelist(value: unknown): void {
  const whitelist = normalizeWhitelist(value);
  whitelistedTexts = new Set(whitelist.texts.map((entry) => entry.text));
  whitelistedDomains = new Set(whitelist.domains.map((entry) => entry.domain));
  domainWhitelisted = whitelistedDomains.has(HOSTNAME);
}

function storageGet(keys: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

function storageSet(values: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function createToken(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `lg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function injectStyles(): void {
  if (document.getElementById('localguardian-styles')) return;

  const style = document.createElement('style');
  style.id = 'localguardian-styles';
  style.dataset.localguardianUi = 'true';
  style.textContent = `
    .localguardian-blur {
      position: relative !important;
      filter: blur(var(--localguardian-blur-radius, 8px)) !important;
      cursor: help !important;
      transition: filter 180ms cubic-bezier(0.16, 1, 0.3, 1) !important;
    }

    .localguardian-blur:is(:hover, :focus, :focus-within),
    .localguardian-blur.localguardian-revealed {
      filter: blur(0) !important;
      z-index: 2 !important;
    }

    .localguardian-blur:focus-visible {
      outline: 2px solid #55d5e8 !important;
      outline-offset: 3px !important;
    }

    .localguardian-feedback {
      all: initial !important;
      position: fixed !important;
      inset: auto !important;
      z-index: 2147483000 !important;
      display: inline-flex !important;
      align-items: center !important;
      gap: 4px !important;
      width: max-content !important;
      max-width: min(360px, calc(100vw - 24px)) !important;
      padding: 4px !important;
      border: 1px solid #47637c !important;
      border-radius: 8px !important;
      background: #0b1725 !important;
      box-shadow: 0 4px 8px rgb(0 0 0 / 28%) !important;
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
      transform: translateY(2px) !important;
      transition:
        opacity 160ms cubic-bezier(0.16, 1, 0.3, 1),
        transform 160ms cubic-bezier(0.16, 1, 0.3, 1),
        visibility 160ms step-end !important;
    }

    .localguardian-feedback[data-open="true"] {
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
      transform: translateY(0) !important;
      transition:
        opacity 160ms cubic-bezier(0.16, 1, 0.3, 1),
        transform 160ms cubic-bezier(0.16, 1, 0.3, 1),
        visibility 0ms step-start !important;
    }

    .localguardian-feedback__button {
      all: unset !important;
      box-sizing: border-box !important;
      min-height: 36px !important;
      padding: 7px 9px !important;
      border-radius: 6px !important;
      color: #dcecf5 !important;
      cursor: pointer !important;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      font-size: 11px !important;
      font-weight: 650 !important;
      line-height: 1.2 !important;
      white-space: nowrap !important;
    }

    .localguardian-feedback__button:hover {
      background: #193149 !important;
      color: #ffffff !important;
    }

    .localguardian-feedback__button--primary {
      background: #55d5e8 !important;
      color: #06222a !important;
    }

    .localguardian-feedback__button--primary:hover {
      background: #74e4f1 !important;
      color: #06222a !important;
    }

    .localguardian-feedback__button:focus-visible {
      outline: 2px solid #74e4f1 !important;
      outline-offset: 2px !important;
    }

    .localguardian-feedback__button:disabled {
      cursor: wait !important;
      opacity: 0.7 !important;
    }

    .localguardian-a11y-disclosure,
    .localguardian-feedback__status {
      position: absolute !important;
      width: 1px !important;
      height: 1px !important;
      padding: 0 !important;
      margin: -1px !important;
      overflow: hidden !important;
      clip: rect(0, 0, 0, 0) !important;
      white-space: nowrap !important;
    }

    @media (prefers-reduced-motion: reduce) {
      .localguardian-blur,
      .localguardian-feedback {
        transition-duration: 0.01ms !important;
      }
    }

    @media (forced-colors: active) {
      .localguardian-feedback,
      .localguardian-feedback__button {
        border: 1px solid ButtonText !important;
        forced-color-adjust: auto !important;
      }
    }
  `;
  (document.head ?? document.documentElement).append(style);
}

function elementText(element: HTMLElement): string {
  if (!element.querySelector('[data-localguardian-ui]')) {
    return normalizeText(element.innerText || element.textContent || '');
  }

  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-localguardian-ui]').forEach((node) => node.remove());
  return normalizeText(clone.textContent || '');
}

function isEligibleTextElement(element: HTMLElement): boolean {
  if (element.closest('[data-localguardian-ui]')) return false;
  if (element.closest('button, input, textarea, select, [contenteditable="true"]')) return false;
  if (processedNodes.has(element)) return false;
  return elementText(element).length > MIN_TEXT_LENGTH;
}

function extractTextElements(target: Element): HTMLElement[] {
  const elements = new Set<HTMLElement>();

  if (target.matches(TEXT_BLOCK_SELECTOR) && target instanceof HTMLElement) {
    elements.add(target);
  }

  target.querySelectorAll<HTMLElement>(TEXT_BLOCK_SELECTOR).forEach((element) => elements.add(element));

  // Some sites render a comment's text directly in the container without a
  // paragraph or dedicated leaf element.
  if (elements.size === 0 && target.matches(COMMENT_CONTAINER_SELECTOR) && target instanceof HTMLElement) {
    elements.add(target);
  }

  return [...elements].filter(isEligibleTextElement);
}

function scheduleQueue(delay = QUEUE_DELAY_MS): void {
  if (queueTimer || requestInFlight || textQueue.length === 0) return;
  queueTimer = setTimeout(() => {
    queueTimer = null;
    processQueue();
  }, delay);
}

function queueForAnalysis(elements: HTMLElement[]): void {
  if (domainWhitelisted) return;

  for (const element of elements) {
    const normalizedText = elementText(element);
    if (normalizedText.length <= MIN_TEXT_LENGTH) continue;

    processedNodes.add(element);
    if (whitelistedTexts.has(normalizedText)) {
      allowedTextByElement.set(element, normalizedText);
      continue;
    }
    allowedTextByElement.delete(element);

    const token = createToken();
    element.dataset.localguardianToken = token;
    textQueue.push({
      id: `lg_${token}`,
      token,
      text: normalizedText,
      normalizedText,
      element,
      attempts: 0,
    });
  }

  scheduleQueue();
}

function isItemCurrent(item: QueueItem): boolean {
  return (
    document.body.contains(item.element) &&
    item.element.dataset.localguardianToken === item.token &&
    elementText(item.element) === item.normalizedText
  );
}

function requeueItems(items: QueueItem[]): void {
  for (const item of items) {
    if (!isItemCurrent(item)) {
      processedNodes.delete(item.element);
      if (item.element.dataset.localguardianToken === item.token) {
        delete item.element.dataset.localguardianToken;
      }
      if (document.body.contains(item.element)) processNode(item.element);
      continue;
    }
    if (item.attempts >= 2) {
      processedNodes.delete(item.element);
      delete item.element.dataset.localguardianToken;
      continue;
    }
    textQueue.push({ ...item, attempts: item.attempts + 1 });
  }
  scheduleQueue(500);
}

function sendRuntimeMessage(message: Record<string, unknown>): void {
  try {
    chrome.runtime.sendMessage(message, () => {
      // Reading lastError prevents expected "no receiver" cases from being
      // reported as uncaught errors while the service worker restarts.
      void chrome.runtime.lastError;
    });
  } catch (error) {
    console.debug('[LocalGuardian Content] Runtime message could not be sent:', error);
  }
}

function requestRuntimeMessage(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response: unknown) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        if (!isRecord(response) || response.ok !== true) {
          reject(new Error(isRecord(response) && typeof response.error === 'string' ? response.error : 'Invalid response'));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function shouldFlag(record: AnalysisRecord): boolean {
  return (
    !domainWhitelisted &&
    !whitelistedTexts.has(record.normalizedText) &&
    record.score >= settings.toxicityThreshold / 100
  );
}

function markInternalMutation(element: HTMLElement): void {
  internallyMutatingElements.add(element);
  // MutationObserver callbacks run before the next timer task, so extension-
  // owned wrapping is ignored without suppressing later host-page edits.
  setTimeout(() => internallyMutatingElements.delete(element), 0);
}

function hideRawContent(record: AnalysisRecord): HiddenContentPart[] {
  const hiddenContent: HiddenContentPart[] = [];
  markInternalMutation(record.element);

  // Hide existing element children directly and wrap only direct Text nodes.
  // This preserves the page's visual layout while removing the original toxic
  // content from the accessibility tree until hover/focus explicitly reveals it.
  for (const node of [...record.element.childNodes]) {
    if (node instanceof Element) {
      hiddenContent.push({
        kind: 'element',
        element: node,
        originalAriaHidden: node.getAttribute('aria-hidden'),
      });
      node.setAttribute('aria-hidden', 'true');
      continue;
    }
    if (node.nodeType !== Node.TEXT_NODE) continue;

    const wrapper = document.createElement('span');
    wrapper.className = 'localguardian-hidden-text';
    wrapper.setAttribute('aria-hidden', 'true');
    markInternalMutation(wrapper);
    record.element.insertBefore(wrapper, node);
    wrapper.append(node);
    hiddenContent.push({ kind: 'text', wrapper });
  }

  return hiddenContent;
}

function setRawContentHidden(record: AnalysisRecord, hidden: boolean): void {
  for (const part of record.hiddenContent) {
    if (part.kind === 'text') {
      part.wrapper.setAttribute('aria-hidden', String(hidden));
      continue;
    }

    if (hidden) part.element.setAttribute('aria-hidden', 'true');
    else if (part.originalAriaHidden === null) part.element.removeAttribute('aria-hidden');
    else part.element.setAttribute('aria-hidden', part.originalAriaHidden);
  }
}

function restoreRawContent(record: AnalysisRecord): void {
  markInternalMutation(record.element);
  for (const part of record.hiddenContent) {
    if (part.kind === 'element') {
      if (part.originalAriaHidden === null) part.element.removeAttribute('aria-hidden');
      else part.element.setAttribute('aria-hidden', part.originalAriaHidden);
      continue;
    }

    markInternalMutation(part.wrapper);
    const fragment = document.createDocumentFragment();
    while (part.wrapper.firstChild) fragment.append(part.wrapper.firstChild);
    part.wrapper.replaceWith(fragment);
  }
  record.hiddenContent = [];
}

function positionFeedback(record: AnalysisRecord): void {
  const feedback = record.feedback;
  if (!feedback || !record.flagged || !document.body.contains(record.element)) return;

  const targetRect = record.element.getBoundingClientRect();
  if (targetRect.bottom < 0 || targetRect.top > window.innerHeight) {
    hideFeedback(record);
    return;
  }

  const viewportPadding = 8;
  const gap = 6;
  const feedbackRect = feedback.getBoundingClientRect();
  const availableWidth = Math.max(0, window.innerWidth - viewportPadding * 2);
  const width = Math.min(feedbackRect.width, availableWidth);
  const left = Math.min(
    Math.max(viewportPadding, targetRect.right - width),
    Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
  );
  const below = targetRect.bottom + gap;
  const top = below + feedbackRect.height <= window.innerHeight - viewportPadding
    ? below
    : Math.max(viewportPadding, targetRect.top - feedbackRect.height - gap);

  feedback.style.setProperty('left', `${Math.round(left)}px`, 'important');
  feedback.style.setProperty('top', `${Math.round(top)}px`, 'important');
}

function showFeedback(record: AnalysisRecord): void {
  if (!record.flagged || !record.feedback) return;
  record.element.classList.add('localguardian-revealed');
  setRawContentHidden(record, false);
  positionFeedback(record);
  record.feedback.dataset.open = 'true';
  record.feedback.setAttribute('aria-hidden', 'false');
  record.feedback.inert = false;
}

function hideFeedback(record: AnalysisRecord): void {
  if (!record.feedback) return;
  record.feedback.dataset.open = 'false';
  record.feedback.setAttribute('aria-hidden', 'true');
  record.feedback.inert = true;
  record.element.classList.remove('localguardian-revealed');
  setRawContentHidden(record, true);
}

function recordForRevealTarget(target: EventTarget | null): AnalysisRecord | null {
  if (!(target instanceof HTMLElement)) return null;
  return recordsByElement.get(target) ?? recordsByFeedback.get(target) ?? null;
}

function beginReveal(event: Event): void {
  const record = recordForRevealTarget(event.currentTarget);
  if (record) showFeedback(record);
}

function endReveal(event: Event): void {
  const record = recordForRevealTarget(event.currentTarget);
  if (!record) return;

  // Give the pointer/focus time to cross the small portal gap before deciding
  // that neither the content nor its controls remain engaged.
  setTimeout(() => {
    if (!record.flagged || !record.feedback) return;
    const remainsOpen =
      record.element.matches(':hover, :focus-within') ||
      record.feedback.matches(':hover, :focus-within');
    if (remainsOpen) showFeedback(record);
    else hideFeedback(record);
  }, 80);
}

let feedbackLayoutFrame: number | null = null;
function scheduleFeedbackLayout(): void {
  if (feedbackLayoutFrame !== null) return;
  feedbackLayoutFrame = requestAnimationFrame(() => {
    feedbackLayoutFrame = null;
    for (const record of trackedRecords) {
      if (record.feedback?.dataset.open === 'true') positionFeedback(record);
    }
  });
}

function dismissFeedbackOutside(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;

  for (const record of trackedRecords) {
    if (record.feedback?.dataset.open !== 'true') continue;
    if (record.element.contains(target) || record.feedback.contains(target)) continue;

    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      (record.element.contains(activeElement) || record.feedback.contains(activeElement))
    ) {
      activeElement.blur();
    }
    hideFeedback(record);
  }
}

function createDisclosure(record: AnalysisRecord): HTMLElement {
  const disclosure = document.createElement('span');
  disclosure.className = 'localguardian-a11y-disclosure';
  disclosure.dataset.localguardianUi = 'true';
  disclosure.textContent = `LocalGuardian hid potentially toxic text at ${Math.round(record.score * 100)} percent. Focus this block to reveal it.`;
  return disclosure;
}

function createFeedback(record: AnalysisRecord): HTMLElement {
  const feedback = document.createElement('span');
  feedback.className = 'localguardian-feedback';
  feedback.dataset.localguardianUi = 'true';
  feedback.dataset.open = 'false';
  feedback.setAttribute('role', 'group');
  feedback.setAttribute('aria-label', 'LocalGuardian reveal controls');
  feedback.setAttribute('aria-hidden', 'true');
  feedback.inert = true;

  const status = document.createElement('span');
  status.className = 'localguardian-feedback__status';
  status.dataset.localguardianUi = 'true';
  status.textContent = `LocalGuardian hid this text with a toxicity score of ${Math.round(record.score * 100)} percent.`;

  const falsePositiveButton = document.createElement('button');
  falsePositiveButton.type = 'button';
  falsePositiveButton.className = 'localguardian-feedback__button';
  falsePositiveButton.dataset.localguardianUi = 'true';
  falsePositiveButton.textContent = 'Report false positive';
  falsePositiveButton.addEventListener('click', (event) => {
    event.stopPropagation();
    void whitelistText(record, falsePositiveButton, domainButton);
  });

  const domainButton = document.createElement('button');
  domainButton.type = 'button';
  domainButton.className = 'localguardian-feedback__button localguardian-feedback__button--primary';
  domainButton.dataset.localguardianUi = 'true';
  domainButton.textContent = 'Always show on this site';
  domainButton.addEventListener('click', (event) => {
    event.stopPropagation();
    void whitelistDomain(record, falsePositiveButton, domainButton);
  });

  feedback.append(status, falsePositiveButton, domainButton);
  recordsByFeedback.set(feedback, record);
  feedback.addEventListener('mouseenter', beginReveal);
  feedback.addEventListener('mouseleave', endReveal);
  feedback.addEventListener('focusin', beginReveal);
  feedback.addEventListener('focusout', endReveal);
  return feedback;
}

function flagRecord(record: AnalysisRecord): void {
  if (record.flagged || !document.body.contains(record.element)) return;

  record.flagged = true;
  markInternalMutation(record.element);
  record.element.classList.add('localguardian-blur');
  record.element.style.setProperty('--localguardian-blur-radius', `${settings.blurIntensity}px`);
  // A native title tooltip obscures the compact action panel on hover. The
  // dedicated disclosure and feedback group provide the same context without
  // competing browser chrome.
  record.element.removeAttribute('title');
  if (record.element.tabIndex < 0) record.element.tabIndex = 0;

  record.hiddenContent = hideRawContent(record);
  record.disclosure = createDisclosure(record);
  record.feedback = createFeedback(record);
  record.element.append(record.disclosure);
  document.body.append(record.feedback);
  record.element.addEventListener('mouseenter', beginReveal);
  record.element.addEventListener('mouseleave', endReveal);
  record.element.addEventListener('focusin', beginReveal);
  record.element.addEventListener('focusout', endReveal);
}

function unflagRecord(record: AnalysisRecord): void {
  if (!record.flagged && !record.feedback && !record.disclosure && record.hiddenContent.length === 0) return;

  record.flagged = false;
  record.element.classList.remove('localguardian-blur', 'localguardian-revealed');
  record.element.style.removeProperty('--localguardian-blur-radius');
  record.element.removeEventListener('mouseenter', beginReveal);
  record.element.removeEventListener('mouseleave', endReveal);
  record.element.removeEventListener('focusin', beginReveal);
  record.element.removeEventListener('focusout', endReveal);
  markInternalMutation(record.element);
  record.disclosure?.remove();
  record.disclosure = null;
  record.feedback?.remove();
  record.feedback = null;
  restoreRawContent(record);

  if (record.originalTitle === null) record.element.removeAttribute('title');
  else record.element.setAttribute('title', record.originalTitle);

  if (record.originalTabIndex === null) record.element.removeAttribute('tabindex');
  else record.element.setAttribute('tabindex', record.originalTabIndex);
}

function evaluateRecord(record: AnalysisRecord): void {
  if (shouldFlag(record)) flagRecord(record);
  else unflagRecord(record);
}

function registerResult(item: QueueItem, result: AnalysisResult): boolean | null {
  if (!isItemCurrent(item)) {
    processedNodes.delete(item.element);
    if (item.element.dataset.localguardianToken === item.token) {
      delete item.element.dataset.localguardianToken;
    }
    if (document.body.contains(item.element)) processNode(item.element);
    return null;
  }

  const score = typeof result.score === 'number' && Number.isFinite(result.score)
    ? Math.min(1, Math.max(0, result.score))
    : 0;

  const existing = recordsByElement.get(item.element);
  if (existing) {
    existing.score = score;
    existing.text = item.text;
    existing.normalizedText = item.normalizedText;
    existing.token = item.token;
    evaluateRecord(existing);
    return existing.flagged;
  }

  const record: AnalysisRecord = {
    element: item.element,
    text: item.text,
    normalizedText: item.normalizedText,
    score,
    token: item.token,
    flagged: false,
    originalTitle: item.element.getAttribute('title'),
    originalTabIndex: item.element.getAttribute('tabindex'),
    hiddenContent: [],
    disclosure: null,
    feedback: null,
  };

  recordsByElement.set(item.element, record);
  trackedRecords.add(record);
  evaluateRecord(record);
  return record.flagged;
}

function processQueue(): void {
  if (requestInFlight || textQueue.length === 0 || domainWhitelisted) return;

  const batch = textQueue.splice(0, BATCH_SIZE);
  const payloads = batch.map(({ id, text }) => ({ id, text }));
  requestInFlight = true;

  chrome.runtime.sendMessage({ type: 'ANALYZE_BATCH', payloads }, (response: unknown) => {
    requestInFlight = false;
    const runtimeError = chrome.runtime.lastError;

    if (runtimeError || !isRecord(response) || !Array.isArray(response.results)) {
      console.warn('[LocalGuardian Content] Analysis request failed:', runtimeError?.message ?? 'Invalid response');
      requeueItems(batch);
      return;
    }

    const results = new Map<string, AnalysisResult>();
    for (const rawResult of response.results) {
      if (!isRecord(rawResult) || typeof rawResult.id !== 'string') continue;
      results.set(rawResult.id, {
        id: rawResult.id,
        isToxic: rawResult.isToxic === true,
        score: typeof rawResult.score === 'number' ? rawResult.score : 0,
      });
    }

    const missing: QueueItem[] = [];
    let appliedCount = 0;
    let appliedToxicCount = 0;
    for (const item of batch) {
      const result = results.get(item.id);
      if (result) {
        const flagged = registerResult(item, result);
        if (flagged !== null) {
          appliedCount += 1;
          if (flagged) appliedToxicCount += 1;
        }
      }
      else missing.push(item);
    }

    if (appliedCount > 0) {
      sendRuntimeMessage({
        type: 'RECORD_APPLIED_RESULTS',
        analyzed: appliedCount,
        toxic: appliedToxicCount,
      });
    }

    if (missing.length > 0) requeueItems(missing);
    pruneDetachedRecords();
    publishStats();
    scheduleQueue(0);
  });
}

function processNode(node: Node): void {
  if (!(node instanceof Element) || domainWhitelisted || node.closest('[data-localguardian-ui]')) return;

  const targets = new Set<Element>();
  if (node.matches(SCAN_SELECTOR)) targets.add(node);
  node.querySelectorAll(SCAN_SELECTOR).forEach((target) => targets.add(target));

  const containingComment = node.closest(COMMENT_CONTAINER_SELECTOR);
  if (containingComment) targets.add(containingComment);

  for (const target of targets) queueForAnalysis(extractTextElements(target));
}

function scanDocumentForUntrackedText(): void {
  if (domainWhitelisted) return;

  document.querySelectorAll<HTMLElement>(TEXT_BLOCK_SELECTOR).forEach((element) => {
    const belongsToDiscussion = element.matches(DIRECT_TEXT_BLOCK_SELECTOR) || element.closest(COMMENT_CONTAINER_SELECTOR);
    if (
      belongsToDiscussion &&
      !recordsByElement.has(element) &&
      !element.dataset.localguardianToken
    ) {
      // An exact-text allowlist may have previously skipped this node. Clear
      // that terminal marker so removing the entry takes effect immediately.
      processedNodes.delete(element);
    }
  });

  document.querySelectorAll<HTMLElement>(SCAN_SELECTOR).forEach((element) => {
    processNode(element);
  });
}

function removeRecord(record: AnalysisRecord, restoreElement: boolean): void {
  if (restoreElement) {
    unflagRecord(record);
    delete record.element.dataset.localguardianToken;
    processedNodes.delete(record.element);
  }
  recordsByElement.delete(record.element);
  trackedRecords.delete(record);
}

function pruneDetachedRecords(): void {
  for (const record of trackedRecords) {
    if (!document.body.contains(record.element)) removeRecord(record, true);
  }
  textQueue = textQueue.filter((item) => {
    if (document.body.contains(item.element)) return true;
    processedNodes.delete(item.element);
    if (item.element.dataset.localguardianToken === item.token) {
      delete item.element.dataset.localguardianToken;
    }
    return false;
  });
}

function restoreFocus(element: HTMLElement): void {
  const previousTabIndex = element.getAttribute('tabindex');
  element.setAttribute('tabindex', '-1');
  element.focus({ preventScroll: true });
  element.addEventListener(
    'blur',
    () => {
      if (previousTabIndex === null) element.removeAttribute('tabindex');
      else element.setAttribute('tabindex', previousTabIndex);
    },
    { once: true },
  );
}

function announceAction(message: string): void {
  const status = document.createElement('span');
  status.dataset.localguardianUi = 'true';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.className = 'localguardian-feedback__status';
  status.textContent = message;
  document.body.append(status);
  setTimeout(() => status.remove(), 2000);
}

function currentStats(): PageStats {
  pruneDetachedRecords();
  let analyzedCount = 0;
  let toxicCount = 0;

  for (const record of trackedRecords) {
    if (!document.body.contains(record.element)) continue;
    analyzedCount += 1;
    if (record.flagged) toxicCount += 1;
  }

  return {
    toxicCount,
    analyzedCount,
    hostname: HOSTNAME,
    enabled: !domainWhitelisted,
  };
}

function publishStats(force = false): void {
  const stats = currentStats();
  const serialized = JSON.stringify(stats);
  if (!force && serialized === lastPublishedStats) return;

  lastPublishedStats = serialized;
  sendRuntimeMessage({ type: 'PAGE_STATS_UPDATED', stats, payload: stats });
}

function updateAllRecords(): void {
  for (const record of trackedRecords) {
    if (record.flagged) {
      record.element.style.setProperty('--localguardian-blur-radius', `${settings.blurIntensity}px`);
    }
    evaluateRecord(record);
  }
  publishStats();
}

async function whitelistText(
  record: AnalysisRecord,
  falsePositiveButton: HTMLButtonElement,
  domainButton: HTMLButtonElement,
): Promise<void> {
  const focusTarget = record.element;
  focusTarget.focus({ preventScroll: true });
  falsePositiveButton.disabled = true;
  domainButton.disabled = true;
  falsePositiveButton.textContent = 'Saving…';

  try {
    const response = await requestRuntimeMessage({
      type: 'UPDATE_WHITELIST',
      operation: 'addText',
      value: record.normalizedText,
    });
    applyWhitelist(response.whitelist);
    updateAllRecords();
    sendRuntimeMessage({ type: 'RECORD_FALSE_POSITIVE' });
    announceAction('This text will always be shown.');
    restoreFocus(focusTarget);
  } catch (error) {
    console.error('[LocalGuardian Content] Could not save text allowlist entry:', error);
    falsePositiveButton.disabled = false;
    domainButton.disabled = false;
    falsePositiveButton.textContent = 'Save failed — try again';
    falsePositiveButton.focus({ preventScroll: true });
  }
}

async function whitelistDomain(
  record: AnalysisRecord,
  falsePositiveButton: HTMLButtonElement,
  domainButton: HTMLButtonElement,
): Promise<void> {
  const focusTarget = record.element;
  focusTarget.focus({ preventScroll: true });
  falsePositiveButton.disabled = true;
  domainButton.disabled = true;
  domainButton.textContent = 'Saving…';

  try {
    const response = await requestRuntimeMessage({
      type: 'UPDATE_WHITELIST',
      operation: 'addDomain',
      value: HOSTNAME,
    });
    applyWhitelist(response.whitelist);
    textQueue = [];
    updateAllRecords();
    announceAction(`LocalGuardian is paused on ${HOSTNAME}.`);
    restoreFocus(focusTarget);
  } catch (error) {
    console.error('[LocalGuardian Content] Could not save domain allowlist entry:', error);
    falsePositiveButton.disabled = false;
    domainButton.disabled = false;
    domainButton.textContent = 'Save failed — try again';
    domainButton.focus({ preventScroll: true });
  }
}

function isLocalGuardianMutation(mutation: MutationRecord): boolean {
  const mutationElement = mutation.target.nodeType === Node.ELEMENT_NODE
    ? (mutation.target as Element)
    : mutation.target.parentElement;
  let currentElement: Element | null = mutationElement;
  while (currentElement) {
    if (
      currentElement instanceof HTMLElement &&
      internallyMutatingElements.has(currentElement)
    ) {
      return true;
    }
    currentElement = currentElement.parentElement;
  }
  if (mutationElement?.closest('[data-localguardian-ui]')) return true;

  const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
  return changedNodes.length > 0 && changedNodes.every((node) => {
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    return Boolean(element?.matches('[data-localguardian-ui]') || element?.closest('[data-localguardian-ui]'));
  });
}

function findTrackedTextElement(node: Node): HTMLElement | null {
  let element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (element && element !== document.body) {
    if (element instanceof HTMLElement && element.dataset.localguardianToken) return element;
    element = element.parentElement;
  }
  return null;
}

function invalidateChangedElement(element: HTMLElement): void {
  const record = recordsByElement.get(element);
  if (record) removeRecord(record, true);
  else {
    processedNodes.delete(element);
    delete element.dataset.localguardianToken;
  }
  processNode(element);
}

function findChangedAllowlistedElement(node: Node): HTMLElement | null {
  let element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (element && element !== document.body) {
    if (element instanceof HTMLElement && allowedTextByElement.has(element)) return element;
    element = element.parentElement;
  }
  return null;
}

const observer = new MutationObserver((mutations) => {
  let shouldPublish = false;

  for (const mutation of mutations) {
    if (isLocalGuardianMutation(mutation)) continue;

    const changedElement = findTrackedTextElement(mutation.target) ?? findChangedAllowlistedElement(mutation.target);
    if (changedElement) {
      allowedTextByElement.delete(changedElement);
      invalidateChangedElement(changedElement);
      shouldPublish = true;
      continue;
    }

    mutation.addedNodes.forEach((node) => processNode(node));
    const hasDirectTextNodeChange = mutation.type === 'childList' &&
      [...mutation.addedNodes, ...mutation.removedNodes].some((node) => node.nodeType === Node.TEXT_NODE);
    if (mutation.type === 'characterData' || hasDirectTextNodeChange) {
      const mutationElement = mutation.target.parentElement;
      if (mutationElement) {
        const discussionTarget = mutationElement.closest(COMMENT_CONTAINER_SELECTOR) ?? mutationElement;
        processNode(discussionTarget);
      }
    }
    if (mutation.removedNodes.length > 0) shouldPublish = true;
  }

  if (shouldPublish) publishStats();
});

window.addEventListener('scroll', scheduleFeedbackLayout, true);
window.addEventListener('resize', scheduleFeedbackLayout);
document.addEventListener('pointerdown', dismissFeedbackOutside, true);

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isRecord(message) || message.type !== 'GET_PAGE_STATS') return false;
  sendResponse(currentStats());
  return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  if (changes[SETTINGS_STORAGE_KEY]) {
    settings = normalizeSettings(changes[SETTINGS_STORAGE_KEY].newValue);
    updateAllRecords();
  }

  if (changes[WHITELIST_STORAGE_KEY]) {
    applyWhitelist(changes[WHITELIST_STORAGE_KEY].newValue);
    if (domainWhitelisted) textQueue = [];
    updateAllRecords();

    if (!domainWhitelisted) scanDocumentForUntrackedText();
  }
});

async function initialize(): Promise<void> {
  injectStyles();

  try {
    const stored = await storageGet([SETTINGS_STORAGE_KEY, WHITELIST_STORAGE_KEY]);
    settings = normalizeSettings(stored[SETTINGS_STORAGE_KEY]);
    applyWhitelist(stored[WHITELIST_STORAGE_KEY]);
  } catch (error) {
    console.warn('[LocalGuardian Content] Using default settings because storage could not be read:', error);
  }

  observer.observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true,
  });

  if (!domainWhitelisted) {
    scanDocumentForUntrackedText();
  }
  publishStats(true);
}

void initialize();
