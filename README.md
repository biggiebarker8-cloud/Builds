# The Alliance — agency workspace

A standalone agency operations dashboard, starting in Australia with optional UK
planning. It runs separately from TikTok Backstage and Lark. No plugins, sample
performance figures, third-party JavaScript, or external package dependencies.

## What works now

- Persistent creator roster: onboarding status, manager, market, LIVE hours,
  target hours, and recorded revenue.
- Task tracking with due dates and completion.
- Market-specific summaries: AUD and GBP are never added together.
- CSV roster export, search, and agency settings.
- Australian timezone selection and an optional UK planning workspace.
- Owner and Manager sign-in with server-enforced permissions.
- Owner-only manual payment and administrative-charge records.
- An optional real Lark test-message integration.

Performance numbers are **manual cumulative records**, not live TikTok data,
verified earnings, dated analytics, invoices, or payout calculations.
`sarcasm_the_alliance` is initially a label only; no account is linked.
UK planning does not establish TikTok approval for the UK market.

The **Agency link** shortcut opens the TikTok URL supplied by the agency owner:
https://www.tiktok.com/t/ZSg8eb83Q/. It is an external shortcut, not an account
connection or a verified Backstage destination.

Official **TikTok for Business** (`https://www.tiktok.com/business/en`) and
**TikTok Ads Manager** (`https://ads.tiktok.com/`) shortcuts are also available
to both roles. They open externally with your own TikTok sign-in, without account
linking, ad sync, or campaign automation. Dashboard roles do not restrict external
TikTok billing or ad-spend permissions: configure those separately within TikTok.

## Access roles

| Capability | Owner | Manager |
| --- | --- | --- |
| Creator roster, performance revenue, task management | Yes | Yes |
| Roster CSV export and connection status | Yes | Yes |
| Send configured Lark test message | Yes | Yes |
| Agency administration / settings changes | Yes | No |
| View, create, edit, delete payment records | Yes | No |
| View, create, edit, delete administrative charges | Yes | No |

The existing `AGENCY_ADMIN_TOKEN` now signs in as **Owner**; it retains full
access. To enable **Manager**, set `AGENCY_MANAGER_TOKEN` to a different
randomly generated token of at least 32 characters and restart. If it is not
set, Manager login is disabled. Each role uses the same sign-in form: the server
determines the role from the credential, not from a role selection in the browser.
Never give the owner token to managers. Rotate a token and restart to revoke
its access; a restart clears all sessions.

Managers can still record creator **performance revenue**, which is separate
from payments and administrative charges. They can read the agency settings
needed for normal operations but cannot change them. Permissions are checked
on the server, including direct API calls. The manager's state response excludes
the finance ledger.

**Payments & charges** is a manual ledger. Records have a type, description,
AU/AUD or UK/GBP market, positive amount, record date, and status (pending,
recorded manually, or void). Saving a record does not send money, charge anyone,
or verify settlement. No payment processor, bank account, tax treatment, or
commission calculation is integrated. Do not store banking or card details here.
Records can be corrected or permanently deleted by the owner; this is not an
immutable accounting or audit system.

## Start locally

Requires **Node.js 24 or newer**. No `npm install` is needed.

```sh
cd /home/runner/work/Builds/Builds
export AGENCY_ADMIN_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
npm start
```

Open `http://127.0.0.1:3000`. Paste the value of `AGENCY_ADMIN_TOKEN` into
the sign-in form. Keep it in your password manager; do not commit it or share
it in chat. This is a workspace administrator credential, **not** your TikTok
or Lark password. Keep the same token available for subsequent server starts
or generate a new one to rotate it.

The default listener is local-only. The SQLite database is stored under
`data/`, excluded from Git. Settings, creators, and tasks survive restarts.
Sessions do not: sign in again after a restart.

Use the environment variable names in `.env.example`. Node does not automatically
load that file; export the variables in your shell or use
`node --env-file=.env server.js` with a private, untracked `.env` file.

## Optional Lark connection

The dashboard works without Lark. To enable the test-message action:

1. Create an internal application in your own Lark developer console.
2. Enable its bot and the official permission to send messages as that bot.
   Publish/approve it under your organisation's app policies.
3. Add the bot to the intended chat and obtain that chat's ID using the
   officially available Lark tooling.
4. Set `LARK_APP_ID`, `LARK_APP_SECRET`, and `LARK_CHAT_ID` in your server's
   secret environment and restart the application.
5. In **Connections**, choose **Send a real test message**.

The server requests a tenant access token and sends a message using
`open.larksuite.com`'s official APIs. Secrets stay on the server.
“Configured” means values are present, not that credentials or permissions have
been verified. A successful test confirms that message only. There is no
automatic roster, calendar, or task sync. Feishu-specific deployments are not
supported by this connector.

## TikTok access

TikTok is deliberately **not connected**. The application does not scrape
Backstage, request TikTok passwords, use unofficial plugins, or claim a public
agency API exists for your account. Confirm available agency permissions and
approved AU/UK integration documentation with your TikTok representative before
implementing a connector. No main-account access is needed to use this workspace.

## Before hosting or inviting a team

This is an initial **two-role workspace**, not a complete enterprise agency
platform. Credentials are shared per role, not individual staff accounts.
Do not share either role's token with creators.

- Put it behind HTTPS and an authenticated hosting boundary; configure the
  server's public origin as documented in `.env.example` when using a proxy.
  Do not expose the local HTTP development server directly to the internet.
- Use a private persistent disk for the database. A single server instance is
  expected; in-memory sessions and login rate limits are not distributed.
- Add individual accounts, audit trails, and secure
  account recovery before granting staff or creators direct access.
- Establish privacy notices, retention/deletion rules, access controls, and
  backups before storing real creator information. Keep regular database
  backups outside the repository; stop the server before copying the database
  and associated journal files.
- Arrange hosting, DNS, monitoring, and tested restore procedures. None are
  provisioned by this repository.

Contracts, recruitment automation, notifications beyond the Lark test message,
payment transfers or collection, commission processing, and official TikTok synchronisation are not
implemented. These require separately scoped work and, where applicable,
verified platform permissions.

## Validation

```sh
npm test
npm run check
```

Tests use Node's built-in test runner, temporary databases, and local HTTP
servers. No real TikTok or Lark credentials are required.
