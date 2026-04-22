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
  import(`./components/SessionDetailPanel.js?v=${v}`),
  import(`./components/TerminalTuiView.js?v=${v}`),
  import(`./components/AgentRoster.js?v=${v}`),
  import(`./components/HelpOverlay.js?v=${v}`),
  import(`./components/HistoryBuffer.js?v=${v}`),
  import(`./components/EventLog.js?v=${v}`),
  import(`./components/TimelineScrubber.js?v=${v}`),
  import(`./components/AssetsStatusBanner.js?v=${v}`),
  import(`./connectionConfig.mjs?v=${v}`)
]).then(([boot, wm, we, sdp, tui, roster, help, hist, log, scrub, banner, cc]) => {
  boot.bootstrapFrontendApp({
    WorldMapClass: wm.default,
    WorldEditorClass: we.default,
    SessionDetailPanelClass: sdp.default,
    TerminalTuiViewClass: tui.default,
    AgentRosterClass: roster.default,
    HelpOverlayClass: help.default,
    HistoryBufferClass: hist.default,
    EventLogClass: log.default,
    TimelineScrubberClass: scrub.default,
    AssetsStatusBannerClass: banner.default,
    connectionConfigOptions: runtimeConfig,
    connectionConfigFactory: cc.createConnectionConfig
  });
});
