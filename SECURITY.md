# Security

## Supported versions

| Version | Security updates |
| --- | --- |
| 1.5.x | Yes |
| 1.4.x and earlier | No |

## Credential storage

Shopify Admin API access tokens are stored in macOS Keychain under the service
name `codex-shopify-multi-store`. The JSON configuration contains store aliases,
domains, and API versions only.

Never commit Shopify access tokens, OAuth client secrets, `.env` files, or a
legacy `stores.json` file containing credentials.

Use the narrowest Shopify Admin API scopes required for each store. Treat every
mutation as a production change and verify the selected store first.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
security advisory feature for this repository.

Include the affected version, reproduction steps, impact, and a minimal test case. Do not include live credentials or customer data.

## Response targets

The maintainer targets an acknowledgment within three business days. The maintainer targets an initial assessment within seven business days.

These targets are not a contractual service-level agreement. Remediation time depends on severity, complexity, and disclosure coordination.

The maintainer will credit reporters unless they request anonymity.
