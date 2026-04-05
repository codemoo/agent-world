const DEFAULT_PORT = 3102;
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

  // Port resolution:
  //   1. Explicit ?apiPort=/?wsPort= query params win.
  //   2. Otherwise use the CURRENT location.port (from how the page was loaded).
  //      This ensures external tunnels (FRP on 80/443) connect back to the
  //      same origin instead of always forcing :3102.
  //   3. If neither is set (e.g. programmatic / tests), fall back to DEFAULT_PORT.
  const rawLocationPort = typeof safeLocation.port === 'string' ? safeLocation.port : '';
  const apiPortQuery = query.get('apiPort');
  const wsPortQuery = query.get('wsPort') || query.get('apiPort');

  const explicitApiPort = apiPortQuery ? parseSafePort(apiPortQuery, DEFAULT_PORT) : null;
  const explicitWsPort = wsPortQuery ? parseSafePort(wsPortQuery, DEFAULT_PORT) : null;

  // For the numeric return values we still expose a port number so existing
  // consumers keep working. When location.port is empty it's the standard
  // port for the protocol (80 for http, 443 for https).
  const defaultStandardPort = apiProtocol === 'https:' ? 443 : 80;
  const effectiveLocationPort = rawLocationPort
    ? parseSafePort(rawLocationPort, DEFAULT_PORT)
    : (safeLocation.hostname ? defaultStandardPort : DEFAULT_PORT);
  const apiPort = explicitApiPort ?? effectiveLocationPort;
  const wsPort = explicitWsPort ?? apiPort;

  // URL construction: only SET the port on the URL when it's explicit, so
  // standard ports are omitted (https://domain.com not https://domain.com:443).
  const apiBaseUrlObject = new URL(`${apiProtocol}//${hostname}`);
  if (explicitApiPort != null) {
    apiBaseUrlObject.port = String(explicitApiPort);
  } else if (rawLocationPort) {
    apiBaseUrlObject.port = rawLocationPort;
  }

  const wsBaseUrlObject = new URL(`${wsProtocol}//${hostname}`);
  if (explicitWsPort != null) {
    wsBaseUrlObject.port = String(explicitWsPort);
  } else if (rawLocationPort) {
    wsBaseUrlObject.port = rawLocationPort;
  }
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
