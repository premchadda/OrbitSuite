# OrbitSuite private administration dashboard

This is an optional, **read-only** browser panel served by the Telegram control Worker.
It displays limited route, queue, topic and archive metadata. Media bytes are never
downloaded, cached or uploaded by the panel. No external assets, cookies, analytics,
session accounts or recurring billing integrations are included.

## Activation

1. Apply `apps/worker/migrations/0012_admin_extensions.sql` after the earlier migrations.
2. Set `ORBIT_DASHBOARD_KEY` as a Worker secret to a unique random value with at least
   24 characters. Keep it separate from `BOT_TOKEN` and `WEBHOOK_SECRET`.
3. As the Telegram owner, send `/adminfeature dashboard on` to the bot.
4. Open `https://YOUR_WORKER_HOST/admin` over HTTPS and paste the dashboard key.

The key is held only in the open browser tab's memory, not in localStorage. Reloading
the page requires re-entry. Requests to `/admin/api` require an authorization header
with a bearer key; unauthenticated requests get no private counts or metadata. Page
resources use restrictive security headers and no-store caching. The panel does not
offer data mutations or public sharing.

## Telegram Mini App

A second read-only presentation is available at `/mini` for the Telegram
owner. Configure `ORBIT_PUBLIC_URL=https://YOUR_HTTPS_ORIGIN` (no path) and
enable `/adminfeature dashboard on`, then send the bot `/mini` in its private
chat to receive a Telegram Web App button. Only a server-validated, recent
Telegram `initData` HMAC for `OWNER_ID` may access `/mini/api`; no access
key or bot token is sent to the browser. The shell/JavaScript are public but
contain no account data. The Mini App requires a public HTTPS origin and an
authorized Telegram launch; it cannot function over bare local HTTP.

Verification is locally tested with independent HMAC fixtures; no live
Telegram Mini App acceptance has been performed. The legacy `/admin` page
remains separate and requires its private key.

## Related owner commands

- `/adminhelp` lists all optional administration commands.
- `/adminfeatures` displays feature switches. Each starts OFF.
- `/adminfeature moderation on` enables optional keyword moderation globally, but
  each group must also explicitly opt in with `/modchat CHAT_ID on`.
- `/modterm CHAT_ID add WORD`, `/modterms CHAT_ID`, and `/modrate CHAT_ID 5 30`
  configure group-scoped keyword and anti-flood conditions. Enable the `antiflood`
  feature separately; no automatic bans or unsolicited messages are performed.
- `/admingate CHAT_ID on` plus `/adminfeature member_gate on` configures an optional
  membership check when the caller uses `checkRequiredMembership`. The bot must have
  sufficient permission to call Telegram's `getChatMember` for that chat.
- `/adminrole USER_ID viewer|moderator|disabled` and `/adminquota USER_ID ACTION LIMIT`
  register optional access roles and daily action quotas. Enforcement is explicit via
  `checkAdminRole` and `checkAndConsumeQuota`; caller code must integrate these hooks
  at each sensitive operation. Unknown non-owner roles never get administration access.
- `/adminplan add SLUG PRICE_MINOR INR|USD|XTR` stores an **inactive draft** only. No
  payment provider, webhook, customer account or real charge is configured.

## Integration exports

The Worker imports from `apps/worker/src/admin_extensions.js`:

```js
handleAdminCommand(env, name, args, helpers); // string or null; caller sends reply
handleAdminUpdate(env, message, helpers);     // {blocked, reason?}
handleAdminHttp(request, env, helpers);       // Response or null
runAdminScheduled(env, helpers);              // cleans bounded old metadata
checkRequiredMembership(env, userId, helpers); // boolean
checkAdminRole(env, userId, permission, helpers); // boolean
checkAndConsumeQuota(env, userId, action, helpers); // {allowed,...}
renderRichMessage(blocks, buttons);           // plain text and inline buttons
createPaymentAdapter();                       // intentionally not configured
```

`helpers.ownerId`, `helpers.actorId`, `helpers.query`, `helpers.now`, and
`helpers.telegram` are provided by the host. **Never** expose the dashboard key or
bot token in the frontend, embed it in a source file, or reuse a public shared key.

The panel is optional on Cloudflare, a self-hosted Worker-compatible server or a
compatible deployment platform; it is not a requirement for the Telegram relay.
