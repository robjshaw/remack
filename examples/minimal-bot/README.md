# Minimal boltkit bot

A ~90-line bot showing the core boltkit patterns: single-token bootstrap, one
handler module, plan-block progress UI on the home tab, and central error
handling.

## Setup

1. Create a Slack app (from scratch) at https://api.slack.com/apps with bot
   scopes `commands`, `chat:write`, and enable the **App Home** tab and the
   `app_home_opened` event.
2. Add slash commands `/ping` and `/boom` pointing at
   `https://<your-tunnel>/slack/events`, and set the same URL for
   Interactivity and Event Subscriptions.
3. `cp .env.example .env` and fill in `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET`.
4. From the repo root: `npm run example`, and tunnel with e.g.
   `ngrok http 3000`.

## Try it

- `/ping` — instant ack.
- `/boom` — throws; the central error handler acks, logs, fires an ops alert
  (if `SLACK_ALERTS_CHANNEL` is set), and shows the user a generic ephemeral
  message.
- `/boom user` — throws `SlackUserError`; the user sees the friendly message
  and no ops alert fires.
- Open the bot's Home tab — a plan block renders with a demo button.
- Click an unknown action or trigger an unhandled event — the finalize()
  catch-alls ack it and log it, no timeout spinner in Slack.
