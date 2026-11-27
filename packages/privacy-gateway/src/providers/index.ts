export { DETECT_PROVIDERS, OCR_PROVIDERS, WORKER_PROVIDERS } from "./catalog.ts";
export type { ProviderCapabilities, ProviderCatalogEntry, ProviderField } from "./catalog.ts";
export { makeDetectProvider } from "./detectProviders.ts";
export { makeOcrProvider } from "./ocrProviders.ts";
export type { OcrRuntime } from "./ocrProviders.ts";
export { ProviderError, toPublicConfig } from "./types.ts";
export type {
  DetectProvider,
  DetectProviderConfig,
  DetectProviderId,
  GoogleSecrets,
  OcrProvider,
  OcrProviderConfig,
  OcrProviderId,
  OpenAiAuthScheme,
  ProviderHealthResult,
  ProviderProblemKind,
  ProviderRuntime,
  PublicProviderConfig,
  WorkerHealthResult,
  WorkerProvider,
  WorkerProviderConfig,
  WorkerProviderId,
} from "./types.ts";
export { makeWorkerProvider } from "./workerProviders.ts";
