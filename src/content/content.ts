console.log('[Hushfern Content] Content script injected.');

const SETTINGS_STORAGE_KEY = 'localGuardianSettings';
const WHITELIST_STORAGE_KEY = 'localGuardianWhitelist';
const QUEUE_ANALYSIS_TYPE = 'QUEUE_ANALYSIS';
const ANALYSIS_RESULT_TYPE = 'ANALYSIS_RESULT';
const PING_CONTENT_TYPE = 'PING_CONTENT';

const DEFAULT_SETTINGS: HushfernSettings = {
  toxicityThreshold: 50,
  blurIntensity: 8,
  keepHiddenOnHover: true,
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

const TEXT_BLOCK_SELECTOR = [
  'p',
  'li',
  'blockquote',
  'dd',
  'dt',
  'figcaption',
  'td',
  'th',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'main',
  'article',
  'section',
  'div',
  DIRECT_TEXT_BLOCK_SELECTOR,
].join(', ');
const EXCLUDED_CONTENT_SELECTOR = [
  '[data-localguardian-ui]',
  '[hidden]',
  '[aria-hidden="true"]',
  'script',
  'style',
  'noscript',
  'template',
  'pre',
  'code',
  'kbd',
  'samp',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'button',
  'input',
  'textarea',
  'select',
  'option',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  'nav',
  '[role="navigation"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="toolbar"]',
].join(', ');
const MIN_TEXT_LENGTH = 15;
const MAX_ANALYSIS_TEXT_LENGTH = 50_000;
const MAX_TEXT_WHITELIST_ENTRIES = 100;
const MAX_DOMAIN_WHITELIST_ENTRIES = 100;
const BATCH_SIZE = 10;
const QUEUE_DELAY_MS = 250;
const ANALYSIS_TIMEOUT_MS = 15 * 60_000;
const HOSTNAME = window.location.hostname.trim().toLowerCase();

interface HushfernSettings {
  toxicityThreshold: number;
  blurIntensity: number;
  keepHiddenOnHover: boolean;
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

interface HushfernWhitelist {
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
}

interface PageStats {
  toxicCount: number;
  analyzedCount: number;
  hostname: string;
  enabled: boolean;
}

class OffscreenModelError extends Error {}

interface PendingAnalysis {
  resolve: (response: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const processedNodes = new WeakSet<HTMLElement>();
const allowedTextByElement = new WeakMap<HTMLElement, string>();
const recordsByElement = new WeakMap<HTMLElement, AnalysisRecord>();
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
let extensionContextValid = true;
const pendingAnalysisRequests = new Map<string, PendingAnalysis>();

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function normalizeSettings(value: unknown): HushfernSettings {
  const candidate = isRecord(value) ? value : {};
  return {
    toxicityThreshold: clampInteger(candidate.toxicityThreshold, 40, 80, DEFAULT_SETTINGS.toxicityThreshold),
    blurIntensity: clampInteger(candidate.blurIntensity, 3, 10, DEFAULT_SETTINGS.blurIntensity),
    keepHiddenOnHover: candidate.keepHiddenOnHover === true,
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

function normalizeWhitelist(value: unknown): HushfernWhitelist {
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

    .localguardian-blur:not(.localguardian-hover-locked):hover,
    .localguardian-blur:is(:focus, :focus-within),
    .localguardian-blur.localguardian-revealed {
      filter: blur(0) !important;
      z-index: 2 !important;
    }

    .localguardian-blur:focus-visible {
      outline: 2px solid #55d5e8 !important;
      outline-offset: 3px !important;
    }

    .localguardian-a11y-disclosure {
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
      .localguardian-blur {
        transition-duration: 0.01ms !important;
      }
    }
  `;
  (document.head ?? document.documentElement).append(style);
}

function cleanupOrphanedUi(): void {
  // Static content scripts are not refreshed in existing tabs when an unpacked
  // extension reloads. A newly injected instance removes UI and tokens left by
  // the invalidated instance before it starts scanning again.
  document.querySelectorAll<HTMLElement>('[data-localguardian-ui]').forEach((element) => element.remove());
  document.querySelectorAll<HTMLElement>('.localguardian-hidden-text').forEach((wrapper) => {
    wrapper.replaceWith(...wrapper.childNodes);
  });
  document
    .querySelectorAll<HTMLElement>('[data-localguardian-token], .localguardian-blur, .localguardian-revealed')
    .forEach((element) => {
      delete element.dataset.localguardianToken;
      element.classList.remove('localguardian-blur', 'localguardian-revealed');
      element.style.removeProperty('--localguardian-blur-radius');
    });
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
  if (element.closest(EXCLUDED_CONTENT_SELECTOR)) return false;
  if (processedNodes.has(element)) return false;
  if (element.getClientRects().length === 0) return false;
  const computedStyle = window.getComputedStyle(element);
  if (computedStyle.display === 'none' || computedStyle.visibility === 'hidden') return false;
  return elementText(element).length > MIN_TEXT_LENGTH;
}

function isLeafTextBlock(element: HTMLElement): boolean {
  return !element.querySelector(TEXT_BLOCK_SELECTOR);
}

function extractTextElements(target: Element): HTMLElement[] {
  const elements = new Set<HTMLElement>();

  if (target.matches(TEXT_BLOCK_SELECTOR) && target instanceof HTMLElement) {
    elements.add(target);
  }

  target.querySelectorAll<HTMLElement>(TEXT_BLOCK_SELECTOR).forEach((element) => elements.add(element));

  const containingTextBlock = target.closest<HTMLElement>(TEXT_BLOCK_SELECTOR);
  if (containingTextBlock) elements.add(containingTextBlock);

  // Some sites render a comment's text directly in the container without a
  // paragraph or dedicated leaf element.
  if (elements.size === 0 && target.matches(COMMENT_CONTAINER_SELECTOR) && target instanceof HTMLElement) {
    elements.add(target);
  }

  return [...elements].filter(isLeafTextBlock).filter(isEligibleTextElement);
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
  if (!extensionContextValid) return;

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

function isExtensionContextInvalidated(message: string): boolean {
  return message.toLowerCase().includes('extension context invalidated');
}

function stopInvalidatedContext(): void {
  if (!extensionContextValid) return;

  extensionContextValid = false;
  requestInFlight = false;
  textQueue = [];
  if (queueTimer) {
    clearTimeout(queueTimer);
    queueTimer = null;
  }
  observer.disconnect();

  for (const pending of pendingAnalysisRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error('Extension context invalidated. Refresh this page to reconnect Hushfern.'));
  }
  pendingAnalysisRequests.clear();

  for (const record of [...trackedRecords]) removeRecord(record, true);
  console.info('[Hushfern Content] Extension was reloaded. Refresh this page to reconnect Hushfern.');
}

function handleRuntimeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!isExtensionContextInvalidated(message)) return false;
  stopInvalidatedContext();
  return true;
}

function sendRuntimeMessage(message: Record<string, unknown>): void {
  if (!extensionContextValid) return;

  try {
    chrome.runtime.sendMessage(message, () => {
      // Reading lastError prevents expected "no receiver" cases from being
      // reported as uncaught errors while the service worker restarts.
      const error = chrome.runtime.lastError;
      if (error) handleRuntimeError(new Error(error.message));
    });
  } catch (error) {
    if (!handleRuntimeError(error)) {
      console.debug('[Hushfern Content] Runtime message could not be sent:', error);
    }
  }
}

function requestRuntimeMessage(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!extensionContextValid) {
      reject(new Error('Extension context invalidated. Refresh this page to reconnect Hushfern.'));
      return;
    }

    try {
      chrome.runtime.sendMessage(message, (response: unknown) => {
        const error = chrome.runtime.lastError;
        if (error) {
          const runtimeError = new Error(error.message);
          handleRuntimeError(runtimeError);
          reject(runtimeError);
          return;
        }
        if (!isRecord(response) || response.ok !== true) {
          reject(new Error(isRecord(response) && typeof response.error === 'string' ? response.error : 'Invalid response'));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      handleRuntimeError(error);
      reject(error);
    }
  });
}

function requestAnalysis(
  payloads: Array<{ id: string; text: string }>,
): Promise<Record<string, unknown>> {
  const requestId = createToken();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingAnalysisRequests.delete(requestId);
      reject(new Error('Local toxicity analysis timed out.'));
    }, ANALYSIS_TIMEOUT_MS);

    pendingAnalysisRequests.set(requestId, { resolve, reject, timeout });
    void requestRuntimeMessage({ type: QUEUE_ANALYSIS_TYPE, requestId, payloads }).catch((error) => {
      const pending = pendingAnalysisRequests.get(requestId);
      if (!pending) return;
      pendingAnalysisRequests.delete(requestId);
      clearTimeout(pending.timeout);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    });
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

function createDisclosure(record: AnalysisRecord): HTMLElement {
  const disclosure = document.createElement('span');
  disclosure.className = 'localguardian-a11y-disclosure';
  disclosure.dataset.localguardianUi = 'true';
  disclosure.textContent = settings.keepHiddenOnHover
    ? `Hushfern hid potentially toxic text at ${Math.round(record.score * 100)} percent. Focus this block to reveal it.`
    : `Hushfern hid potentially toxic text at ${Math.round(record.score * 100)} percent. Hover or focus this block to reveal it.`;
  return disclosure;
}

function recordForRevealTarget(target: EventTarget | null): AnalysisRecord | null {
  return target instanceof HTMLElement ? recordsByElement.get(target) ?? null : null;
}

function revealRecord(record: AnalysisRecord): void {
  if (!record.flagged) return;
  record.element.classList.add('localguardian-revealed');
  setRawContentHidden(record, false);
}

function concealRecord(record: AnalysisRecord): void {
  if (!record.flagged) return;
  record.element.classList.remove('localguardian-revealed');
  setRawContentHidden(record, true);
}

function beginReveal(event: Event): void {
  const record = recordForRevealTarget(event.currentTarget);
  if (!record || (event.type === 'mouseenter' && settings.keepHiddenOnHover)) return;
  revealRecord(record);
}

function endReveal(event: Event): void {
  const record = recordForRevealTarget(event.currentTarget);
  if (!record) return;

  setTimeout(() => {
    if (!record.flagged) return;
    const remainsRevealed = record.element.matches(':focus, :focus-within') ||
      (!settings.keepHiddenOnHover && record.element.matches(':hover'));
    if (!remainsRevealed) concealRecord(record);
  }, 0);
}

function flagRecord(record: AnalysisRecord): void {
  if (record.flagged || !document.body.contains(record.element)) return;

  record.flagged = true;
  markInternalMutation(record.element);
  record.element.classList.add('localguardian-blur');
  record.element.classList.toggle('localguardian-hover-locked', settings.keepHiddenOnHover);
  record.element.style.setProperty('--localguardian-blur-radius', `${settings.blurIntensity}px`);
  record.element.removeAttribute('title');
  if (record.element.tabIndex < 0) record.element.tabIndex = 0;

  record.hiddenContent = hideRawContent(record);
  record.disclosure = createDisclosure(record);
  record.element.append(record.disclosure);
  record.element.addEventListener('mouseenter', beginReveal);
  record.element.addEventListener('mouseleave', endReveal);
  record.element.addEventListener('focusin', beginReveal);
  record.element.addEventListener('focusout', endReveal);
}

function unflagRecord(record: AnalysisRecord): void {
  if (!record.flagged && !record.disclosure && record.hiddenContent.length === 0) return;

  record.flagged = false;
  record.element.classList.remove('localguardian-blur', 'localguardian-revealed', 'localguardian-hover-locked');
  record.element.style.removeProperty('--localguardian-blur-radius');
  record.element.removeEventListener('mouseenter', beginReveal);
  record.element.removeEventListener('mouseleave', endReveal);
  record.element.removeEventListener('focusin', beginReveal);
  record.element.removeEventListener('focusout', endReveal);
  markInternalMutation(record.element);
  record.disclosure?.remove();
  record.disclosure = null;
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
  };

  recordsByElement.set(item.element, record);
  trackedRecords.add(record);
  evaluateRecord(record);
  return record.flagged;
}

function processQueue(): void {
  if (!extensionContextValid || requestInFlight || textQueue.length === 0 || domainWhitelisted) return;

  const batch = textQueue.splice(0, BATCH_SIZE);
  const payloads = batch.map(({ id, text }) => ({ id, text }));
  requestInFlight = true;

  void requestAnalysis(payloads).then((response) => {
    requestInFlight = false;
    if (!Array.isArray(response.results)) {
      console.warn('[Hushfern Content] Analysis request failed: Invalid response');
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
  }).catch((error) => {
    requestInFlight = false;
    if (!handleRuntimeError(error)) {
      console.warn(
        '[Hushfern Content] Analysis request failed:',
        error instanceof Error ? error.message : 'Unknown error',
      );
      requeueItems(batch);
    }
  });
}

function processNode(node: Node): void {
  if (!(node instanceof Element) || domainWhitelisted || node.closest('[data-localguardian-ui]')) return;

  const elements = extractTextElements(node);
  if (elements.length > 0) {
    queueForAnalysis(elements);
    return;
  }

  const containingComment = node.closest(COMMENT_CONTAINER_SELECTOR);
  if (containingComment) queueForAnalysis(extractTextElements(containingComment));
}

function scanDocumentForUntrackedText(): void {
  if (domainWhitelisted) return;

  document.querySelectorAll<HTMLElement>(TEXT_BLOCK_SELECTOR).forEach((element) => {
    if (
      !recordsByElement.has(element) &&
      !element.dataset.localguardianToken
    ) {
      // An exact-text allowlist may have previously skipped this node. Clear
      // that terminal marker so removing the entry takes effect immediately.
      processedNodes.delete(element);
    }
  });

  const elements = [...document.querySelectorAll<HTMLElement>(TEXT_BLOCK_SELECTOR)]
    .filter(isLeafTextBlock)
    .filter(isEligibleTextElement);
  queueForAnalysis(elements);
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
      record.element.classList.toggle('localguardian-hover-locked', settings.keepHiddenOnHover);
      if (record.disclosure) {
        record.disclosure.textContent = settings.keepHiddenOnHover
          ? `Hushfern hid potentially toxic text at ${Math.round(record.score * 100)} percent. Focus this block to reveal it.`
          : `Hushfern hid potentially toxic text at ${Math.round(record.score * 100)} percent. Hover or focus this block to reveal it.`;
      }
    }
    evaluateRecord(record);
  }
  publishStats();
}

function isHushfernMutation(mutation: MutationRecord): boolean {
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
    if (isHushfernMutation(mutation)) continue;

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

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isRecord(message)) return false;

  if (message.type === PING_CONTENT_TYPE) {
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === ANALYSIS_RESULT_TYPE) {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const pending = pendingAnalysisRequests.get(requestId);
    if (!pending) {
      sendResponse({ ok: false, error: 'Analysis request is no longer active.' });
      return false;
    }

    pendingAnalysisRequests.delete(requestId);
    clearTimeout(pending.timeout);
    if (typeof message.error === 'string' && message.error.trim()) {
      pending.reject(new OffscreenModelError(message.error));
    } else if (Array.isArray(message.results)) {
      pending.resolve({ results: message.results });
    } else {
      pending.reject(new Error('The classifier delivered an invalid result.'));
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type !== 'GET_PAGE_STATS') return false;
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
  cleanupOrphanedUi();
  injectStyles();

  try {
    const stored = await storageGet([SETTINGS_STORAGE_KEY, WHITELIST_STORAGE_KEY]);
    settings = normalizeSettings(stored[SETTINGS_STORAGE_KEY]);
    applyWhitelist(stored[WHITELIST_STORAGE_KEY]);
  } catch (error) {
    console.warn('[Hushfern Content] Using default settings because storage could not be read:', error);
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
