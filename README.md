# Parley

A live conversation coach for Even Realities G2 glasses. You practise a
language (French by default) and, when you stall or slip into your stronger
language (English by default), the glasses show one short continuation in the
language you are practising. The HUD also shows a live transcript of what you
said, including the words you slipped into.

## How it works

- The glasses microphone streams 16 kHz audio to the phone app, where this
  page runs in the Even app's WebView.
- A pause detector on the raw audio notices when you stop speaking for about
  900 ms. A temple tap asks for help at any time.
- Soniox real-time speech-to-text produces the transcript, with French and
  English language hints.
- On a pause or a tap, the server asks Claude for one short continuation in
  the practised language, or an explicit abstain. It never invents names,
  times or reasons you did not say.
- Speaking again clears the suggestion. A late answer never replaces newer
  speech.
- A projector page (`/companion.html`) mirrors the app state for an audience,
  with the app-side time from the start of your pause to the HUD update being
  sent.

## Run it

Requirements: Node 23, pnpm, a Soniox API key and an Anthropic API key.

```bash
cd app
pnpm install --frozen-lockfile
cp .env.example .env.local   # then fill in SONIOX_API_KEY and ANTHROPIC_API_KEY
npm test                     # unit tests (node:test)
npm run dev                  # Vite dev server on port 5173, reachable on the LAN
```

Load it on the glasses: the phone must reach the laptop, on the same Wi-Fi or
through a tunnel.

```bash
ipconfig getifaddr en0                       # the laptop's LAN address
npx evenhub qr --url http://<lan-ip>:5173    # scan in the Even app's Apps tab
```

Open `http://localhost:5173/companion.html` on the projector.

Rehearse without glasses in the Even Hub simulator, which runs its own copy of
the app:

```bash
npm run simulate
```

## Controls

| Gesture | Action |
|---|---|
| Pause about 1 s | Suggest a continuation |
| Tap or long press | Suggest now |
| Speak again | Clear the suggestion |
| Double tap | Exit (with confirmation) |
| Reset on the projector page | Clear transcript and suggestion |

## Configuration

`.env.local` (never committed): `SONIOX_API_KEY`, `ANTHROPIC_API_KEY`,
`COACH_MODEL` (default `claude-haiku-4-5`), `PRACTICE_LANGUAGE` (default `fr`),
`FALLBACK_LANGUAGE` (default `en`).

## License

MIT
