import { bootstrapFrontendApp } from './appBootstrap.mjs';
import WorldMap from './components/WorldMap.js';
import { createConnectionConfig } from './connectionConfig.mjs';

const runtimeConfig =
  typeof window !== 'undefined' &&
  window.__AGENT_WORLD_RUNTIME__ &&
  typeof window.__AGENT_WORLD_RUNTIME__ === 'object'
    ? window.__AGENT_WORLD_RUNTIME__
    : {};

bootstrapFrontendApp({
  WorldMapClass: WorldMap,
  connectionConfigOptions: runtimeConfig,
  connectionConfigFactory: createConnectionConfig
});
