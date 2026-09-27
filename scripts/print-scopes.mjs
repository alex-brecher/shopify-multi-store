#!/usr/bin/env node
// Prints Admin API scopes as a comma-separated list, for a shopify.app.toml [access_scopes] block
// or the Dev Dashboard.
//   node scripts/print-scopes.mjs         scopes the dedicated tools need
//   node scripts/print-scopes.mjs --full  the full set for the generic action tools (see docs/ACTIONS.md)
import { allRequiredScopes, fullScopes } from "../dist/scope-requirements.js";

const full = process.argv.includes("--full");
console.log((full ? fullScopes() : allRequiredScopes()).join(","));
