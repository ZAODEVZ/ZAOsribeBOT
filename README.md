# ZAOscribe

Discord voice + Telegram upload meeting capture bot for The ZAO. Replaces Craig with auto-processing into the `/meeting` pipeline.

## What it does (v0.1 MVP)

- Joins a Discord voice channel on `/scribe start`.
- Posts a public "Recording active" consent banner to the text channel + sets bot presence to `Watching #channel-name` so every participant can see + scroll back.
- Records per-user audio streams as PCM stems, Craig-style.
- On `/scribe stop`: converts stems to WAV, downmixes to a single 16 kHz mono loudness-normalized `mix.wav`, and POSTs a JSON handoff to a configurable webhook (intended for the `/meeting` pipeline running on Zaal's mac). Payload is HMAC-SHA256 signed.
- Per-session folder layout matches the `/meeting` skill so the existing whisper + diarize + extract + recap chain runs unchanged on the output.

**Fail-closed authorization.** `DISCORD_ADMIN_USER_IDS` must be explicitly set; an empty list means **nobody** can start a recording. This is intentional - an unconfigured bot must never record voice.

Coming after MVP (v0.2+):
- Telegram bot: forward an audio/video file, get the recap posted back.
- Web upload page on the VPS (`POST /upload`).
- Auto-transcription path that calls OpenAI Whisper as a mac-offline fallback, with `MAX_MONTHLY_TRANSCRIBE_USD` cap.
- Tracker write + Bonfire episode push baked into the bot itself.

## Why it exists

- Craig is great but manual - you download the recording, drop it into `/meeting`, watch whisper run, then hand-process.
- For ZAO Devz cowork sessions and intro calls (4-7 calls/week), Craig + manual capture has been our bottleneck.
- ZAOscribe collapses the loop: end the call, get the recap back. Same `research/events/NNN-<slug>/` output, same Bonfire episodes, same Supabase tracker rows.

## Architecture

```
Discord voice channel
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
  POST <TRANSCRIBE_WEBHOOK_URL>
    headers:
      x-zaoscribe-timestamp: <epoch ms>
      x-zaoscribe-signature: sha256=<hmac-sha256(secret, `${ts}.${body}`)>
    body: { sessionId, folder, mixPath, stemWavs, participants[userId,usernameHash], ... }
        |
        v
 /meeting pipeline (whisper, diarize, extract, recap, Bonfire, tracker)
```

## Webhook receiver contract

The downstream `/meeting` pipeline endpoint MUST:

1. Read the raw request body before parsing JSON (so the signature is verified against the exact bytes sent).
2. Read `x-zaoscribe-timestamp` and reject if more than 5 minutes from server clock (replay protection).
3. Compute `hmac-sha256(SECRET, `${timestamp}.${rawBody}`)` and constant-time-compare against the hex part of `x-zaoscribe-signature` (strip the `sha256=` prefix).
4. Only then parse and process the payload.

A Node receiver looks like:

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

## Run locally

```bash
# 1. Install deps (Node 20+, ffmpeg in PATH)
npm install

# 2. Configure
cp .env.example .env
chmod 600 .env
# fill DISCORD_BOT_TOKEN, DISCORD_APP_ID, DISCORD_GUILD_ID
# fill DISCORD_ADMIN_USER_IDS with your Discord user ID (right-click your name in Discord with developer mode on)
# generate TRANSCRIBE_WEBHOOK_SECRET:  openssl rand -hex 32

# 3. Register slash commands (one-time per guild / per global rollout)
npm run register-commands

# 4. Start
npm run dev   # tsx watch, logs pretty
# OR
npm start     # production
```

Invite the bot with these scopes: `bot`, `applications.commands`. Required permissions: `View Channels`, `Connect`, `Speak`, `Use Slash Commands`, `Send Messages` (for the consent banner). Enable the `Server Members Intent` in the Discord Developer Portal (used by `guild.members.fetch` to resolve display names).

Then in any voice channel, run `/scribe start` to begin recording and `/scribe stop` to end + handoff.

## Deploy to the ZAO VPS

```bash
# On the VPS (Iman's 187.77.3.104):
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
# Edit .env with prod secrets (the deployer, not zaoscribe user, opens .env)
sudo vim /opt/zaoscribe/.env
sudo chown zaoscribe:zaoscribe /opt/zaoscribe/.env
sudo chmod 600 /opt/zaoscribe/.env

# Register slash commands
sudo -u zaoscribe bash -c 'cd /opt/zaoscribe && npm run register-commands'

# Install + start systemd unit
sudo cp /opt/zaoscribe/scripts/systemd/zaoscribe.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zaoscribe
sudo journalctl -u zaoscribe -f
```

## Privacy + secrets

- Recordings contain PII (voice). The `recordings/` folder is gitignored and must stay off-repo (`.claude/rules/pii-hygiene.md`).
- `.env` is gitignored. `.env.example` is the only template that ships. `chmod 600 .env` on every host.
- Discord token + Telegram token never appear in any committed file. Stub keys in dev `.env`, real keys only on the VPS.
- Webhook handoff carries an HMAC-SHA256 signature with a 5-minute replay window. Rotate the secret if it leaks.
- Per-recording **consent banner** is posted to the text channel where `/scribe start` ran, and the bot's presence is set to `Watching #channel-name`. Participants who do not consent should leave the voice channel.
- Logs do NOT include usernames or display names - only short hashes of user IDs + session IDs for correlation. The journal on the VPS is safe to inspect without leaking attendee names.
- Webhook payload includes `userId` (Discord snowflake) and `usernameHash` (sha256 truncated), no plaintext usernames.

## Layout

```
src/
  config.ts                  # env loading + validation
  logger.ts                  # pino logger (PII-free)
  session.ts                 # per-recording session model + meta.json
  recorder.ts                # @discordjs/voice receiver + per-user PCM streams + pipeline drain
  postprocess.ts             # ffmpeg pcm->wav, amix, HMAC webhook handoff, cleanup
  util/hash.ts               # shortHash for log correlation + HMAC sign
  index.ts                   # entrypoint - write-probe, HTTPS check, admin-list check
  discord/
    client.ts                # discord.js client + login
    commands.ts              # /scribe start | stop | status + consent banner + presence
  scripts/
    register-commands.ts     # one-shot CLI to register slash commands
scripts/
  systemd/zaoscribe.service  # hardened unit; recordings live in /var/lib/zaoscribe
```

## License

MIT - see [LICENSE](./LICENSE).

## Owners

- Iman (`imanafrikah`) - org owner, VPS host
- Zaal (`bettercallzaal`) - collaborator, /meeting pipeline integration

Created 2026-05-28 to replace Craig as the ZAO meeting-capture surface.
