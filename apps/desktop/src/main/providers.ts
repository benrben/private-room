/** Stable cloud-provider facade; implementation is split by lifecycle phase. */
export {
  CATALOG_RETRY_AFTER_MS,
  KEYCHAIN_SERVICE,
  MEDIA_MODALITIES,
  OPENROUTER_BASE_URL,
  OPENROUTER_ID,
  catalogRetryDue,
  clearKeyRejected,
  keyRejected,
  noteKeyRejected,
  readProviderKeyOnce,
  resetProviderStateForTests,
} from "./providersCore.js";
export type {
  FetchJsonLike,
  HttpJsonResponseLike,
  ModelRuntimeFacts,
  ProviderDeps,
  ProviderRuntimeConfig,
} from "./providersCore.js";
export {
  createProviderKeychainFfiForTests,
  defaultProviderDeps,
  deleteDefaultProviderKey,
  deleteKey,
  readKey,
  storeDefaultProviderKey,
  storeKey,
} from "./providersKeychain.js";
export type { ProviderKeychainDeps } from "./providersKeychain.js";
export {
  ensureProviderCatalog,
  isApiProviderModel,
  listProviderModels,
  mediaCatalogPath,
  openrouterKey,
  parseOpenrouterModels,
  probeOpenrouterModelSelection,
  providerConnected,
  providerModelFacts,
  providerModelSelectable,
  providerModelVision,
} from "./providersCatalog.js";
export {
  connectAiProvider,
  disconnectAiProvider,
  injectProviderRuntime,
  listAiProviders,
  providerRuntimeConfig,
  providerRuntimeConfigWire,
} from "./providersRuntime.js";
