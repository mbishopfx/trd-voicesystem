# Wake Manager

## Mode
- default: capture mode, short audio windows + Whisper
- alternate: text mode for stdin testing

## Run
```bash
npm run wake-manager
```

## Defaults
- wake phrase: `hey jarvis`
- browser: `Google Chrome`
- OpenClaw URL: `http://localhost:3000`

## Env
- `OPENCLAW_WAKE_MODE=capture|text`
- `OPENCLAW_WAKE_WORDS=hey jarvis`
- `OPENCLAW_CAPTURE_SECONDS=6`
- `OPENCLAW_WAKE_PAUSE_SECONDS=2`
- `OPENCLAW_WHISPER_MODEL=base`
- `OPENCLAW_MIC_INPUT=:0`
- `OPENCLAW_URL=http://localhost:3000`
- `OPENCLAW_BROWSER_APP=Google Chrome`
