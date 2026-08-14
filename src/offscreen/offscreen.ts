import { env, pipeline } from '@huggingface/transformers';
import ortWasmFactoryUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortWasmBinaryUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';

// Transformers.js otherwise points an offscreen window at jsDelivr for these
// ONNX runtime files. MV3 forbids remotely hosted executable code, so both the
// factory module and binary must resolve to assets packaged by Vite.
const wasmBackend = env.backends.onnx.wasm;
if (!wasmBackend) {
  throw new Error('The packaged ONNX WASM backend is unavailable.');
}
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
  const webGpuBackend = env.backends.onnx.webgpu;
  if (!navigator.gpu || !webGpuBackend) return false;

  try {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });
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
      console.log('[LocalGuardian Offscreen] Initializing toxic-bert model...');
      const startTime = performance.now();

      let instance: TextClassifier;
      if (await configureWebGpuAdapter()) {
        try {
          instance = await createClassifier('webgpu');
        } catch {
          // WebGPU session creation can still fail after adapter discovery
          // (for example after a device loss). This is an expected fallback,
          // so avoid logging the caught Error object as an extension error.
          console.info('[LocalGuardian Offscreen] WebGPU unavailable; using WASM.');
          instance = await createClassifier('wasm');
        }
      } else {
        console.info('[LocalGuardian Offscreen] No usable WebGPU adapter; using WASM.');
        instance = await createClassifier('wasm');
      }

      classifierInstance = instance;
      console.log(
        `[LocalGuardian Offscreen] Model loaded in ${(performance.now() - startTime).toFixed(2)}ms.`,
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
      console.error(`[LocalGuardian Offscreen] Classification failed for item ${item.id}:`, error);
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

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isRecord(message) || message.type !== OFFSCREEN_ANALYZE_TYPE) return false;

  // Content scripts have a tab sender. Only extension-owned, tabless contexts
  // (the background service worker) may use this internal inference protocol.
  if (sender.id !== chrome.runtime.id || sender.tab) return false;

  let request: OffscreenAnalyzeRequest;
  try {
    request = validateRequest(message);
  } catch (error) {
    console.error('[LocalGuardian Offscreen] Rejected invalid analysis request:', error);
    sendResponse({
      type: OFFSCREEN_RESULT_TYPE,
      requestId: typeof message.requestId === 'string' ? message.requestId : '',
      results: [],
      error: 'The offscreen classifier received an invalid request.',
    } satisfies OffscreenAnalyzeResponse);
    return false;
  }

  void enqueueAnalysis(request)
    .then(sendResponse)
    .catch((error) => {
      console.error('[LocalGuardian Offscreen] Batch analysis failed:', error);
      sendResponse({
        type: OFFSCREEN_RESULT_TYPE,
        requestId: request.requestId,
        results: [],
        error: 'The local toxicity classifier is unavailable.',
      } satisfies OffscreenAnalyzeResponse);
    });
  return true;
});
