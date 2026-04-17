# OpenClaw Wake Companion

A local companion for waking the OpenClaw browser tab without the desktop app.

## Current shape
- `src/wakeListener.ts` reads lines and opens the browser on wake words
- `src/voiceWakeServer.ts` exposes a local `/wake` endpoint
- `src/openclawBridge.ts` opens the OpenClaw URL in a browser

## Intended next layer
- hotword detection
- local speech-to-text
- text injection into OpenClaw
- optional spoken response

## Good implementation path
1. keep listener local-only
2. use a browser tab bridge first
3. add STT afterward
4. wire wake word detection last

## Default environment
- `OPENCLAW_URL=http://localhost:3000`
- `OPENCLAW_WAKE_WORDS=jarvis,openclaw,hey jarvis`
- `OPENCLAW_BROWSER_APP=Google Chrome`
