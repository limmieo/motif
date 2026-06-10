# Wario Synth — Turn Any Audio Into Game Boy Music

![Wario Synth Logo](public/wariosynthlogo.png)

Drop in a song — an audio file or a YouTube link — and hear it rewritten for
Game Boy hardware. **WAH!** 🎮

No MIDI file required. A local AI pipeline transcribes the audio, cleans it
up with music theory, rearranges it the way a real chiptune composer would,
and plays it through a homebrew Game Boy sound chip running in your browser.

> This is a fork of [b1rdmania/motif](https://github.com/b1rdmania/motif),
> which plays MIDI files found online through a Game Boy-style synth. This
> fork solves the *input* problem: you bring audio, not MIDI.

## What This Fork Adds

- **Audio-to-MIDI transcription** — upload an audio file or paste a YouTube
  link. Two neural models to choose from: a dedicated piano model with note
  offset, velocity, and sustain-pedal detection, or Basic Pitch for
  everything else.
- **MIDI cleanup intelligence** — key inference, correction of likely
  transcription errors, tempo estimation, and gentle quantization, so the
  synth gets music instead of noise.
- **Composer Mode** — dense transcriptions are rewritten for Game Boy
  hardware instead of converted note-for-note (see below).
- **One-click Windows launcher** — `Start Wario Synth.bat` installs
  everything (Node deps, Python venv, the transcription models) and opens
  the app.

## Composer Mode

A piano cover can land ten simultaneous notes. The Game Boy has three
pitched channels. Converting every note literally means dropping most of
them at random — so instead, the pipeline rewrites dense passages the way a
chiptune composer would have:

- the **skyline** (top voice) becomes the melody on pulse 1
- the **floor** (lowest voice) becomes the bass on the wave channel
- the **inner chord tones** collapse into a fast sixteenth-note arpeggio on
  pulse 2

Sustained melody notes keep the skyline (chord stabs underneath don't steal
the lead), monophonic material passes through untouched, and the UI tells
you when an arrangement was applied. Run the transcriber with
`--arrange off` if you want the literal transcription instead.

## How It Works

1. You drop in an audio file or YouTube link
2. yt-dlp + FFmpeg fetch and normalize the audio
3. A neural model (the piano model or Basic Pitch) transcribes it to notes
4. Cleanup pass: key inference, pitch-error correction, tempo estimation,
   quantization
5. Composer Mode separates the voices: melody / bass / arpeggio
6. The synthesis engine maps the voices to four Game Boy channels:
   - 🟨 **Pulse 1** — lead melody
   - 🟨 **Pulse 2** — arpeggio / harmony
   - 🟩 **Wave** — bass
   - ⬜ **Noise** — percussion
7. Web Audio oscillators generate the sound — zero samples, zero server
   audio

The original MIDI-search path still works too: search a song name, pick a
MIDI result, and play it through the same synth.

## Quick Start (Windows)

Double-click **`Start Wario Synth.bat`**. It installs the frontend and
backend dependencies, sets up the Python transcription environment,
downloads the piano model (one-time 165 MB), starts both servers, and opens
the app.

## Quick Start (Manual)

```bash
# Install frontend deps
npm install

# Install backend deps
cd server && npm install && cd ..

# Run backend (http://localhost:3001)
npm run dev:backend

# Run frontend (Vite prints the URL, typically http://localhost:5173)
npm run dev
```

### Audio transcription setup

The audio pipeline requires Python 3.11 or earlier, FFmpeg, and the Python
dependencies:

```bash
python -m venv server/.venv
server/.venv/Scripts/python -m pip install -r server/requirements-audio.txt
```

Set `FFMPEG_PATH` if `ffmpeg` is not on your `PATH`. YouTube downloading is
intended only for media you own or have permission to download.

## Tech Stack

- **Audio pipeline**: Python, yt-dlp, FFmpeg, Basic Pitch,
  piano-transcription-inference, pretty_midi
- **Frontend**: TypeScript, Vite, Web Audio API
- **Backend**: Express, Node.js
- **Built with**: Claude Code

## Credits

Forked from [motif](https://github.com/b1rdmania/motif) by
[@b1rdmania](https://x.com/b1rdmania), who built the Game Boy synthesis
engine and MIDI search. This fork adds the audio-to-MIDI pipeline, the
cleanup intelligence, and Composer Mode.

Non-commercial, for lols. Please don't sue anyone.

![Wario](public/wario-sprite.png)
