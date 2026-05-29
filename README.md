# ZAOscribe

Discord voice + meeting capture bot for The ZAO. Replaces Craig with auto-processing into the `/meeting` research-doc pipeline.

**Repo:** `github.com/ZAODEVZ/ZAOsribeBOT`
**Status:** v0.1.3 - audit-cleared, ready to deploy + test
**Mac-side receiver:** lives at `~/Documents/ZAODEVZ/zaoscribe-receiver/` on Zaal's mac (not pushed; private)

## What it does

- Joins a Discord voice channel on `/scribe start`.
- Posts a public "Recording active" consent banner to the text channel + sets bot presence to `Watching #channel-name`.
- Records per-user audio streams as PCM stems, Craig-style.
- On `/scribe stop`: converts stems to WAV, downmixes to a single 16 kHz mono loudness-normalized `mix.wav`, POSTs an HMAC-SHA256 signed JSON handoff to the configured webhook.
- Per-session folder layout matches the `/meeting` skill so the existing whisper + diarize + extract + recap chain runs unchanged on the output.
- `/vps` slash commands (status / logs / restart) for ops shortcuts against the host the bot runs on.
- Disk-quota cap (default 20 GiB) on the recordings dir.
- Graceful shutdown finalizes active recordings before systemd SIGKILL.

**Fail-closed authorization.** `DISCORD_ADMIN_USER_IDS` must be explicitly set; an empty list means **nobody** can start a recording. This is intentional - an unconfigured bot must never record voice.

## Why it exists

- Craig is great but manual - you download the recording, drop it into `/meeting`, watch whisper run, then hand-process.
- For ZAO Devz cowork sessions and intro calls (4-7 calls/week), Craig + manual capture has been our bottleneck.
- ZAOscribe collapses the loop: end the call, the receiver scoops the audio, `/meeting` produces the recap.

## Architecture

```
Discord voice channel (VPS-hosted bot)
        |
        v
 @discordjs/voice receiver
   per-user opus streams
        |
        v
  prism-media opus decoder  -->  PCM s16le 48kHz stereo  -->  per-user .pcm files
        |
        v  (on /scribe stop)
  ffmpeg pcm -> wav per stem
  ffmpeg amix + loudnorm -> mix.wav (16kHz mono)
        |
        v
  POST <TRANSCRIBE_WEBHOOK_URL>  (HMAC-SHA256 signed)
    headers:
      x-zaoscribe-timestamp: <epoch ms>
      x-zaoscribe-signature: sha256=<hmac-sha256(secret, `${ts}.${body}`)>
    body: { sessionId, folder, mixPath, stemWavs, participants[userId,usernameHash], ... }
        |
        v
 zaoscribe-receiver (Zaal's mac, behind cloudflared/tailscale tunnel)
   - verify timestamp +/- 5 min skew
   - constant-time HMAC compare
   - SCP mix.wav + stems from VPS into ~/.zao/zaoscribe-queue/<sessionId>/
   - drop ready.txt sentinel
   - (optional) Telegram ping
        |
        v
 /meeting skill picks up the queue folder
 (whisper, diarize, extract, recap, Bonfire, tracker)
```

## v0.1.3 surfaces

### `/scribe`

| Subcommand | Who | What |
|---|---|---|
| `/scribe start` | DISCORD_ADMIN_USER_IDS | Joins the caller's voice channel, posts consent banner, sets presence, starts per-user PCM capture. Refuses if cooldown active (5s after last stop) or recordings dir is over MAX_RECORDINGS_BYTES. |
| `/scribe stop notes:<optional>` | DISCORD_ADMIN_USER_IDS | Drains pipelines, ffmpeg pcm->wav per stem + amix mix.wav, POSTs HMAC-signed handoff, clears presence, public summary with stems + bytes + duration + handoff status. |
| `/scribe status` | DISCORD_ADMIN_USER_IDS | Ephemeral: current session id + elapsed seconds + speaker count, or "no active session". |

### `/vps`

| Subcommand | Who | What |
|---|---|---|
| `/vps status service:<name>` | DISCORD_ADMIN_USER_IDS | systemctl is-active + status -n 5 for an allow-listed unit. Ephemeral. |
| `/vps logs service:<name> lines:<1-50>` | DISCORD_ADMIN_USER_IDS | journalctl -n N for an allow-listed unit, capped 16 KB. Ephemeral. |
| `/vps restart service:<name> reason:<text>` | VPS_RESTART_USER_IDS (separate allowlist) | systemctl restart + audit-logged with user + reason. Public reply for accountability. |

Service names must be in `VPS_ALLOWED_SERVICES` env (empty = command disabled).

## Webhook receiver contract

The downstream `/meeting` pipeline endpoint MUST:

1. Read the raw request body before parsing JSON (so the signature is verified against the exact bytes sent).
2. Read `x-zaoscribe-timestamp` and reject if more than 5 minutes from server clock (replay protection).
3. Compute `hmac-sha256(SECRET, \`${timestamp}.${rawBody}\`)` and constant-time-compare against the hex part of `x-zaoscribe-signature` (strip the `sha256=` prefix).
4. Only then parse and process the payload.

Node receiver snippet:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(req: Request, secret: string, rawBody: string): boolean {
  const ts = req.headers.get('x-zaoscribe-timestamp');
  const sig = req.headers.get('x-zaoscribe-signature')?.replace(/^sha256=/, '');
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60_000) return false;
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  if (expected.length !== sig.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}
```

A full reference implementation lives in `~/Documents/ZAODEVZ/zaoscribe-receiver/src/verify.ts` (local, not committed publicly).

## Discord Developer Portal setup

Walked end-to-end in `~/.zao/clipboard/clip-20260528-...-zaoscribe-discord-setup.html` (per-block Copy buttons for every field). Summary:

1. New Application -> name **ZAOscribe**
2. General Information -> Description + Tags (Utility, Productivity, Voice)
3. Bot tab:
   - Public Bot: OFF
   - Privileged Gateway Intents: enable **Server Members Intent** only
   - Reset Token -> copy into `DISCORD_BOT_TOKEN`
4. Installation / OAuth2 URL Generator:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: View Channels, Send Messages, Connect, Speak (bitmask `3148800`)
5. Capture: App ID, Bot Token, Guild ID, your User ID + Iman's User ID

## Run locally (dev)

```bash
# Node 20+, ffmpeg in PATH
npm install
cp .env.example .env
chmod 600 .env
# fill DISCORD_BOT_TOKEN, DISCORD_APP_ID, DISCORD_GUILD_ID, DISCORD_ADMIN_USER_IDS
# generate webhook secret:  openssl rand -hex 32

npm run register-commands    # one-time per guild
npm run dev                  # tsx watch, pino-pretty logs
```

## Deploy to the ZAO VPS

```bash
# On Iman's VPS (187.77.3.104):
sudo useradd -r -s /usr/sbin/nologin zaoscribe
sudo mkdir -p /opt/zaoscribe /var/lib/zaoscribe
sudo chown -R zaoscribe:zaoscribe /opt/zaoscribe /var/lib/zaoscribe

# Pull + install
sudo -u zaoscribe bash -c '
  cd /opt/zaoscribe
  git clone https://github.com/ZAODEVZ/ZAOsribeBOT.git .
  npm ci --omit=dev
  cp .env.example .env
  chmod 600 .env
'

# Edit .env with prod secrets (root, then chown back)
sudo vim /opt/zaoscribe/.env
sudo chown zaoscribe:zaoscribe /opt/zaoscribe/.env
sudo chmod 600 /opt/zaoscribe/.env

# Register slash commands (guild-scoped, instant)
sudo -u zaoscribe bash -c 'cd /opt/zaoscribe && npm run register-commands'

# Install + start systemd unit
sudo cp /opt/zaoscribe/scripts/systemd/zaoscribe.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zaoscribe
sudo journalctl -u zaoscribe -f
```

Healthy boot log lines:

```
boot:storage-ready
boot:queue-ready (receiver only)
boot:discord-up
discord:ready
```

## Mac-side receiver

Lives at `~/Documents/ZAODEVZ/zaoscribe-receiver/` (local, MIT, not in the public org).

```bash
cd ~/Documents/ZAODEVZ/zaoscribe-receiver
cp .env.example .env
# TRANSCRIBE_WEBHOOK_SECRET must MATCH the bot's value
npm install
npm run dev
```

Expose to the VPS-side bot via cloudflared:

```bash
cloudflared tunnel --url http://127.0.0.1:8731
# copy the trycloudflare.com URL into the bot's TRANSCRIBE_WEBHOOK_URL as
#   https://<tunnel>.trycloudflare.com/webhook
```

Receiver behavior:
- `GET /health` -> 200
- `POST /webhook` -> 401 on missing/bad/stale signature, 400 on malformed JSON, 202 + sessionId on accept
- Background: SCP `mix.wav` + per-user `.wav` stems from VPS into `~/.zao/zaoscribe-queue/<sessionId>/`
- Writes `payload.json` + `ready.txt` sentinel
- Optional Telegram ping if `TELEGRAM_NOTIFY_BOT_TOKEN` + `TELEGRAM_NOTIFY_CHAT_ID` set

Once a session lands in the queue, run `/meeting` against the queue folder's `mix.wav`.

## First-call test sequence

In a test voice channel with two participants:

```
/scribe start
# expect: consent banner in text channel, presence flips to Watching, ephemeral session id
```

Speak for ~30 seconds, then:

```
/scribe stop notes:test-call-1
# expect: public summary - stems captured, mix.wav path, duration, handoff OK
# receiver logs: webhook:accepted, webhook:queued
# ~/.zao/zaoscribe-queue/<sessionId>/ has mix.wav + payload.json + ready.txt
```

```
/scribe status
# expect: "No active session"
```

```
/vps status service:zaocoworking-bot.service
# expect: is-active + last 5 journal entries
```

## Privacy + secrets

- Recordings contain PII (voice). The `recordings/` folder is gitignored and lives at `/var/lib/zaoscribe/recordings` on the VPS - outside the app dir, easier to monitor / back up / wipe.
- `.env` is gitignored everywhere. `.env.example` is the only template that ships. `chmod 600 .env` on every host.
- Discord token + Telegram token never appear in any committed file. Stub keys in dev `.env`, real keys only on the VPS.
- Webhook handoff is HMAC-SHA256 signed with a 5-minute replay window. Rotate the secret if it leaks.
- Per-recording **consent banner** is posted to the text channel where `/scribe start` ran, and the bot's presence is set to `Watching #channel-name`. Participants who do not consent should leave the voice channel.
- Logs do NOT include usernames or display names - only short hashes of user IDs + session IDs for correlation. The journal on the VPS is safe to inspect without leaking attendee names.
- Webhook payload includes `userId` (Discord snowflake) and `usernameHash` (sha256 truncated), no plaintext usernames or display names.

## Audit history

Three audit rounds against this codebase across v0.1, v0.1.1, v0.1.2, v0.1.3. Final status:

| Finding | Status |
|---|---|
| Auth fail-open when allowlist empty | RESOLVED v0.1.1 |
| No consent banner / no bot presence | RESOLVED v0.1.1 |
| Pipeline race truncating stems | RESOLVED v0.1.1 |
| Path string interpolation | RESOLVED v0.1.1 (path.join everywhere) |
| Silent empty-catch on missing PCM | RESOLVED v0.1.1 (logged + failedStems counter) |
| PII (username/displayName) in logs | RESOLVED v0.1.1 (shortHash of userId only) |
| PII in webhook payload | RESOLVED v0.1.1 (usernameHash, no display name) |
| Bearer auth -> HMAC-SHA256 | RESOLVED v0.1.1 |
| Webhook HTTPS not enforced | RESOLVED v0.1.1 + v0.1.2 (BootError pattern) |
| meta.json not re-persisted after rename | RESOLVED v0.1.1 |
| Recordings dir relocation to /var/lib | RESOLVED v0.1.1 |
| .env chmod 600 documented | RESOLVED v0.1.1 |
| Partial-session cleanup on ffmpeg failure | RESOLVED v0.1.1 |
| Graceful shutdown of active recordings | RESOLVED v0.1.2 (30s deadline, systemd TimeoutStopSec=35s) |
| `recentStops` map unbounded | RESOLVED v0.1.2 (TTL prune) |
| Process.exit during async logger | RESOLVED v0.1.2 (BootError thrown to main.catch) |
| Regex "blocker" (audit false positive) | RESOLVED v0.1.2 (rewrote with `\uXXXX` escapes + doc comment so no one re-misreads) |
| Disk quota cap | RESOLVED v0.1.3 (MAX_RECORDINGS_BYTES, default 20 GiB) |
| `members.fetch` timeout | RESOLVED v0.1.3 (5s race) |
| Per-session size logging | RESOLVED v0.1.3 (humanBytes in stop summary + structured log) |
| `tar` CVE chain via @discordjs/opus | UPSTREAM - tracked; mitigation via npm ci on clean env |
| Telegram bot surface | DEFERRED to v0.2 |
| Web upload surface | DEFERRED to v0.2 |
| OpenAI Whisper API fallback (when mac offline) | DEFERRED to v0.2 |
| Receiver-side HMAC enforcement | OUT OF SCOPE - documented contract; implemented in zaoscribe-receiver |

## Layout

```
src/
  config.ts                  # env loading + validation
  logger.ts                  # pino logger (PII-free)
  session.ts                 # per-recording session model + meta.json + sanitizeUsername
  recorder.ts                # @discordjs/voice receiver + per-user PCM streams + pipeline drain
  postprocess.ts             # ffmpeg pcm->wav, amix, HMAC webhook handoff, cleanup
  util/
    hash.ts                  # shortHash for log correlation + hmacSign for webhook
    exec.ts                  # spawn-with-cap wrapper for /vps shell-outs
    diskQuota.ts             # recordings dir size walker + humanBytes
  index.ts                   # entrypoint - write-probe, HTTPS check, admin-list check, graceful shutdown
  discord/
    client.ts                # discord.js client + login
    commands.ts              # /scribe start | stop | status + consent banner + presence + finalizeAllActiveSessions
    vps.ts                   # /vps status | logs | restart (allowlisted)
  scripts/
    register-commands.ts     # one-shot CLI to register slash commands
scripts/
  systemd/zaoscribe.service  # hardened unit; recordings live in /var/lib/zaoscribe
```

## Roadmap

**v0.2 - new surfaces:**

- Telegram bot: forward an audio/video file to the bot, get the recap posted back. `telegraf` already a dep, handler stub goes in `src/telegram/`.
- Web upload at `POST /upload` for any browser. Same handoff shape.
- OpenAI Whisper API fallback when the mac receiver isn't reachable. `MAX_MONTHLY_TRANSCRIBE_USD` env already wired.

**v0.3 - inline action extraction:**

- Bot calls Claude/Sonnet directly post-transcribe to extract decisions + actions, writes them into the unified Supabase tasks table (`etwvzrmlxeobinrlytza`), and posts a Telegram summary - the full "meeting -> tasks in cowork tracker" loop without a human in the middle.

**v0.4 - dropdown:**

- `/scribe replay` to re-trigger handoff for a past session (when mac was offline).
- Per-channel auto-record on a schedule (cron-style for recurring standups).

## License

MIT - see [LICENSE](./LICENSE).

## Owners

- Iman (`imanafrikah`) - org owner, VPS host
- Zaal (`bettercallzaal`) - collaborator, `/meeting` pipeline integration, mac-side receiver

Created 2026-05-28 to replace Craig as the ZAO meeting-capture surface.
