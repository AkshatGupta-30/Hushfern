export {};

const SETTINGS_STORAGE_KEY = 'localGuardianSettings';
const WHITELIST_STORAGE_KEY = 'localGuardianWhitelist';
const ANALYTICS_STORAGE_KEY = 'localGuardianAnalytics';
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const OFFSCREEN_ANALYZE_TYPE = 'OFFSCREEN_ANALYZE_BATCH';
const OFFSCREEN_RESULT_TYPE = 'OFFSCREEN_ANALYZE_BATCH_RESULT';
const OFFSCREEN_WARMUP_TYPE = 'OFFSCREEN_WARMUP';
const OFFSCREEN_DELIVERY_TYPE = 'OFFSCREEN_ANALYSIS_READY';
const OFFSCREEN_ACTIVITY_STARTED_TYPE = 'OFFSCREEN_ANALYSIS_STARTED';
const OFFSCREEN_ACTIVITY_FINISHED_TYPE = 'OFFSCREEN_ANALYSIS_FINISHED';
const QUEUE_ANALYSIS_TYPE = 'QUEUE_ANALYSIS';
const ANALYSIS_RESULT_TYPE = 'ANALYSIS_RESULT';
const PING_CONTENT_TYPE = 'PING_CONTENT';
const OFFSCREEN_IDLE_TIMEOUT_MS = 5 * 60_000;

const DEFAULT_SETTINGS = {
  toxicityThreshold: 50,
  blurIntensity: 8,
  keepHiddenOnHover: true,
};

const DEFAULT_WHITELIST = {
  texts: [],
  domains: [],
};

const ANALYTICS_RETENTION_DAYS = 90;
const MAX_BATCH_SIZE = 50;
const MAX_TEXT_LENGTH = 50_000;
const MAX_WHITELIST_ENTRIES = 100;

type HushfernSettings = typeof DEFAULT_SETTINGS;

interface AnalyticsCounts {
  analyzed: number;
  toxic: number;
  falsePositives: number;
}

interface AnalyticsDay extends AnalyticsCounts {
  domains: Record<string, AnalyticsCounts>;
  hours: Record<string, AnalyticsCounts>;
}

interface HushfernAnalytics {
  days: Record<string, AnalyticsDay>;
  totals: AnalyticsCounts;
  updatedAt: string;
}

interface AnalyzeItem {
  id: string;
  text: string;
}

interface OffscreenScore {
  id: string;
  score: number;
}

interface AnalyticsDelta extends AnalyticsCounts {
  domain: string;
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

const EMPTY_COUNTS: AnalyticsCounts = {
  analyzed: 0,
  toxic: 0,
  falsePositives: 0,
};

// All analytics read-modify-write cycles pass through this queue. That avoids
// losing increments when multiple content-script messages arrive together.
let analyticsUpdateQueue: Promise<void> = Promise.resolve();
// A single shared setup promise prevents concurrent batches from racing two
// createDocument calls while the offscreen page is starting.
let offscreenSetupPromise: Promise<void> | null = null;
let whitelistUpdateQueue: Promise<void> = Promise.resolve();
let offscreenIdleTimer: ReturnType<typeof setTimeout> | null = null;
let activeOffscreenRequests = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

function sanitizedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function sanitizeSettings(value: unknown): HushfernSettings {
  const settings = isRecord(value) ? value : {};

  return {
    toxicityThreshold: sanitizedInteger(settings.toxicityThreshold, 40, 80, DEFAULT_SETTINGS.toxicityThreshold),
    blurIntensity: sanitizedInteger(settings.blurIntensity, 3, 10, DEFAULT_SETTINGS.blurIntensity),
    keepHiddenOnHover: settings.keepHiddenOnHover === true,
  };
}

function sanitizeWhitelist(value: unknown): HushfernWhitelist {
  const source = isRecord(value) ? value : {};
  const texts: WhitelistTextEntry[] = [];
  const domains: WhitelistDomainEntry[] = [];
  const seenTexts = new Set<string>();
  const seenDomains = new Set<string>();

  if (Array.isArray(source.texts)) {
    for (const rawEntry of source.texts) {
      const entry: Record<string, unknown> = isRecord(rawEntry) ? rawEntry : { text: rawEntry };
      const text = typeof entry.text === 'string' ? entry.text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LENGTH) : '';
      if (!text || seenTexts.has(text)) continue;
      seenTexts.add(text);
      texts.push({
        text,
        domain: typeof entry.domain === 'string' ? entry.domain.trim().toLowerCase().slice(0, 253) : '',
        addedAt: typeof entry.addedAt === 'number' && Number.isFinite(entry.addedAt) ? entry.addedAt : 0,
      });
      if (texts.length >= MAX_WHITELIST_ENTRIES) break;
    }
  }

  if (Array.isArray(source.domains)) {
    for (const rawEntry of source.domains) {
      const entry: Record<string, unknown> = isRecord(rawEntry) ? rawEntry : { domain: rawEntry };
      const domain = typeof entry.domain === 'string' ? entry.domain.trim().toLowerCase().slice(0, 253) : '';
      if (!domain || seenDomains.has(domain)) continue;
      seenDomains.add(domain);
      domains.push({
        domain,
        addedAt: typeof entry.addedAt === 'number' && Number.isFinite(entry.addedAt) ? entry.addedAt : 0,
      });
      if (domains.length >= MAX_WHITELIST_ENTRIES) break;
    }
  }

  return { texts, domains };
}

function updateWhitelist(
  operation: 'addText' | 'removeText' | 'addDomain' | 'removeDomain',
  sender: chrome.runtime.MessageSender,
  value: unknown,
): Promise<HushfernWhitelist> {
  let result: HushfernWhitelist | null = null;
  const update = whitelistUpdateQueue.then(async () => {
    const stored = await chrome.storage.local.get(WHITELIST_STORAGE_KEY);
    const whitelist = sanitizeWhitelist(stored[WHITELIST_STORAGE_KEY]);
    const senderDomain = getSenderDomain(sender);

    if (operation === 'addText' || operation === 'removeText') {
      const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LENGTH) : '';
      if (!text) throw new Error('Text allowlist entry is empty.');
      if (operation === 'addText') {
        whitelist.texts = [
          { text, domain: senderDomain === 'unknown' ? '' : senderDomain, addedAt: Date.now() },
          ...whitelist.texts.filter((entry) => entry.text !== text),
        ].slice(0, MAX_WHITELIST_ENTRIES);
      } else {
        whitelist.texts = whitelist.texts.filter((entry) => entry.text !== text);
      }
    } else {
      const requestedDomain = typeof value === 'string' ? value.trim().toLowerCase().slice(0, 253) : '';
      const domain = operation === 'removeDomain'
        ? requestedDomain
        : senderDomain !== 'unknown'
          ? senderDomain
          : requestedDomain;
      if (!domain || domain === 'unknown') throw new Error('Domain allowlist entry is invalid.');

      if (operation === 'addDomain') {
        whitelist.domains = [
          { domain, addedAt: Date.now() },
          ...whitelist.domains.filter((entry) => entry.domain !== domain),
        ].slice(0, MAX_WHITELIST_ENTRIES);
      } else {
        whitelist.domains = whitelist.domains.filter((entry) => entry.domain !== domain);
      }
    }

    await chrome.storage.local.set({ [WHITELIST_STORAGE_KEY]: whitelist });
    result = whitelist;
  });

  whitelistUpdateQueue = update.catch((error) => {
    console.error('[Hushfern BG] Whitelist update failed:', error);
  });

  return update.then(() => result as HushfernWhitelist);
}

function sanitizedCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function sanitizeCounts(value: unknown): AnalyticsCounts {
  const counts = isRecord(value) ? value : {};

  return {
    analyzed: sanitizedCount(counts.analyzed),
    toxic: sanitizedCount(counts.toxic),
    falsePositives: sanitizedCount(counts.falsePositives),
  };
}

function createEmptyAnalytics(): HushfernAnalytics {
  return {
    days: {},
    totals: { ...EMPTY_COUNTS },
    updatedAt: new Date().toISOString(),
  };
}

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localHourKey(date = new Date()): string {
  return String(date.getHours()).padStart(2, '0');
}

function sanitizeAnalytics(value: unknown): HushfernAnalytics {
  if (!isRecord(value)) return createEmptyAnalytics();

  const days: Record<string, AnalyticsDay> = {};
  const rawDays = isRecord(value.days) ? value.days : {};

  for (const [date, rawDay] of Object.entries(rawDays)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRecord(rawDay)) continue;

    const counts = sanitizeCounts(rawDay);
    const domains: Record<string, AnalyticsCounts> = {};
    const hours: Record<string, AnalyticsCounts> = {};
    const rawDomains = isRecord(rawDay.domains) ? rawDay.domains : {};

    for (const [domain, rawCounts] of Object.entries(rawDomains)) {
      if (!domain || domain.length > 253) continue;
      setOwn(domains, domain, sanitizeCounts(rawCounts));
    }

    const rawHours = isRecord(rawDay.hours) ? rawDay.hours : {};
    for (const [hour, rawCounts] of Object.entries(rawHours)) {
      if (!/^(?:0\d|1\d|2[0-3])$/.test(hour)) continue;
      setOwn(hours, hour, sanitizeCounts(rawCounts));
    }

    setOwn(days, date, { ...counts, domains, hours });
  }

  const analytics = {
    days,
    totals: sanitizeCounts(value.totals),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
  };

  pruneAnalyticsDays(analytics);
  return analytics;
}

function pruneAnalyticsDays(analytics: HushfernAnalytics): void {
  const cutoffDate = new Date();
  cutoffDate.setHours(0, 0, 0, 0);
  cutoffDate.setDate(cutoffDate.getDate() - (ANALYTICS_RETENTION_DAYS - 1));
  const cutoffKey = localDateKey(cutoffDate);

  for (const date of Object.keys(analytics.days)) {
    if (date < cutoffKey) delete analytics.days[date];
  }

  const retainedDates = Object.keys(analytics.days).sort();
  for (const date of retainedDates.slice(0, Math.max(0, retainedDates.length - ANALYTICS_RETENTION_DAYS))) {
    delete analytics.days[date];
  }
}

function getSenderDomain(sender: chrome.runtime.MessageSender): string {
  const candidateUrl = sender.tab?.url ?? sender.url;
  if (!candidateUrl) return 'unknown';

  try {
    const hostname = new URL(candidateUrl).hostname.trim().toLowerCase();
    return hostname && hostname.length <= 253 ? hostname : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function getSettings(): Promise<HushfernSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  return sanitizeSettings(stored[SETTINGS_STORAGE_KEY]);
}

async function initializeStorageDefaults(): Promise<void> {
  const stored = await chrome.storage.local.get([
    SETTINGS_STORAGE_KEY,
    WHITELIST_STORAGE_KEY,
    ANALYTICS_STORAGE_KEY,
  ]);
  const updates: Record<string, unknown> = {};

  const rawSettings = stored[SETTINGS_STORAGE_KEY];
  if (!isRecord(rawSettings)) {
    updates[SETTINGS_STORAGE_KEY] = { ...DEFAULT_SETTINGS };
  } else {
    const settingsWithDefaults = { ...rawSettings };
    let changed = false;

    if (!hasOwn(rawSettings, 'toxicityThreshold')) {
      settingsWithDefaults.toxicityThreshold = DEFAULT_SETTINGS.toxicityThreshold;
      changed = true;
    }
    if (!hasOwn(rawSettings, 'blurIntensity')) {
      settingsWithDefaults.blurIntensity = DEFAULT_SETTINGS.blurIntensity;
      changed = true;
    }
    if (!hasOwn(rawSettings, 'keepHiddenOnHover')) {
      settingsWithDefaults.keepHiddenOnHover = DEFAULT_SETTINGS.keepHiddenOnHover;
      changed = true;
    }
    if (changed) updates[SETTINGS_STORAGE_KEY] = settingsWithDefaults;
  }

  const rawWhitelist = stored[WHITELIST_STORAGE_KEY];
  if (!isRecord(rawWhitelist)) {
    updates[WHITELIST_STORAGE_KEY] = { ...DEFAULT_WHITELIST, texts: [], domains: [] };
  } else {
    const whitelistWithDefaults = { ...rawWhitelist };
    let changed = false;

    if (!hasOwn(rawWhitelist, 'texts')) {
      whitelistWithDefaults.texts = [];
      changed = true;
    }
    if (!hasOwn(rawWhitelist, 'domains')) {
      whitelistWithDefaults.domains = [];
      changed = true;
    }
    if (changed) updates[WHITELIST_STORAGE_KEY] = whitelistWithDefaults;
  }

  const rawAnalytics = stored[ANALYTICS_STORAGE_KEY];
  if (!isRecord(rawAnalytics)) {
    updates[ANALYTICS_STORAGE_KEY] = createEmptyAnalytics();
  } else {
    const analyticsWithDefaults = { ...rawAnalytics };
    let changed = false;

    if (!hasOwn(rawAnalytics, 'days')) {
      analyticsWithDefaults.days = {};
      changed = true;
    }
    if (!hasOwn(rawAnalytics, 'totals')) {
      analyticsWithDefaults.totals = { ...EMPTY_COUNTS };
      changed = true;
    }
    if (!hasOwn(rawAnalytics, 'updatedAt')) {
      analyticsWithDefaults.updatedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) updates[ANALYTICS_STORAGE_KEY] = analyticsWithDefaults;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

function recordAnalytics(delta: AnalyticsDelta): Promise<void> {
  const operation = analyticsUpdateQueue.then(async () => {
    const stored = await chrome.storage.local.get(ANALYTICS_STORAGE_KEY);
    const analytics = sanitizeAnalytics(stored[ANALYTICS_STORAGE_KEY]);
    const today = localDateKey();

    if (!hasOwn(analytics.days as unknown as Record<string, unknown>, today)) {
      setOwn(analytics.days, today, { ...EMPTY_COUNTS, domains: {}, hours: {} });
    }

    const day = analytics.days[today];
    day.analyzed += delta.analyzed;
    day.toxic += delta.toxic;
    day.falsePositives += delta.falsePositives;

    const hour = localHourKey();
    if (!hasOwn(day.hours as unknown as Record<string, unknown>, hour)) {
      setOwn(day.hours, hour, { ...EMPTY_COUNTS });
    }
    const hourly = day.hours[hour];
    hourly.analyzed += delta.analyzed;
    hourly.toxic += delta.toxic;
    hourly.falsePositives += delta.falsePositives;

    if (!hasOwn(day.domains as unknown as Record<string, unknown>, delta.domain)) {
      setOwn(day.domains, delta.domain, { ...EMPTY_COUNTS });
    }

    const domain = day.domains[delta.domain];
    domain.analyzed += delta.analyzed;
    domain.toxic += delta.toxic;
    domain.falsePositives += delta.falsePositives;

    analytics.totals.analyzed += delta.analyzed;
    analytics.totals.toxic += delta.toxic;
    analytics.totals.falsePositives += delta.falsePositives;
    analytics.updatedAt = new Date().toISOString();
    pruneAnalyticsDays(analytics);

    await chrome.storage.local.set({ [ANALYTICS_STORAGE_KEY]: analytics });
  });

  analyticsUpdateQueue = operation.catch((error) => {
    console.error('[Hushfern BG] Analytics storage update failed:', error);
  });

  return operation;
}

function validateBatch(value: unknown): AnalyzeItem[] {
  if (!Array.isArray(value)) throw new Error('payloads must be an array');
  if (value.length > MAX_BATCH_SIZE) throw new Error(`payloads cannot exceed ${MAX_BATCH_SIZE} items`);

  const ids = new Set<string>();
  return value.map((rawItem, index) => {
    if (!isRecord(rawItem)) throw new Error(`payloads[${index}] must be an object`);
    if (typeof rawItem.id !== 'string' || !rawItem.id || rawItem.id.length > 200) {
      throw new Error(`payloads[${index}].id must be a non-empty string`);
    }
    if (ids.has(rawItem.id)) throw new Error(`payloads[${index}].id must be unique`);
    if (typeof rawItem.text !== 'string' || !rawItem.text.trim()) {
      throw new Error(`payloads[${index}].text must be a non-empty string`);
    }
    if (rawItem.text.length > MAX_TEXT_LENGTH) {
      throw new Error(`payloads[${index}].text exceeds ${MAX_TEXT_LENGTH} characters`);
    }

    ids.add(rawItem.id);
    return { id: rawItem.id, text: rawItem.text };
  });
}

async function hasOffscreenDocument(): Promise<boolean> {
  // hasDocument is the direct API on current Chrome versions. getContexts is
  // retained as a compatibility path for versions that shipped offscreen
  // documents before hasDocument.
  if (typeof chrome.offscreen.hasDocument === 'function') {
    return chrome.offscreen.hasDocument();
  }

  if (typeof chrome.runtime.getContexts !== 'function') {
    throw new Error('This Chrome version cannot inspect offscreen documents.');
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (!offscreenSetupPromise) {
    offscreenSetupPromise = (async () => {
      if (await hasOffscreenDocument()) return;

      try {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_DOCUMENT_PATH,
          reasons: [chrome.offscreen.Reason.WORKERS],
          justification: 'Run the on-device toxicity model and its WebGPU/WASM workers outside the service worker.',
        });
      } catch (error) {
        // Chrome permits one offscreen document per extension profile. If a
        // concurrent extension context won the race, that document is exactly
        // the context this worker intended to reuse.
        if (await hasOffscreenDocument()) return;
        throw error;
      }
    })();
  }

  const setupPromise = offscreenSetupPromise;
  try {
    await setupPromise;
  } finally {
    if (offscreenSetupPromise === setupPromise) offscreenSetupPromise = null;
  }
}

async function sendOffscreenCommand(message: Record<string, unknown>): Promise<unknown> {
  let lastError: unknown = new Error('The offscreen document did not respond.');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await ensureOffscreenDocument();
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

async function warmUpClassifier(): Promise<void> {
  const response = await sendOffscreenCommand({ type: OFFSCREEN_WARMUP_TYPE });
  if (!isRecord(response) || response.ok !== true) {
    throw new Error(
      isRecord(response) && typeof response.error === 'string'
        ? response.error
        : 'The offscreen classifier did not accept the warm-up request.',
    );
  }
}

async function queueAnalysisJob(
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId ?? 0;
  const requestId = message.requestId;
  if (!Number.isInteger(tabId)) throw new Error('Analysis requests must come from a browser tab.');
  if (typeof requestId !== 'string' || !requestId || requestId.length > 200) {
    throw new Error('Analysis request ID is invalid.');
  }

  const payloads = validateBatch(message.payloads);
  const response = await sendOffscreenCommand({
    type: OFFSCREEN_ANALYZE_TYPE,
    requestId,
    payloads,
    tabId,
    frameId,
  });
  if (!isRecord(response) || response.ok !== true) {
    throw new Error(
      isRecord(response) && typeof response.error === 'string'
        ? response.error
        : 'The offscreen classifier did not accept the analysis job.',
    );
  }
}

async function deliverAnalysisResult(message: Record<string, unknown>): Promise<void> {
  const tabId = message.tabId;
  const frameId = message.frameId;
  const requestId = message.requestId;
  if (!Number.isInteger(tabId) || !Number.isInteger(frameId)) {
    throw new Error('The offscreen result has an invalid tab destination.');
  }
  if (typeof requestId !== 'string' || !requestId || requestId.length > 200) {
    throw new Error('The offscreen result has an invalid request ID.');
  }
  if (!Array.isArray(message.results)) throw new Error('The offscreen result list is invalid.');

  await chrome.tabs.sendMessage(
    tabId as number,
    {
      type: ANALYSIS_RESULT_TYPE,
      requestId,
      results: message.results,
      ...(typeof message.error === 'string' ? { error: message.error } : {}),
    },
    { frameId: frameId as number },
  );
}

async function reinjectContentIntoOpenTabs(): Promise<void> {
  // Give Chrome's static content-script registration a moment to populate any
  // pages it handles automatically, then inject only where no live instance
  // answers. This also replaces invalidated scripts after an unpacked reload.
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map(async (tab) => {
    if (!Number.isInteger(tab.id)) return;
    try {
      const response: unknown = await chrome.tabs.sendMessage(tab.id as number, { type: PING_CONTENT_TYPE });
      if (isRecord(response) && response.ok === true) return;
    } catch {
      // No live content script is expected for an already-open tab after an
      // install/update. Injection failures on protected pages are also normal.
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id as number },
        files: ['content.js'],
      });
    } catch {
      // Chrome-owned pages, the Web Store, and other protected URLs reject
      // programmatic injection and remain outside extension control.
    }
  }));
}

function scheduleOffscreenIdleClose(): void {
  if (offscreenIdleTimer) clearTimeout(offscreenIdleTimer);
  offscreenIdleTimer = setTimeout(() => {
    offscreenIdleTimer = null;
    if (activeOffscreenRequests > 0) return;
    void hasOffscreenDocument()
      .then((exists) => exists ? chrome.offscreen.closeDocument() : undefined)
      .catch((error) => console.debug('[Hushfern BG] Offscreen idle cleanup skipped:', error));
  }, OFFSCREEN_IDLE_TIMEOUT_MS);
}

function isMatchingOffscreenResponse(
  value: unknown,
  requestId: string,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.type === OFFSCREEN_RESULT_TYPE &&
    value.requestId === requestId
  );
}

function validateOffscreenResponse(
  value: unknown,
  requestId: string,
  payloads: AnalyzeItem[],
): OffscreenScore[] {
  if (!isMatchingOffscreenResponse(value, requestId)) {
    throw new Error('The offscreen classifier returned an invalid response envelope.');
  }

  if (typeof value.error === 'string' && value.error.trim()) {
    throw new Error(value.error);
  }
  const rawResults = value.results;
  if (!Array.isArray(rawResults) || rawResults.length > payloads.length) {
    throw new Error('The offscreen classifier returned an invalid results list.');
  }

  const expectedIds = new Set(payloads.map((payload) => payload.id));
  const seenIds = new Set<string>();
  return rawResults.map((rawResult: unknown, index: number) => {
    if (!isRecord(rawResult)) {
      throw new Error(`Offscreen result ${index} must be an object.`);
    }

    const { id, score } = rawResult;
    if (typeof id !== 'string' || !expectedIds.has(id) || seenIds.has(id)) {
      throw new Error(`Offscreen result ${index} has an invalid or duplicate ID.`);
    }
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
      throw new Error(`Offscreen result ${index} has an invalid toxicity score.`);
    }

    seenIds.add(id);
    return { id, score };
  });
}

async function requestOffscreenScores(payloads: AnalyzeItem[]): Promise<OffscreenScore[]> {
  activeOffscreenRequests += 1;
  if (offscreenIdleTimer) {
    clearTimeout(offscreenIdleTimer);
    offscreenIdleTimer = null;
  }
  const requestId = crypto.randomUUID();
  let lastTransportError: unknown = new Error('The offscreen classifier did not respond.');

  // Creation resolves once Chrome has installed the document, but the module's
  // message listener can still be a tick behind on a cold start. Retry only
  // missing/invalid transport responses; model errors are returned immediately.
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await ensureOffscreenDocument();

      let response: unknown;
      let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
      try {
      // Chrome 110+ resets the extension service-worker idle timer on API
      // calls. A lightweight call keeps this message response alive during the
      // first large model download without moving model memory back into the
      // service worker.
      keepAliveTimer = setInterval(() => {
        void chrome.runtime.getPlatformInfo().catch(() => undefined);
      }, 20_000);
      response = await chrome.runtime.sendMessage({ type: OFFSCREEN_ANALYZE_TYPE, requestId, payloads });
      } catch (error) {
        lastTransportError = error;
        response = undefined;
      } finally {
        if (keepAliveTimer !== undefined) clearInterval(keepAliveTimer);
      }

      if (isMatchingOffscreenResponse(response, requestId)) {
      // A matching envelope reached the classifier. Validation errors are
      // model/request failures, not transport races, so propagate them without
      // repeating an expensive initialization attempt.
        return validateOffscreenResponse(response, requestId, payloads);
      }
      lastTransportError = new Error('The offscreen classifier returned an invalid response envelope.');

      if (attempt === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }

    throw lastTransportError;
  } finally {
    activeOffscreenRequests = Math.max(0, activeOffscreenRequests - 1);
    scheduleOffscreenIdleClose();
  }
}

async function updateBadge(tabId: number, toxicCount: number, enabled: boolean): Promise<void> {
  if (!chrome.action) return;

  const shouldShow = enabled && toxicCount > 0;
  const badgeText = shouldShow ? (toxicCount > 999 ? '999+' : String(toxicCount)) : '';

  await chrome.action.setBadgeText({ tabId, text: badgeText });
  await chrome.action.setTitle({
    tabId,
    title: shouldShow
      ? `Hushfern: ${toxicCount} toxic block${toxicCount === 1 ? '' : 's'} on this page`
      : 'Hushfern',
  });

  if (shouldShow) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#B42318' });
  }
}

async function analyzeBatch(message: Record<string, unknown>) {
  const payloads = validateBatch(message.payloads);
  const scores = await requestOffscreenScores(payloads);
  // Read once for every received batch, after any initial model download, so a
  // freshly changed threshold takes effect without restarting the extension.
  const settings = await getSettings();
  const threshold = settings.toxicityThreshold / 100;
  const results = scores.map(({ id, score }) => {
    const isToxic = score >= threshold;
    console.debug(
      `[Hushfern BG] ${isToxic ? 'Flagged' : 'Analyzed'} ${id}: ${(score * 100).toFixed(2)}% (toxic)`,
    );
    return { id, isToxic, score };
  });

  return { results };
}

function validatePageStats(value: unknown): {
  toxicCount: number;
  analyzedCount: number;
  hostname: string;
  enabled: boolean;
} {
  if (!isRecord(value)) throw new Error('stats must be an object');

  const { toxicCount, analyzedCount, hostname, enabled } = value;
  if (!Number.isSafeInteger(toxicCount) || (toxicCount as number) < 0) {
    throw new Error('stats.toxicCount must be a non-negative integer');
  }
  if (!Number.isSafeInteger(analyzedCount) || (analyzedCount as number) < 0) {
    throw new Error('stats.analyzedCount must be a non-negative integer');
  }
  if ((toxicCount as number) > (analyzedCount as number)) {
    throw new Error('stats.toxicCount cannot exceed stats.analyzedCount');
  }
  if (typeof hostname !== 'string' || hostname.length > 253) {
    throw new Error('stats.hostname must be a valid string');
  }
  if (typeof enabled !== 'boolean') {
    throw new Error('stats.enabled must be a boolean');
  }

  return {
    toxicCount: toxicCount as number,
    analyzedCount: analyzedCount as number,
    hostname,
    enabled,
  };
}

chrome.runtime.onInstalled.addListener(() => {
  void initializeStorageDefaults().catch((error) => {
    console.error('[Hushfern BG] Failed to initialize storage defaults:', error);
  });
  // Start the large model download immediately after install/update. The
  // offscreen document acknowledges synchronously and owns the long-running
  // download, so this event does not depend on service-worker lifetime.
  void warmUpClassifier().catch((error) => {
    console.error('[Hushfern BG] Classifier warm-up could not be started:', error);
  });
  void reinjectContentIntoOpenTabs().catch((error) => {
    console.error('[Hushfern BG] Could not reconnect existing website tabs:', error);
  });
});

// Handle incoming checks, analytics events, and live page-count badge updates.
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isRecord(message) || typeof message.type !== 'string') {
    sendResponse({ ok: false, error: 'Message must contain a string type.' });
    return false;
  }

  // Internal offscreen requests are broadcast with runtime.sendMessage. The
  // service worker must not answer one: the offscreen document's response is
  // the only response the requesting promise should observe.
  if (message.type === OFFSCREEN_ANALYZE_TYPE) return false;
  if (message.type === OFFSCREEN_WARMUP_TYPE) return false;

  if (message.type === OFFSCREEN_DELIVERY_TYPE) {
    const isTrustedOffscreenSender =
      sender.id === chrome.runtime.id &&
      !sender.tab &&
      sender.url === chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
    if (!isTrustedOffscreenSender) {
      sendResponse({ ok: false, error: 'Offscreen result sender is invalid.' });
      return false;
    }

    sendResponse({ ok: true });
    void deliverAnalysisResult(message).catch((error) => {
      console.debug('[Hushfern BG] Analysis result could not be delivered:', error);
    });
    return false;
  }

  if (message.type === QUEUE_ANALYSIS_TYPE) {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId ?? 0;
    const requestId = message.requestId;
    try {
      if (!Number.isInteger(tabId)) throw new Error('Analysis requests must come from a browser tab.');
      if (typeof requestId !== 'string' || !requestId || requestId.length > 200) {
        throw new Error('Analysis request ID is invalid.');
      }
      validateBatch(message.payloads);
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : 'The analysis job is invalid.',
      });
      return false;
    }

    // Acknowledge synchronously; every later success/failure uses the separate
    // ANALYSIS_RESULT message and cannot produce an async channel-closed error.
    sendResponse({ ok: true });
    void queueAnalysisJob(message, sender).catch((error) => {
      console.error('[Hushfern BG] Could not queue analysis:', error);
      void chrome.tabs.sendMessage(
        tabId as number,
        {
          type: ANALYSIS_RESULT_TYPE,
          requestId,
          results: [],
          error: error instanceof Error ? error.message : 'The analysis job could not be queued.',
        },
        { frameId },
      ).catch(() => undefined);
    });
    return false;
  }

  if (message.type === OFFSCREEN_ACTIVITY_STARTED_TYPE) {
    activeOffscreenRequests += 1;
    if (offscreenIdleTimer) {
      clearTimeout(offscreenIdleTimer);
      offscreenIdleTimer = null;
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === OFFSCREEN_ACTIVITY_FINISHED_TYPE) {
    activeOffscreenRequests = Math.max(0, activeOffscreenRequests - 1);
    scheduleOffscreenIdleClose();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'PREPARE_ANALYZER') {
    if (offscreenIdleTimer) {
      clearTimeout(offscreenIdleTimer);
      offscreenIdleTimer = null;
    }
    void ensureOffscreenDocument()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error('[Hushfern BG] Could not prepare the offscreen classifier:', error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'The local classifier could not be prepared.',
        });
      });
    return true;
  }

  if (message.type === 'ANALYZE_BATCH') {
    // Compatibility response for a content script left behind by an extension
    // reload. Current builds use QUEUE_ANALYSIS and never hold this channel.
    sendResponse({ results: [], error: 'Reloaded analysis protocol is no longer active.' });
    return false;
  }

  if (message.type === 'RECORD_FALSE_POSITIVE') {
    void recordAnalytics({
      analyzed: 0,
      toxic: 0,
      falsePositives: 1,
      domain: getSenderDomain(sender),
    })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error('[Hushfern BG] Could not record false positive:', error);
        sendResponse({ ok: false, error: 'The false-positive event could not be saved.' });
      });
    return true;
  }

  if (message.type === 'UPDATE_WHITELIST') {
    const operation = message.operation;
    if (operation !== 'addText' && operation !== 'removeText' && operation !== 'addDomain' && operation !== 'removeDomain') {
      sendResponse({ ok: false, error: 'Whitelist operation is invalid.' });
      return false;
    }

    void updateWhitelist(operation, sender, message.value)
      .then((whitelist) => sendResponse({ ok: true, whitelist }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Whitelist update failed.',
        });
      });
    return true;
  }

  if (message.type === 'RECORD_APPLIED_RESULTS') {
    const analyzed = sanitizedCount(message.analyzed);
    const toxic = sanitizedCount(message.toxic);
    if (analyzed === 0 || toxic > analyzed) {
      sendResponse({ ok: false, error: 'Applied result counts are invalid.' });
      return false;
    }

    void recordAnalytics({
      analyzed,
      toxic,
      falsePositives: 0,
      domain: getSenderDomain(sender),
    })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error('[Hushfern BG] Could not record applied results:', error);
        sendResponse({ ok: false, error: 'Applied result analytics could not be saved.' });
      });
    return true;
  }

  if (message.type === 'PAGE_STATS_UPDATED') {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, error: 'PAGE_STATS_UPDATED must come from a browser tab.' });
      return false;
    }

    try {
      const stats = validatePageStats(message.stats ?? message.payload);
      void updateBadge(tabId as number, stats.toxicCount, stats.enabled)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => {
          console.error('[Hushfern BG] Could not update action badge:', error);
          sendResponse({ ok: false, error: 'The action badge could not be updated.' });
        });
      return true;
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : 'Invalid page stats.',
      });
      return false;
    }
  }

  sendResponse({ ok: false, error: `Unsupported message type: ${message.type}` });
  return false;
});

// A tab-specific badge can otherwise briefly show a count from the previous
// document while a navigation is loading.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;

  void updateBadge(tabId, 0, false).catch((error) => {
    console.error('[Hushfern BG] Could not clear action badge:', error);
  });
});
