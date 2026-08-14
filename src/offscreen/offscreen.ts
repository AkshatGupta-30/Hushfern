import { env, pipeline } from '@huggingface/transformers';
import ortWasmFactoryUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortWasmBinaryUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';

// The release build packages a pinned, hash-verified model under /models.
// Disable every runtime fallback to the Hugging Face Hub so the extension's
// executable inference graph is fully contained in the reviewed MV3 package.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = chrome.runtime.getURL('models/');

// Transformers.js otherwise points an offscreen window at jsDelivr for these
// ONNX runtime files. MV3 forbids remotely hosted executable code, so both the
// factory module and binary must resolve to assets packaged by Vite.
const wasmBackend = env.backends.onnx.wasm;
if (!wasmBackend) {
  throw new Error('The packaged ONNX WASM backend is unavailable.');
}
// Transformers.js defaults ONNX Runtime to `high-performance`, but Chromium
// ignores that requestAdapter option on Windows and records it as an extension
// warning. Leaving the supported optional flag unset preserves WebGPU while
// letting Chrome choose the adapter without the ignored option.
const webGpuBackend = env.backends.onnx.webgpu;
if (webGpuBackend) delete webGpuBackend.powerPreference;
// The cache helper converts the factory module to a blob URL. Extension-page
// CSP intentionally permits only self-hosted scripts, so import the packaged
// module directly instead; model files still use the normal browser cache.
env.useWasmCache = false;
wasmBackend.wasmPaths = {
  mjs: new URL(ortWasmFactoryUrl, globalThis.location.href).href,
  wasm: new URL(ortWasmBinaryUrl, globalThis.location.href).href,
};

const OFFSCREEN_ANALYZE_TYPE = 'OFFSCREEN_ANALYZE_BATCH';
const OFFSCREEN_RESULT_TYPE = 'OFFSCREEN_ANALYZE_BATCH_RESULT';
const OFFSCREEN_WARMUP_TYPE = 'OFFSCREEN_WARMUP';
const OFFSCREEN_DELIVERY_TYPE = 'OFFSCREEN_ANALYSIS_READY';
const OFFSCREEN_ACTIVITY_STARTED_TYPE = 'OFFSCREEN_ANALYSIS_STARTED';
const OFFSCREEN_ACTIVITY_FINISHED_TYPE = 'OFFSCREEN_ANALYSIS_FINISHED';
const TOXIC_LABEL = 'toxic';
const MAX_BATCH_SIZE = 50;
const MAX_TEXT_LENGTH = 50_000;

interface AnalyzeItem {
  id: string;
  text: string;
}

interface OffscreenAnalyzeRequest {
  type: typeof OFFSCREEN_ANALYZE_TYPE;
  requestId: string;
  payloads: AnalyzeItem[];
  tabId: number;
  frameId: number;
}

interface OffscreenScore {
  id: string;
  score: number;
}

interface OffscreenAnalyzeResponse {
  type: typeof OFFSCREEN_RESULT_TYPE;
  requestId: string;
  results: OffscreenScore[];
  error?: string;
}

type TextClassifier = (text: string, options: { top_k: null }) => Promise<unknown>;

let classifierInstance: TextClassifier | null = null;
let classifierLoadPromise: Promise<TextClassifier> | null = null;
// Running one batch at a time avoids competing WebGPU/WASM sessions and large
// transient allocations when several tabs request inference simultaneously.
let inferenceQueue: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateRequest(value: Record<string, unknown>): OffscreenAnalyzeRequest {
  if (
    typeof value.requestId !== 'string' ||
    !value.requestId ||
    value.requestId.length > 200
  ) {
    throw new Error('requestId must be a non-empty string');
  }
  if (!Array.isArray(value.payloads)) throw new Error('payloads must be an array');
  if (value.payloads.length > MAX_BATCH_SIZE) {
    throw new Error(`payloads cannot exceed ${MAX_BATCH_SIZE} items`);
  }
  if (!Number.isInteger(value.tabId) || !Number.isInteger(value.frameId)) {
    throw new Error('tabId and frameId must be integers');
  }

  const ids = new Set<string>();
  const payloads = value.payloads.map((rawItem, index) => {
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

  return {
    type: OFFSCREEN_ANALYZE_TYPE,
    requestId: value.requestId,
    payloads,
    tabId: value.tabId as number,
    frameId: value.frameId as number,
  };
}

async function createClassifier(device: 'webgpu' | 'wasm'): Promise<TextClassifier> {
  const instance = await pipeline('text-classification', 'Xenova/toxic-bert', {
    device,
    // The q8 weights for this checkpoint produce nearly flat scores on WASM.
    // Preserve the existing input-sensitive fp32 behavior in this long-lived
    // document instead of holding the 438 MB model in the service worker.
    dtype: 'fp32',
  });
  return instance as unknown as TextClassifier;
}

async function configureWebGpuAdapter(): Promise<boolean> {
  if (!navigator.gpu || !webGpuBackend) return false;

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return false;

    // ONNX Runtime otherwise performs this probe during backend startup. A
    // browser may expose navigator.gpu while policy, drivers, or the blocklist
    // still prevent an adapter from being created; preflighting keeps that
    // expected condition out of Chrome's extension error list.
    webGpuBackend.adapter = adapter;
    return true;
  } catch {
    return false;
  }
}

async function getClassifier(): Promise<TextClassifier> {
  if (classifierInstance) return classifierInstance;

  if (!classifierLoadPromise) {
    classifierLoadPromise = (async () => {
      console.log('[Hushfern Offscreen] Initializing toxic-bert model...');
      const startTime = performance.now();

      let instance: TextClassifier;
      if (await configureWebGpuAdapter()) {
        try {
          instance = await createClassifier('webgpu');
        } catch {
          // WebGPU session creation can still fail after adapter discovery
          // (for example after a device loss). This is an expected fallback,
          // so avoid logging the caught Error object as an extension error.
          console.info('[Hushfern Offscreen] WebGPU unavailable; using WASM.');
          instance = await createClassifier('wasm');
        }
      } else {
        console.info('[Hushfern Offscreen] No usable WebGPU adapter; using WASM.');
        instance = await createClassifier('wasm');
      }

      classifierInstance = instance;
      console.log(
        `[Hushfern Offscreen] Model loaded in ${(performance.now() - startTime).toFixed(2)}ms.`,
      );
      return instance;
    })().catch((error) => {
      // Allow a later request to retry after a transient download, GPU, or
      // storage failure instead of retaining a rejected promise forever.
      classifierInstance = null;
      classifierLoadPromise = null;
      throw error;
    });
  }

  return classifierLoadPromise;
}

function extractToxicityScore(rawOutput: unknown): number {
  const output =
    Array.isArray(rawOutput) && Array.isArray(rawOutput[0])
      ? rawOutput[0]
      : rawOutput;

  if (!Array.isArray(output) || output.length === 0) {
    throw new Error('Classifier returned no labels');
  }

  const toxicResult = output.find(
    (candidate) => isRecord(candidate) && candidate.label === TOXIC_LABEL,
  );
  if (!isRecord(toxicResult)) {
    throw new Error('Classifier response did not include the toxic label');
  }

  const score = toxicResult.score;
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw new Error('Classifier returned an invalid toxicity score');
  }
  return Math.min(1, Math.max(0, score));
}

async function analyze(request: OffscreenAnalyzeRequest): Promise<OffscreenAnalyzeResponse> {
  const classifier = await getClassifier();
  const results: OffscreenScore[] = [];

  for (const item of request.payloads) {
    try {
      // toxic-bert is multi-label. top_k: null is required so the independent
      // toxic sigmoid score is available even when another label ranks first.
      const rawOutput = await classifier(item.text, { top_k: null });
      results.push({ id: item.id, score: extractToxicityScore(rawOutput) });
    } catch (error) {
      // Omit failed IDs so the content script retains its existing retry path.
      // Never log page text; opaque IDs are sufficient for diagnostics.
      console.error(`[Hushfern Offscreen] Classification failed for item ${item.id}:`, error);
    }
  }

  return {
    type: OFFSCREEN_RESULT_TYPE,
    requestId: request.requestId,
    results,
  };
}

function enqueueAnalysis(request: OffscreenAnalyzeRequest): Promise<OffscreenAnalyzeResponse> {
  const operation = inferenceQueue.then(() => analyze(request));
  inferenceQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

function notifyBackground(type: string): void {
  try {
    chrome.runtime.sendMessage({ type }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // The background worker may be restarting. Completion still reaches the
    // content page; the next request can recreate this document if necessary.
  }
}

function deliverAnalysisResult(
  request: OffscreenAnalyzeRequest,
  response: OffscreenAnalyzeResponse,
): void {
  try {
    chrome.runtime.sendMessage(
      {
        type: OFFSCREEN_DELIVERY_TYPE,
        requestId: request.requestId,
        tabId: request.tabId,
        frameId: request.frameId,
        results: response.results,
        ...(response.error ? { error: response.error } : {}),
      },
      () => {
        void chrome.runtime.lastError;
      },
    );
  } catch {
    // Navigation or extension reload can remove the destination before a
    // completed result is relayed. The page will submit fresh work if needed.
  }
}

function warmUpClassifier(sendResponse: (response?: unknown) => void): void {
  // Acknowledge before starting the large download. The offscreen document
  // remains alive independently if the installation service worker suspends.
  sendResponse({ ok: true });
  notifyBackground(OFFSCREEN_ACTIVITY_STARTED_TYPE);
  void getClassifier()
    .then(() => {
      console.log('[Hushfern Offscreen] Classifier warm-up complete.');
    })
    .catch((error) => {
      console.error('[Hushfern Offscreen] Classifier warm-up failed:', error);
    })
    .finally(() => {
      notifyBackground(OFFSCREEN_ACTIVITY_FINISHED_TYPE);
    });
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isRecord(message)) return false;

  if (message.type === OFFSCREEN_WARMUP_TYPE) {
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    warmUpClassifier(sendResponse);
    return false;
  }

  if (message.type !== OFFSCREEN_ANALYZE_TYPE) return false;

  // Only the extension's tabless background worker may assign the tab/frame
  // delivery route for an inference job.
  if (sender.id !== chrome.runtime.id || sender.tab) return false;

  let request: OffscreenAnalyzeRequest;
  try {
    request = validateRequest(message);
  } catch (error) {
    console.error('[Hushfern Offscreen] Rejected invalid analysis request:', error);
    sendResponse({
      type: OFFSCREEN_RESULT_TYPE,
      requestId: typeof message.requestId === 'string' ? message.requestId : '',
      results: [],
      error: 'The offscreen classifier received an invalid request.',
    } satisfies OffscreenAnalyzeResponse);
    return false;
  }

  // Accept the job synchronously. Results are delivered later through the
  // background relay, so model download/inference never holds a message port.
  sendResponse({ ok: true });
  notifyBackground(OFFSCREEN_ACTIVITY_STARTED_TYPE);
  void enqueueAnalysis(request)
    .then((response) => {
      deliverAnalysisResult(request, response);
      notifyBackground(OFFSCREEN_ACTIVITY_FINISHED_TYPE);
    })
    .catch((error) => {
      console.error('[Hushfern Offscreen] Batch analysis failed:', error);
      deliverAnalysisResult(request, {
        type: OFFSCREEN_RESULT_TYPE,
        requestId: request.requestId,
        results: [],
        error: 'The local toxicity classifier is unavailable.',
      });
      notifyBackground(OFFSCREEN_ACTIVITY_FINISHED_TYPE);
    });
  return false;
});
