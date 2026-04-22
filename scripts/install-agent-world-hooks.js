#!/usr/bin/env node
// CLI wrapper for hookPluginInstaller. Defaults to --dry-run for safety.
//
// Usage:
//   node scripts/install-agent-world-hooks.js           # dry-run
//   node scripts/install-agent-world-hooks.js --apply   # install
//   node scripts/install-agent-world-hooks.js --status  # check
//   node scripts/install-agent-world-hooks.js --uninstall --apply

const { install, uninstall, status } = require('../server/hookPluginInstaller');

function main() {
  const args = new Set(process.argv.slice(2));
  const apply = args.has('--apply');

  if (args.has('--status')) {
    console.log(JSON.stringify(status(), null, 2));
    return;
  }

  if (args.has('--uninstall')) {
    const result = uninstall({ dryRun: !apply });
    console.log(JSON.stringify(result, null, 2));
    if (!apply) {
      console.log('\n(dry-run) pass --apply to actually remove the plugin.');
    }
    return;
  }

  const result = install({ dryRun: !apply });
  console.log(JSON.stringify(result, null, 2));
  if (!apply) {
    console.log('\n(dry-run) pass --apply to actually install hooks.');
    console.log(`  hooks will live under ${result.pluginDir}`);
    console.log('  ~/.claude/settings.json will NOT be modified.');
  } else {
    console.log(`\nInstalled. Restart any live Claude sessions for hooks to fire.`);
  }
}

main();
