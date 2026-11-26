# DARKEN

WhatsApp bot. It connects with the session stored in MongoDB and runs every command from the **DELOOP** repo.

```
DELOOP (private repo)  commands + scanner      ->  you run the scanner once, on your computer
DARKEN (private repo)  this bot                ->  deployed on Render, loads DELOOP's commands at startup
MongoDB Atlas          session + bot data      ->  survives Render restarts
```

Use a **spare SIM**. Unofficial libraries are against WhatsApp's terms and the number can be banned.

## 1. MongoDB Atlas (free M0)
1. Create a cluster, a database user (strong password), and under *Network Access* allow `0.0.0.0/0` (Render's free tier has no fixed IP).
2. Copy the connection string. That is `MONGO_URI`.

## 2. GitHub
1. Make **DELOOP** and **DARKEN** private repos and push each folder. `.env`, `deloop/` and `node_modules/` are already in `.gitignore`.
2. For DARKEN to read DELOOP: GitHub > Settings > Developer settings > *Fine-grained tokens*. Resource: only the DELOOP repo. Permission: *Contents: Read-only*. That is `DELOOP_TOKEN`.

## 3. Create the session (on your computer, once)
```bash
cd DELOOP
npm install
cp scanner/.env.example .env      # fill MONGO_URI and SESSION_ID
npm run scan                      # scan the QR: WhatsApp > Linked devices
# or: npm run scan -- --pair 2557XXXXXXXX     (pairing code instead of QR)
```
The scanner closes itself after pairing. **Never run it while the bot is running** (WhatsApp would kick one of them off).
`--force` replaces an existing session with the same `SESSION_ID`.

## 4. Test locally first (recommended)
```bash
cd DARKEN
npm install
cp .env.example .env     # set MONGO_URI, OWNER_NUMBER, SESSION_ID and DELOOP_PATH=../DELOOP
npm start
```
You should see `[db] connected`, `[deloop] loaded 140 commands`, `[bot] connected as ...`, and the bot messages your owner number "✅ DARKEN is online". Then try, from your phone:

`!ping` `!menu` `!help ping` `!sticker` (reply to an image) `!botstatus`

Commands you type on the bot's own phone count as coming from the owner.

## 5. Deploy on Render
1. New > Web Service > connect GitHub (install the Render GitHub app for the **DARKEN** repo only).
2. Build `npm install`, start `node index.js` (or use `render.yaml`).
3. Environment variables: `MONGO_URI`, `OWNER_NUMBER`, `SESSION_ID`, `DELOOP_REPO` (`you/DELOOP`), `DELOOP_TOKEN`, `DELOOP_BRANCH` (`main`), `NODE_VERSION=22`. Optional: `BOT_NAME`, `OWNER_NAME`, `PREFIX`, `TIMEZONE`, `PACK_NAME`, `AUTHOR`, `TELEGRAM_BOT_TOKEN`, `PAIR_URL`.
4. Deploy. Updating commands later: push to DELOOP, then send `!update` in WhatsApp. No redeploy needed.

Free tier: the service sleeps after ~15 minutes without web traffic. DARKEN pings its own URL every 10 minutes (Render provides `RENDER_EXTERNAL_URL`), which usually keeps it awake, but it is not guaranteed. A paid instance is the reliable fix.

## Reading the logs
| Log line | Meaning |
|---|---|
| `No WhatsApp session named "..."` | Run the scanner with the same `SESSION_ID`, then restart. |
| `This session was opened somewhere else` | The scanner or a second copy of the bot is running. Stop it, restart DARKEN. |
| `Logged out from WhatsApp` | Unlinked from the phone, or the number was banned. Re-run the scanner with `--force`. |
| `[deloop] could not load ...` | A command file has an error; the rest still work. |
| `git clone failed` | Wrong `DELOOP_REPO`, or the token cannot read that repo. |

`GET /` returns `{ status: "connected" | "reconnecting" | "no-session" | "logged-out" | "replaced" }`.

## What I could not test
The code was tested with a fake WhatsApp and a fake database (`npm test`), not on a real connection. On the first real run, check these:
1. Everything in a **group** (admin checks, `!tagall`, `!kick`). WhatsApp now hides numbers behind `@lid` IDs, and DARKEN converts them back to phone numbers; if a group command misbehaves, send me the log line.
2. `!sticker` and `!attp` (need `sharp`, `wa-sticker-formatter` and ffmpeg; `ffmpeg-static` is included).
3. The web-API commands (`!apk`, `!google`, `!img`, `!tts`, `!ssweb`...). A dead API is a one-line fix in `DELOOP/lib/apis.js`.
4. Baileys is pinned to `baileys@7.0.0-rc10`. Run `npm view baileys dist-tags` to see whether a newer release exists.
