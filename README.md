# Agent World

Agent World is a visualization layer for multi‑agent systems. It connects to an underlying orchestration platform (such as [Paperclip](https://paperclipai.net)) and renders the behaviour of your agents as a living, breathing world.

## Project structure

This repository is organised into several packages:

- **server** – a lightweight Node/Express process that ingests events from your agent runtime (e.g. Paperclip) and maintains an in‑memory world state. It also exposes a WebSocket endpoint to broadcast state updates to connected clients.
- **adapter** – code responsible for translating your specific agent platform’s events into the normalised format used by Agent World. A `paperclipAdapter.js` is included as a starting point. Additional adapters (e.g. for OpenClaw, Claude Code) can be added here later.
- **frontend** – a React + PixiJS client that draws the 2D map, agents, zones and animations. It connects to the server via WebSockets and updates the UI in real time.
- **assets/pixymoon** – a placeholder for your purchased PixyMoon tile set and sprite assets. These files are not tracked in git; see below.

## Getting started

1. Purchase the **2D Topdown Cute RPG World** pack from PixyMoon (or another compatible tile set).
2. Extract the entire **Cute RPG World** directory into `assets/pixymoon/`. Your tile sheet images should live at `assets/pixymoon/Cute RPG World/...`.
3. Install dependencies and start the server:

```bash
cd server
npm install
node index.js
```

4. Open another terminal and start the frontend development server:

```bash
cd frontend
npm install
npm start
```

The React app will connect to `ws://localhost:3000` by default and render your agent world.

## PixyMoon assets

The files under `assets/pixymoon/` are intentionally ignored by git. You must purchase the asset pack yourself and place the files here. See `assets/pixymoon/README.md` for details.

## License

This project is provided under the MIT License. You are responsible for ensuring you have the appropriate rights to any third‑party assets used (such as tile sets and sprites).