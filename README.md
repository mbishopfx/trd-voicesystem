# Outbound Voice Bot (Vapi + Twilio-Aware Dialer)

...existing content preserved above...

## Local wake-listener companion

This repo now includes a lightweight local companion for waking OpenClaw from the Mac without the desktop app.

### What it does
- listens for a wake phrase on stdin
- opens the OpenClaw web tab in your browser
- leaves room for a later STT + hotword pipeline

### Run

```bash
npm run wake-listener
```

### Optional env

- `OPENCLAW_URL` (default: `http://localhost:3000`)
- `OPENCLAW_WAKE_WORDS` (comma-separated, default: `jarvis,openclaw,hey jarvis`)
- `OPENCLAW_BROWSER_APP` (default: `Google Chrome`)
- `OPENCLAW_VOICE_MODE` (`browser` or `text`, default `browser`)
- `OPENCLAW_WAKE_PORT` (for the HTTP wake bridge)

### Notes
- This is the bridge layer, not the full wake-word engine.
- Next step is to plug in real speech recognition or keyword spotting.
- If you want, I can add the STT daemon next, so spoken phrases trigger `/wake` automatically.
