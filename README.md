# ZAOscribe

Discord voice + Telegram upload meeting capture bot for The ZAO. Replaces Craig with auto-processing into the `/meeting` pipeline.

## What it does (v0.1 MVP)

- Joins a Discord voice channel on `/scribe start`.
- Records per-user audio streams as PCM stems, like Craig.
- On `/scribe stop`: converts stems to WAV, downmixes to a single 16kHz mono loudness-normalized `mix.wav`, and POSTs a JSON handoff to a configurable webhook (intended for the `/meeting` pipeline running on Zaal's mac).
- Per-session folder layout matches the `/meeting` skill so the existing whisper + diarize + extract + recap chain runs unchanged on the output.

Coming after MVP (v0.2+, see `src/discord/commands.ts` for the surfaces stub):
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
  { sessionId, folder, mixPath, stemWavs, participants, ... }
        |
        v
 /meeting pipeline (whisper, diarize, extract, recap, Bonfire, tracker)
```

## Run locally

```bash
# 1. Install deps (Node 20+, ffmpeg in PATH)
npm install

# 2. Configure
cp .env.example .env
# fill DISCORD_BOT_TOKEN, DISCORD_APP_ID, DISCORD_GUILD_ID
# (DISCORD_GUILD_ID = your test server; leave empty for global slash commands)

# 3. Register slash commands (one-time per guild / per global rollout)
npm run register-commands

# 4. Start
npm run dev   # tsx watch, logs pretty
# OR
npm start     # production
```

Invite the bot into your Discord server with these scopes: `bot`, `applications.commands`. Required permissions: `View Channels`, `Connect`, `Speak`, `Use Slash Commands`.

Then in any voice channel, run `/scribe start` to begin recording and `/scribe stop` to end + handoff.

## Deploy to the ZAO VPS

```bash
# On Iman's VPS (187.77.3.104):
cd /opt && git clone https://github.com/ZAODEVZ/ZAOsribeBOT.git zaoscribe
cd zaoscribe && npm install --omit=dev && cp .env.example .env
# fill .env
# Optionally drop the systemd unit from scripts/systemd/zaoscribe.service
sudo systemctl enable --now zaoscribe
```

## Privacy + secrets

- Recordings contain PII (voice). The `recordings/` folder is gitignored and must stay off-repo (`.claude/rules/pii-hygiene.md`).
- `.env` is gitignored. `.env.example` is the only template that ships.
- Discord token + Telegram token never appear in any committed file. Stub keys in dev `.env`, real keys only on the VPS.
- Webhook handoff includes a Bearer secret (`TRANSCRIBE_WEBHOOK_SECRET`). Set it; rotate it if it leaks.

## Layout

```
src/
  config.ts                  # env loading + validation
  logger.ts                  # pino logger
  session.ts                 # per-recording session model + meta.json
  recorder.ts                # @discordjs/voice receiver + per-user PCM streams
  postprocess.ts             # ffmpeg pcm->wav, mix, webhook handoff
  index.ts                   # entrypoint
  discord/
    client.ts                # discord.js client + login
    commands.ts              # /scribe start | stop | status handlers
  scripts/
    register-commands.ts     # one-shot CLI to register slash commands
```

## License

MIT - see [LICENSE](./LICENSE).

## Owners

- Iman (`imanafrikah`) - org owner, VPS host
- Zaal (`bettercallzaal`) - collaborator, /meeting pipeline integration

Created 2026-05-28 to replace Craig as the ZAO meeting-capture surface.
