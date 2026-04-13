#!/usr/bin/env node
'use strict';

const { install } = require('../src/hooks');

try {
  const result = install();
  if (result.alreadyInstalled) {
    console.log('claude-context-guard: hook already configured, nothing to do.');
  } else {
    console.log('claude-context-guard: hook added to ' + result.settingsPath);
    console.log('claude-context-guard: Claude Code will now alert you when context degrades.');
  }
} catch (err) {
  // Never fail the install because of us
  console.warn('claude-context-guard: could not auto-configure hook:', err.message);
  console.warn('Run "claude-context-guard install" manually to set it up.');
}
