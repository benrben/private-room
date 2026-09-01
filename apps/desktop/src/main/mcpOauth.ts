/** Stable OAuth facade; implementation is split by protocol responsibility. */
export {
  type Pkce,
  generatePkce,
  parseWwwAuthenticate,
  wellKnownPrm,
  parseResourceMetadata,
  parsePrmScopes,
  type AuthServerMeta,
  parseAuthServerMetadata,
  buildAuthorizeUrl,
  authMetadataUrls,
  type TokenSet,
  TokenRequestError,
  saveTokens,
  loadTokens,
  clearTokens,
  needsRefresh,
  canRefresh,
  markRefreshRejected,
  mergeRefreshed,
  type RefreshOutcome,
} from "./mcpOauthModel.js";
export {
  type OutboundGuard,
  REAL_GUARD,
  redirectTarget,
  discover,
  registerClient,
  exchangeCode,
  refreshTokens,
  parseTokenResponse,
  refreshIfExpiring,
  probeWwwAuthenticate,
} from "./mcpOauthHttp.js";
export {
  bindCallback,
  parseCallbackQuery,
  callbackError,
  awaitCallback,
} from "./mcpOauthCallback.js";
export { type AuthorizeDeps, authorize } from "./mcpOauthAuthorize.js";
