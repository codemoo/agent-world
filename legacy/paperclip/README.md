# Archived Paperclip integration

Agent World was originally a visualizer for Paperclip company agents. It has
been pivoted to visualize live Claude Code CLI sessions on the local machine.
The Paperclip code is preserved here so it can be restored if Paperclip ever
comes back into the mix.

## Removed at

Parent commit before archive: `26e500039b8eeb8f01e4abfb9c0ed8ef30b2fdfd`

## What's in here

| File | Origin | Notes |
|------|--------|-------|
| `paperclipAdapter.js` | `adapter/paperclipAdapter.js` | Event normaliser + validator + applier. World-geometry bits were extracted into `adapter/worldModel.js` before the move. |
| `paperclipSync.js` | `server/paperclipSync.js` | HTTP poller for the Paperclip tunnel. |
| `CompanySelector.js` | `frontend/components/CompanySelector.js` | Frontend company dropdown. |
| `test/paperclipAdapter.test.js` | `test/paperclipAdapter.test.js` | Adapter unit tests. |
| `test/paperclipSync.test.js` | `test/paperclipSync.test.js` | Poller unit tests. |

## Running the archived tests

Archived tests are not part of the default `npm test` run. Use:

```bash
npm run test:legacy
```

## Restoring Paperclip

1. `git mv legacy/paperclip/paperclipSync.js server/paperclipSync.js`
2. `git mv legacy/paperclip/paperclipAdapter.js adapter/paperclipAdapter.js`
   and re-point its `require('../../adapter/worldModel')` back to `./worldModel`.
3. `git mv legacy/paperclip/CompanySelector.js frontend/components/CompanySelector.js`
4. `git mv legacy/paperclip/test/*.test.js test/` and drop `test:legacy` from
   `package.json`; re-add the two files to `test:unit`.
5. In `server/eventsPipeline.js` and `test/eventsPipeline.test.js` +
   `test/eventsApi.integration.test.js`, change
   `require('../legacy/paperclip/paperclipAdapter')` → `require('../adapter/paperclipAdapter')`.
6. In `server/index.js`, change
   `require('../legacy/paperclip/paperclipSync')` → `require('./paperclipSync')`.
7. In `frontend/main.js`, change
   `import('../legacy/paperclip/CompanySelector.js?v=${v}')` →
   `import('./components/CompanySelector.js?v=${v}')`.
8. Re-add any Paperclip routes that were removed during the Claude-cutover
   phase — check git history of `server/index.js` for `/sync/paperclip/*`.
