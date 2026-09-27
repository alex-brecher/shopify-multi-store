#!/usr/bin/env node
// Prints the comma-separated union of every Admin API scope any tool in this
// server might need, for pasting into a shopify.app.toml [access_scopes] block.
import { allRequiredScopes } from "../dist/scope-requirements.js";

console.log(allRequiredScopes().join(","));
