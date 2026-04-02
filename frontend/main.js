import * as PIXI from 'pixi.js';
import WorldMap from './components/WorldMap.js';

// Connect to the WebSocket server
const ws = new WebSocket(`ws://${location.hostname}:3000`);
let worldState = null;

ws.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.type === 'state') {
    worldState = message.data;
    // Re-render the world whenever state changes
    renderWorld();
  }
});

/**
 * Create the PixiJS application.
 */
const app = new PIXI.Application({
  width: 800,
  height: 600,
  backgroundColor: 0x1099bb
});

document.getElementById('root').appendChild(app.view);

function renderWorld() {
  if (!worldState) return;
  // Clear previous frame
  app.stage.removeChildren();
  // Draw zones and agents – stub example
  Object.values(worldState.agents).forEach(agent => {
    const graphics = new PIXI.Graphics();
    graphics.beginFill(0xffffff);
    graphics.drawCircle(0, 0, 10);
    graphics.endFill();
    // Position based on zone (for now random)
    graphics.x = Math.random() * app.screen.width;
    graphics.y = Math.random() * app.screen.height;
    app.stage.addChild(graphics);
  });
}