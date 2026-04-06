// Dynamic imports with a per-load cache-buster query param. This bypasses
// the browser's aggressive ES module cache so frontend edits propagate on
// every page load without the user needing to clear cache manually.
const v = `${Date.now()}`;

const runtimeConfig =
  typeof window !== 'undefined' &&
  window.__AGENT_WORLD_RUNTIME__ &&
  typeof window.__AGENT_WORLD_RUNTIME__ === 'object'
    ? window.__AGENT_WORLD_RUNTIME__
    : {};

Promise.all([
  import(`./appBootstrap.mjs?v=${v}`),
  import(`./components/WorldMap.js?v=${v}`),
  import(`./components/WorldEditor.js?v=${v}`),
  import(`./components/CompanySelector.js?v=${v}`),
  import(`./connectionConfig.mjs?v=${v}`)
]).then(([boot, wm, we, cs, cc]) => {
  boot.bootstrapFrontendApp({
    WorldMapClass: wm.default,
    WorldEditorClass: we.default,
    CompanySelectorClass: cs.default,
    connectionConfigOptions: runtimeConfig,
    connectionConfigFactory: cc.createConnectionConfig
  });
});
