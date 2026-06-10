# Wario Synthesis Engine 8-Bit Midi

![Wario Synth Logo](public/wariosynthlogo.png)

Turn any song into a Game Boy version.

## Live Demo

**[www.wario.style](https://www.wario.style)**

## About

**WAH!** 🎮

Type in literally any song. We'll find a MIDI file somewhere on the internet and absolutely demolish it through a janky homebrew Game Boy sound chip running in your browser.

Is it accurate? Sometimes. Is it legal? Probably. Does it slap? **Absolutely.**

Four glorious channels of chiptune chaos:
- 🟨 **Pulse 1** — screamy lead melodies
- 🟨 **Pulse 2** — whatever pulse 1 forgot
- 🟩 **Wave** — chunky bass that hits different
- ⬜ **Noise** — percussion (tssss pshhhh)

Zero samples. Zero server audio. Just raw oscillators having the time of their lives.

**[wario.style](https://www.wario.style)** ← go make your favorite song worse

![Wario](public/wario-sprite.png)

## Features

- **Audio-to-MIDI transcription**: turn any song — an audio file or a YouTube link — into MIDI with neural transcription (Basic Pitch, or a dedicated piano model with pedal detection)
- **Composer Mode**: dense transcriptions get rewritten the way a real Game Boy composer would — skyline melody, bass floor, and inner chord tones rolled into a fast arpeggio, instead of dropping notes at random
- **MIDI cleanup intelligence**: key inference, transcription-error correction, tempo estimation, and gentle quantization before anything reaches the synth
- **MIDI search** from BitMidi and other sources
- **Browser playback** with soundfont piano preview
- **Wario Synthesis Engine**: procedural Game Boy-style synthesis from parsed MIDI structure
- **Share links** with dynamic social previews
- **Works on mobile** (iOS audio unlock included)

## Quick Start (Local)

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

On Windows you can skip all of the above: double-click `Start Wario Synth.bat`
and it installs dependencies (including the audio transcription stack), starts
both servers, and opens the app.

### Audio-to-MIDI

Wario Synth can transcribe a local audio file or permitted YouTube source
before running the Game Boy synth. This feature requires Python 3.11 or
earlier, FFmpeg, and the optional Python dependencies:

```bash
python -m venv server/.venv
server/.venv/Scripts/python -m pip install -r server/requirements-audio.txt
```

Set `FFMPEG_PATH` if `ffmpeg` is not available on `PATH`. YouTube downloading
is intended only for media you own or have permission to download.

The audio importer includes two modes:

- **Piano** uses a piano-specific neural model with note offset, velocity, and
  sustain-pedal detection. Its checkpoint is downloaded on first launch.
- **General** uses Basic Pitch for other instruments and mixed audio.

### Composer Mode

Raw transcriptions are dense: a piano cover can land ten simultaneous notes,
and the Game Boy has three pitched channels. Instead of converting every note
literally, the pipeline rewrites dense passages the way a chiptune composer
would:

- the **skyline** (top voice) becomes the melody on pulse 1
- the **floor** (lowest voice) becomes the bass on the wave channel
- the **inner chord tones** collapse into a sixteenth-note arpeggio on pulse 2

Sustained melody notes keep the skyline (chord stabs underneath don't steal
the lead), monophonic material passes through untouched, and the UI tells you
when an arrangement was applied. Run the transcriber with `--arrange off` to
get the literal transcription instead.

## How It Works

**From audio:**

1. User drops in an audio file or YouTube link
2. yt-dlp + FFmpeg fetch and normalize the audio
3. A neural model (Basic Pitch or the piano model) transcribes it to notes
4. Cleanup pass: key inference, pitch-error correction, tempo estimation, quantization
5. Composer Mode separates voices: melody / bass / arpeggio
6. Wario Synthesis Engine maps the voices to Game Boy sound channels
7. Web Audio oscillators generate the retro sound

**From MIDI search:**

1. User searches for a song
2. Backend searches MIDI sources and returns ranked candidates
3. User picks a MIDI source
4. Frontend parses MIDI into normalized note events
5. Wario Synthesis Engine maps tracks to Game Boy sound channels
6. Web Audio oscillators generate the retro sound

## Embed Widget

WARIO SYNTH includes an embeddable widget at **`/embed`**:

```html
<iframe
  src="https://www.wario.style/embed?song=Hotel%20California"
  width="420"
  height="260"
  style="border:0;border-radius:12px;overflow:hidden"
  allow="autoplay"
></iframe>
```

## Tech Stack

- **Frontend**: TypeScript, Vite, Web Audio API
- **Backend**: Express, Node.js
- **Audio pipeline**: Python, yt-dlp, FFmpeg, Basic Pitch, piano-transcription-inference, pretty_midi
- **Deployment**: Vercel
- **Built with**: Claude Code

## Credits

Original project by [@b1rdmania](https://x.com/b1rdmania). This fork adds the
local audio-to-MIDI pipeline and Composer Mode arrangement. Non-commercial,
for lols. Please don't sue anyone.

![Wario Moment](public/wario.png)
