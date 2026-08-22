#!/usr/bin/env node
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { accessTokenAccount, clientSecretAccount, removeCredential, storeCredential } from "../dist/credentials.js";
import { getAccessToken } from "../dist/config.js";
import { adminGraphql } from "../dist/shopify.js";
import { exchangeAuthorizationCode, normalizeShop, readHidden, upsertStore, validateAlias, validateApiVersion } from "./config-helpers.mjs";

const DEFAULT_SCOPES = ["read_products", "read_orders", "read_inventory", "read_locations", "read_customers"];

function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function validHmac(url, clientSecret) {
  const received = url.searchParams.get("hmac");
  if (!received || !/^[a-f0-9]{64}$/i.test(received)) return false;
  const message = [...url.searchParams.entries()]
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const expected = createHmac("sha256", clientSecret).update(message).digest("hex");
  return timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"));
}

async function waitForAuthorization({ shop, clientId, clientSecret, scopes, port }) {
  const state = randomBytes(24).toString("hex");
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
  let resolveCallback;
  let rejectCallback;
  let callbackSettled = false;
  const callback = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", redirectUri);
      if (url.pathname !== "/oauth/callback") {
        response.writeHead(404).end("Not found");
        return;
      }
      if (callbackSettled) throw new Error("The OAuth callback was already used.");
      if (url.searchParams.get("state") !== state) throw new Error("The OAuth state did not match.");
      if (url.searchParams.get("shop") !== shop) throw new Error("The OAuth store did not match.");
      if (!validHmac(url, clientSecret)) throw new Error("The OAuth HMAC was invalid.");
      const code = url.searchParams.get("code");
      if (!code) throw new Error("Shopify did not return an authorization code.");
      callbackSettled = true;
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Shopify authorization succeeded. You can close this window.");
      resolveCallback(code);
    } catch (error) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Shopify authorization failed. Return to the terminal for details.");
      if (!callbackSettled) {
        callbackSettled = true;
        rejectCallback(error);
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const authorizeUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authorizeUrl.search = new URLSearchParams({
    client_id: clientId,
    scope: scopes.join(","),
    redirect_uri: redirectUri,
    state
  }).toString();

  process.stdout.write(`Register this redirect URL in Shopify before you continue: ${redirectUri}\n`);
  process.stdout.write(`Authorization URL: ${authorizeUrl.toString()}\n`);
  if (!openBrowser(authorizeUrl.toString())) process.stdout.write("Open the authorization URL in a browser.\n");

  const timeout = setTimeout(() => {
    if (!callbackSettled) {
      callbackSettled = true;
      rejectCallback(new Error("Shopify authorization timed out after five minutes."));
    }
  }, 5 * 60_000);
  try {
    return await callback;
  } finally {
    clearTimeout(timeout);
    await new Promise((resolve) => server.close(resolve));
  }
}

async function makeSureStoreWorks(store) {
  await getAccessToken(store);
  const result = await adminGraphql(store, "query OAuthConnectionCheck { shop { name myshopifyDomain } }", {});
  const shopInfo = result.data?.shop;
  return shopInfo && typeof shopInfo === "object" ? shopInfo : {};
}

const [modeArg, aliasArg, shopArg, apiVersionArg] = process.argv.slice(3);
const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  const modeInput = modeArg ?? await rl.question("OAuth mode [client-credentials/authorization-code]: ");
  const mode = modeInput.trim().toLowerCase();
  if (!new Set(["client-credentials", "authorization-code"]).has(mode)) throw new Error("Use client-credentials or authorization-code.");
  const alias = (aliasArg ?? await rl.question("Store alias: ")).trim().toLowerCase();
  const shop = normalizeShop(shopArg ?? await rl.question("Permanent *.myshopify.com domain: "));
  const apiVersion = (apiVersionArg ?? "2026-07").trim();
  validateAlias(alias);
  validateApiVersion(apiVersion);
  const clientId = (await rl.question("Shopify app client ID: ")).trim();
  if (!clientId) throw new Error("The client ID cannot be empty.");

  let scopes = DEFAULT_SCOPES;
  let port = 3456;
  if (mode === "authorization-code") {
    const scopeInput = (await rl.question(`Scopes [${DEFAULT_SCOPES.join(",")}]: `)).trim();
    scopes = (scopeInput || DEFAULT_SCOPES.join(",")).split(",").map((scope) => scope.trim()).filter(Boolean);
    if (!scopes.length || scopes.some((scope) => !/^[a-z_]+$/.test(scope))) throw new Error("The scope list is invalid.");
    const portInput = (await rl.question("Local callback port [3456]: ")).trim();
    port = portInput ? Number(portInput) : 3456;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Use a callback port from 1024 through 65535.");
  }
  rl.close();

  const clientSecret = await readHidden("Shopify app client secret: ");
  if (!clientSecret) throw new Error("The client secret cannot be empty.");

  if (mode === "client-credentials") {
    const store = { alias, shop, apiVersion, auth: { type: "client_credentials", clientId } };
    await storeCredential(clientSecretAccount(alias), clientSecret);
    try {
      const shopInfo = await makeSureStoreWorks(store);
      upsertStore(store);
      process.stdout.write(`Connected ${alias} to ${shopInfo.name ?? shop}. OAuth tokens will refresh automatically.\n`);
    } catch (error) {
      await removeCredential(clientSecretAccount(alias));
      throw error;
    }
  } else {
    const code = await waitForAuthorization({ shop, clientId, clientSecret, scopes, port });
    const token = await exchangeAuthorizationCode({ shop, clientId, clientSecret, code });
    const store = { alias, shop, apiVersion, auth: { type: "access_token" } };
    await storeCredential(accessTokenAccount(alias), token);
    try {
      const shopInfo = await makeSureStoreWorks(store);
      upsertStore(store);
      process.stdout.write(`Connected ${alias} to ${shopInfo.name ?? shop}.\n`);
    } catch (error) {
      await removeCredential(accessTokenAccount(alias));
      throw error;
    }
  }
} finally {
  rl.close();
}
