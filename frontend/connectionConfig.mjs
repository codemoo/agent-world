const DEFAULT_PORT = 3000;
const DEFAULT_ASSET_ROOT = '/assets/pixymoon/Cute RPG World';
const DEFAULT_ENVIRONMENT = 'production';

function normalizeEnvironment(environmentValue) {
  return environmentValue === 'development' ? 'development' : DEFAULT_ENVIRONMENT;
}

function resolveRuntimeAuthToken(runtimeOptions = {}) {
  const token =
    typeof runtimeOptions.authToken === 'string' ? runtimeOptions.authToken.trim() : '';
  return token.length > 0 ? token : '';
}

export function parseSafePort(portValue, fallbackPort = DEFAULT_PORT) {
  const fallback =
    Number.isInteger(fallbackPort) && fallbackPort >= 1 && fallbackPort <= 65535
      ? fallbackPort
      : DEFAULT_PORT;

  if (portValue === null || portValue === undefined) {
    return fallback;
  }

  const raw = String(portValue).trim();
  if (!/^\d{1,5}$/.test(raw)) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }

  return parsed;
}

export function createConnectionConfig(locationLike, runtimeOptions = {}) {
  const safeLocation = locationLike || {};
  const search = typeof safeLocation.search === 'string' ? safeLocation.search : '';
  const query = new URLSearchParams(search);
  const environment = normalizeEnvironment(runtimeOptions.environment);
  const allowDevQueryToken =
    environment === 'development' && runtimeOptions.allowDevQueryToken === true;

  const apiPort = parseSafePort(query.get('apiPort'), DEFAULT_PORT);
  const wsPort = parseSafePort(query.get('wsPort') || query.get('apiPort'), apiPort);

  const runtimeAuthToken = resolveRuntimeAuthToken(runtimeOptions);
  const queryAuthToken = (query.get('authToken') || query.get('token') || '').trim();
  const authToken =
    runtimeAuthToken || (allowDevQueryToken ? queryAuthToken : '');
  const assetRoot = (query.get('assetRoot') || DEFAULT_ASSET_ROOT).trim();
  const hostname =
    typeof safeLocation.hostname === 'string' && safeLocation.hostname.trim().length > 0
      ? safeLocation.hostname.trim()
      : 'localhost';

  const apiProtocol = safeLocation.protocol === 'https:' ? 'https:' : 'http:';
  const wsProtocol = safeLocation.protocol === 'https:' ? 'wss:' : 'ws:';

  const apiBaseUrlObject = new URL(`${apiProtocol}//${hostname}`);
  apiBaseUrlObject.port = String(apiPort);

  const wsBaseUrlObject = new URL(`${wsProtocol}//${hostname}`);
  wsBaseUrlObject.port = String(wsPort);
  const wsBaseUrl = wsBaseUrlObject.toString();

  return {
    apiPort,
    wsPort,
    authToken,
    environment,
    allowDevQueryToken,
    assetRoot,
    apiBaseUrl: apiBaseUrlObject.toString().replace(/\/$/, ''),
    wsBaseUrl,
    wsUrl: wsBaseUrl
  };
}

export const CONNECTION_DEFAULTS = {
  port: DEFAULT_PORT,
  assetRoot: DEFAULT_ASSET_ROOT
};
