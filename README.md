# VORTEXIA STORE — Discord Shop Bot

A Discord-only Node.js / Discord.js v14 shop bot with a local SQLite database, product catalog, order creation, manual payment verification, private inventory, and administrator controls.

> **Important:** This is a functional starter implementation, not a claim that every feature in the large specification is complete or independently security-audited. The current command set is listed below. Do not process high-value real orders until you have tested the full payment and delivery flow in a private test server.

## Requirements

- Node.js 20 or newer (use a supported Node.js LTS version)
- A Discord application and bot
- Hosting with persistent disk storage
- Permission to run native Node.js dependencies (`better-sqlite3`)

## Install

1. Extract the ZIP.
2. Open a terminal in the extracted project folder.
3. Run `npm install`.
4. Copy `.env.example` to `.env`.
5. Set `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, and `ADMIN_USER_IDS`.
6. Configure payment numbers and, optionally, `ADMIN_LOG_CHANNEL_ID`.
7. Run `npm run check`.
8. Run `npm test`.
9. Register commands using `npm run register`.
10. Start using `npm start`.

Use `GUILD_ID` for fast development-server registration. Leave it empty only if you intentionally want global command registration, which may take longer to propagate.

## Discord setup

In the Discord Developer Portal, create an application, add a bot, copy its token, and invite it to your test server with `bot` and `applications.commands` scopes. Enable the privileged **Server Members Intent** for `/dmall`; without it, the member cache may be incomplete. Grant only needed channel permissions. Never share the token or commit `.env`.

## Available commands

Customer and utility:
- `/shop`
- `/categories`
- `/search`
- `/product`
- `/buy`
- `/my-orders`
- `/track-order`
- `/payment-methods`
- `/payment-submit`
- `/help`
- `/ping`, `/uptime`, `/botinfo`, `/serverinfo`, `/userinfo`, `/avatar`
- `/redeem` (apply a configured coupon to a pending order)
- `/stock`, `/payment-status`, `/order-info`
- `/dm-optout` (opt out of server-wide bot DMs)

Admin:
- `/dm`, `/dmall`, `/announce`, `/embed`, `/say`, `/purge`, `/warn`, `/lock`, `/maintenance`
- `/admin-product-add`
- `/admin-stock-add`
- `/admin-orders`
- `/admin-approve`
- `/admin-deliver`
- `/admin-stats`
- `/admin-backup`
- `/admin-coupon-create`

Admin commands are gated by configured `ADMIN_USER_IDS`/`ADMIN_ROLE_IDS` or Discord Administrator permission. The bot also needs the relevant Discord channel permissions for posting, deleting, or locking. Set comma-separated numeric IDs without spaces if convenient.

### Professional `/embed` builder

`/embed channel:#announcements` opens an interactive, ephemeral Embed Builder inspired by a button-based builder panel. Use buttons to set title, description, HEX color (default `#FF6A00`), image, thumbnail, footer, author/icon, up to three fields, up to two HTTPS link buttons, title URL, and timestamp. Preview updates after each modal submission. Publish sends the embed to the selected text/announcement channel; Reset clears the draft, Clear Fields removes custom fields, and Close ends the session. Only admins can use the builder. Drafts are held in memory and expire on bot restart; embed content is not written to the audit log. Ensure the bot has View Channel, Send Messages, and Embed Links permissions.

## Order workflow

1. Admin creates a product with `/admin-product-add`.
2. Admin adds inventory using `/admin-stock-add` in a private admin context. Never paste real secrets into a public channel.
3. Customer creates an order with `/buy`.
4. Customer views payment instructions with `/payment-methods`.
5. Customer submits the transaction using `/payment-submit`.
6. An administrator independently verifies the transaction outside the bot, then uses `/admin-orders` and `/admin-approve`.
7. Only a PAID order can be sent using `/admin-deliver`.

**The bot does not verify bKash, Nagad, or Rocket automatically.** Automatic verification requires official provider API access and a documented provider adapter. A transaction ID alone is not proof of payment.

## Persistent storage

By default the database is `./data/vortexia.sqlite`. Configure `DB_PATH` to a persistent disk path supplied by your hosting panel. Ensure the path survives restarts and redeployments. SQLite is appropriate for a single bot process on a persistent local disk; do not put its live database on an unreliable network filesystem.

## Backup

Use `/admin-backup` or run the included database backup logic through the bot. Backups are written to `./backups`. Secure this directory and copy backups off-host periodically. A restore procedure should be tested against a separate database before production use.

## Hosting panel

Set the startup command to `npm start`. Use `npm run register` after adding or changing commands. Configure environment variables in the panel if it does not preserve `.env`. Keep the process running under the host's supported process manager and use persistent storage for `data/` and `backups/`.

## Troubleshooting

- **Missing configuration:** copy `.env.example` to `.env` and set the required values.
- **Commands do not appear:** confirm `CLIENT_ID`, bot token, scopes, and `GUILD_ID`; rerun `npm run register`.
- **Database disappears after restart:** configure a persistent storage path and point `DB_PATH` there.
- **better-sqlite3 install fails:** select a compatible Node LTS runtime and hosting image with native build support.
- **DM delivery fails:** customer must allow DMs from the server; order remains PAID for staff recovery.
- **Payment approval denied:** verify the user ID or role ID is configured and the transaction independently confirmed.

## Current limitations

Reseller commands now include `/reseller-transactions`, `/reseller-withdraw`, and `/leaderboard`, plus admin-only `/admin-withdrawals` and `/admin-withdrawal-review`. Withdrawal requests are recorded for manual staff processing; no payout API is integrated. The following are not yet implemented in this starter: wallet deposit/top-up flow, refunds, support ticket creation, reviews, full admin CRUD, advanced analytics, automatic provider API verification, scheduled low-stock alerts, a full migration framework, an automated restore command, and comprehensive integration/concurrency tests. Coupon discounts update the order total only while it is still `PENDING_PAYMENT`; create coupons with `/admin-coupon-create`. Redeem before submitting payment. These must be implemented and tested before describing the bot as production-ready.

## Security notes

- Never put secrets in source files or logs.
- Never share stock credentials in public channels.
- Keep backups private.
- Only approve payments after independent verification.
- Test using synthetic stock and a private Discord server first.

## Added command behavior and caveats

- `/dmall` is restricted to administrators, limited to 25 cached members per run, waits 2 seconds between successful/failed send attempts, and has a persistent 10-minute per-server cooldown. It skips users who used `/dm-optout opt_out:true`. It relies on the privileged Server Members Intent and member cache; it is not a guarantee that every server member is loaded.
- `/redeem` only applies to a `PENDING_PAYMENT` order. Admins create codes with `/admin-coupon-create`. Redeem before submitting payment. Fixed discounts are in BDT; percentage discounts are capped at 100%.
- `/maintenance on` blocks new `/buy` orders and shop browsing for non-admins. It does not stop existing payment review or delivery.
- `/warn` records warnings in SQLite and attempts a DM. It does not automatically timeout or ban users.
- `/purge` deletes up to 100 recent messages; Discord will skip messages older than 14 days.
- `/payment-status` and `/order-info` only expose order details to the owner or an administrator.


### Reseller withdrawal workflow

- Only users already marked `APPROVED` in the `resellers` table can view their transactions or request a withdrawal.
- `/reseller-withdraw` accepts an amount, payout method, and payout details; details are kept in the SQLite database and displayed only in the ephemeral admin withdrawal list.
- `/admin-withdrawals` lists pending requests. `/admin-withdrawal-review` can approve or reject a request. Approval deducts the wallet balance and records a negative wallet transaction; an actual bKash/Nagad/Rocket/LTC payout must still be sent manually.
- `/leaderboard` ranks approved resellers by recorded positive wallet transactions, **not verified sales revenue**.


### Manual product delivery

Admins can use `/delivery user product` to DM a product name, license, or other delivery details to a selected customer. The command reports success only after Discord accepts the DM and records the outcome without storing product secrets in the audit log. It does **not** mark an order as delivered. For a paid shop order using reserved inventory, use `/admin-deliver order_id` instead; that workflow updates inventory and order status.


### Product price embeds
The interactive `/embed` builder includes **Product & Prices** for product name, HTTPS photo URL, reseller price, retail price, and stock status. The **Profit ON/OFF** button toggles the displayed price difference. Product price embeds are published only when `RESELLER_ROLE_ID` is configured and the destination channel denies `ViewChannel` to `@everyone` while explicitly allowing it for that reseller role. Configure the channel's other role/member permissions carefully; Discord's channel permission system determines who can view it.


## Shop design and inventory commands

- `/shop` now uses a dark premium VORTEXIA STORE embed with product IDs, BDT prices, live available-stock counts, low/out-of-stock labels, and action buttons (Purchase, Hypixel, DonutSMP, Capes, Reseller Price).
- The reseller-price button only displays reseller prices to members with the configured `RESELLER_ROLE_ID`. Products need a matching name/category (for example `Capes`) to appear under category buttons.
- `/stock` shows public available stock counts.
- `/admin-stock-list` (admin only) shows available/reserved/delivered counts and up to 10 available stock item IDs per product.
- `/admin-stock-update` (admin only): choose `Add item` and provide a secret `value`, or choose `Remove available item` and provide a stock item ID from `/admin-stock-list`. Removed stock is marked `REMOVED`; it is not deleted from the database.
- `/admin-stock-add` remains available for adding one stock item.

After replacing your project files, run `npm install`, configure `.env`, then run `npm run register` to refresh slash commands and `npm start` to start the bot. The image reference is represented with a dark embed layout and buttons; to display a custom product banner/logo inside Discord, add a public HTTPS image URL in the embed builder or configure one in the source.


## Fix log (latest)

- **`/shop`, `/search` crashed with many products** – the embed exceeded Discord's 4096-character limit. The list now always fits and ends with "...and N more" when needed.
- **Shop buttons did nothing** – Purchase, Hypixel, DonutSMP, Capes and Reseller Price now work (category buttons match the product name, description or category; Reseller Price needs `RESELLER_ROLE_ID` and a reseller price on the product).
- **`/embed` panel was rejected by Discord** – one button row had 6 buttons (max 5) and two buttons used invalid emoji. Fixed.
- **`/admin-backup`** could answer before Discord accepted the first reply; it now defers and edits the reply. `/purge` also defers.
- **`/dmall`** now tries to load the member list first (needs Server Members Intent).
- **Startup** no longer dies if the Server Members Intent is disabled in the Developer Portal: the bot starts without it (only `/dmall` is limited). Clearer error for an invalid token.
- **Compatibility aliases restored** (`/commands`, `/product-list`, `/wallet`, `/balance`, `/database-backup`, ...). They reuse the original handlers, so admin aliases stay admin-only. `/help` shows only the main commands.
- **Reseller system could never be used** – there was no way to approve a reseller. New admin commands: `/admin-reseller-set` (approve/suspend) and `/admin-wallet-credit` (add balance). `/admin-product-add` has an optional `reseller_price`.
- Added `.env.example` and `tests/flow.test.js` (mocked end-to-end tests for every command; run with `npm test`).

After updating files run `npm install`, then `npm run register` (new commands must be re-registered), then `npm start`. A fresh database has **no products**: add some with `/admin-product-add` and `/admin-stock-add` or `/shop` will show "No products found".


## Local dashboard

The bot now starts a web dashboard together with itself. Open **http://localhost:3000** in a browser on the same computer.

- **Password:** set `DASHBOARD_PASSWORD` in `.env`. If it is empty, a random password is printed in the console on every start (`[dashboard] Password for this run: ...`).
- **Pages:** Overview (bot status, sales, low stock, maintenance switch), Products (add/edit/hide, reseller prices), Stock (bulk add, remove; secret values are never shown), Orders (details, deliver by DM, cancel), Payments (approve/reject), Resellers (approve/suspend, add balance, withdrawal requests), Coupons, **Embed sender** (live preview, fields, link buttons, send to any channel), Audit log.
- **Safe by default:** it listens on `127.0.0.1` only, so nothing outside your computer can reach it. Login rate limit, HttpOnly session cookie, CSRF protection and Host/Origin checks are built in. If you host the bot on a remote panel/VPS, do **not** change `DASHBOARD_HOST` to `0.0.0.0` without HTTPS in front of it; use an SSH tunnel (`ssh -L 3000:127.0.0.1:3000 server`) instead.
- Settings: `DASHBOARD_ENABLED`, `DASHBOARD_HOST`, `DASHBOARD_PORT`, `DASHBOARD_PASSWORD` (see `.env.example`). If the port is busy the bot still starts, only the dashboard is skipped.

## New in this version

- `/cancel-order` (customers cancel their own unpaid order) and `/admin-reject` (reject a payment; the order returns to PENDING_PAYMENT so the customer can resubmit).
- Unpaid orders are cancelled automatically after `ORDER_EXPIRY_MINUTES` (default 120) and their reserved stock is released. Before this, abandoned `/buy` orders locked stock forever.
- Large deliveries are split into several DMs (Discord allows 2000 characters per message).
- `/embed` builder: editing a field now refreshes the same panel (it used to post a new panel after every edit), added the Author button, sessions expire after 30 minutes.
- Duplicate slash commands (each command shown twice)? Run `npm run register:clean`; it registers in your server and removes old global commands.
- Replies use Discord's current `flags` option instead of the deprecated `ephemeral`.

Tests: `npm test` runs 37 mocked tests (commands, order flow, reseller flow, embed builder, dashboard API and security). They use a temporary database and never touch your real data or `.env`.
