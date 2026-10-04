# Parley

A live conversation coach for Even Realities G2 glasses. You practise a
language (French by default) and, when you stall or slip into your stronger
language (English by default), the glasses show one short continuation in the
language you are practising. The HUD also shows a transcript of what you said,
including the words you slipped into, updated after each utterance.

## How it works

- The glasses microphone streams 16 kHz audio to the phone app, where this
  page runs in the Even app's WebView.
- A pause detector on the raw audio notices when you stop speaking for about
  900 ms. A temple tap asks for help at any time.
- Speech-to-text: by default each utterance goes as one audio clip to
  OpenRouter's transcription endpoint when you pause, so the transcript
  updates per utterance, not word by word. With a Soniox key the app streams
  to Soniox instead for a word-by-word transcript.
- On a pause or a tap, the server asks a model through OpenRouter (Claude
  Haiku 4.5 by default) for one short continuation in
  the practised language, or an explicit abstain. The prompt instructs the
  model not to invent names, times or reasons you did not say; this is a
  design rule, checked in rehearsal rather than guaranteed.
- Speaking again clears the suggestion. A late answer never replaces newer
  speech.
- A projector page (`/companion.html`) mirrors the app state for an audience,
  with the app-side time from the start of your pause to the HUD update being
  sent. In clip mode that time includes transcribing the utterance.

## Run it

Requirements: Node 23, pnpm and an OpenRouter API key. A Soniox API key is
optional, for word-by-word transcripts.

```bash
cd app
pnpm install --frozen-lockfile
cp .env.example .env.local   # then fill in OPENROUTER_API_KEY (SONIOX_API_KEY optional)
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

`.env.local` (never committed): `SONIOX_API_KEY`, `OPENROUTER_API_KEY`,
`COACH_MODEL` (an OpenRouter model id, default `anthropic/claude-haiku-4.5`),
`PRACTICE_LANGUAGE` (default `fr`), `FALLBACK_LANGUAGE` (default `en`).
Suggestions go through OpenRouter's chat-completions API with plain `fetch`.

## License

MIT
