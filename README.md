# Songboy

![Songboy Logo](public/wariosynthlogo.png)

**Turn any song into Game Boy music.**

Drop in a song — upload a file or paste a YouTube link — and Songboy listens
to it, figures out the melody, bassline, and chords, cleans all of that up,
and plays it back through your browser with that warm, chip-tune Game Boy
sound. You can also search for an existing MIDI file online and run it
through the same player.

## Why this exists

Most "make my song sound like a Game Boy" tools just slap a square-wave
filter over the original audio, which sounds harsh and muddy. Songboy instead
**actually transcribes the music** — it works out what notes are being
played, separates the tune from the harmony and bass, and rebuilds the song
note-by-note using real Game Boy-style synthesis (the same kind of pulse,
triangle, and noise channels the original hardware had).

The result is closer to a chiptune cover of a song than a filtered recording
of it — clean, musical, and genuinely fun to listen to. It's not a strict
"only 4 sounds at once" emulator; the goal is to keep the original song
recognizable while giving it that retro color.

## How to use it

1. Start the app (see [Running it](#running-it) below).
2. **Upload a song** (MP3, WAV, M4A, and most other common audio/video
   formats) or **paste a YouTube link**.
3. Wait while Songboy listens to the track — you'll see a progress bar while
   it transcribes the music and works out the melody, bass, and chords.
4. Hit **Play** to hear the Game Boy version. While it plays, you'll see a
   scrolling piano-roll showing every note, which "voice" (melody/bass/chord)
   it belongs to, and what chord is playing.
5. Use the per-part volume sliders to turn the melody, bass, or chords up or
   down — or mute any of them.
6. Loop a section, jump around with the seek bar, or download the result as
   a MIDI file or a WAV audio file.

You can also search for a song by name to find an existing MIDI file online
and play that through the same Game Boy-style engine, without uploading
anything.

## What it actually does, in plain terms

1. **Listens** — FFmpeg cleans up the audio, then a neural network "ear"
   (Basic Pitch, or a dedicated piano model for piano recordings) works out
   what notes are being played and when.
2. **Understands the music** — it figures out the song's key and chords
   (using Chordino/music21 when available, otherwise a simpler chroma-based
   analysis), then quietly fixes notes that the transcription clearly got
   wrong, while leaving intentional, interesting notes alone.
3. **Arranges it** — the notes get split into a melody line, a bassline, and
   chord/harmony parts, the way a person arranging a chiptune cover would do
   it. Busy, muddy passages get gently simplified; everything else stays.
4. **Optionally separates instruments first** — for full band/song mixes,
   Songboy can run the audio through Demucs to pull out vocals, drums, bass,
   and "everything else" before transcribing, so the piano part doesn't get
   confused with the singer or the guitars.
5. **Plays it back** — everything is re-synthesized live in your browser
   using Web Audio (pulse waves with vibrato, a soft bass tone, and
   noise-based drums) — no audio samples from the original recording are
   used, it's all generated sound.

## Running it

### Windows: one-click launcher

Double-click:

```text
Start Songboy.bat
```

This installs everything it needs (Node packages, Python environment, the
piano transcription model), starts the app, and opens it in your browser.

### Manual setup (any OS)

Install the frontend and backend dependencies:

```bash
npm install
cd server
npm install
cd ..
```

Create the Python environment and install the audio-processing dependencies:

```powershell
python -m venv server/.venv
server/.venv/Scripts/python -m pip install -r server/requirements-audio.txt
```

Start the backend:

```bash
npm run dev:backend
```

Start the frontend in another terminal:

```bash
npm run dev
```

The backend runs on `http://localhost:3001`. Vite prints the frontend address
when it starts.

### What you'll need

- Node.js 20 or newer
- Python 3.11 or earlier
- FFmpeg (set `FFMPEG_PATH` to `ffmpeg.exe` if it's not on your `PATH`)
- About 165 MB of disk space for the piano transcription model

Got an NVIDIA GPU? It'll make transcription and source separation much
faster. The launcher tries to set this up automatically, or do it manually:

```powershell
server/.venv/Scripts/python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128 --upgrade
```

## A closer look at the features

### Listening and transcription

- Upload MP3, WAV, M4A, OGG, FLAC, AAC, WebM, or MP4 audio.
- Or paste a YouTube link for permitted audio.
- Dedicated piano model for solo piano (captures velocity, note length, and
  sustain pedal).
- Basic Pitch for everything else.
- Chord detection via Chordino (`sonic-annotator`) when available, with a
  librosa chroma fallback.
- music21-based key/harmony check, used to gently correct only weak, short,
  clearly-wrong notes — confident or intentional chromatic notes are left
  alone.
- Manual BPM entry or automatic tempo detection.
- Finished transcriptions are cached, so re-running the same song is fast.

### Automatic arrangement cleanup

- Tracks the likely "two hands" of a piano performance.
- Protects the melody, bassline, and important chord changes.
- Tames sustain-pedal buildup in busy passages.
- Keeps fast runs articulate; gives slow phrase endings a softer tail.
- Removes muddy low notes, redundant doublings, and overcrowded chords —
  only when a passage actually needs it.

### Game Boy-style sound

- Pulse-wave lead and arpeggio voices, with vibrato.
- Soft triangle bass and sine-based harmony.
- Noise-based kick, snare, and hi-hat.
- Velocity-sensitive volume and brightness, automatic chord loudness
  balancing, gentle compression and stereo spread.
- Live playback and offline WAV export use the exact same sound engine.

### The player

- Scrolling piano-roll in the original Game Boy green palette.
- Note names, octave guides, and live highlighting of what's playing.
- Pause and hover any note to see its pitch, velocity, voice, timing, and any
  correction that was applied.
- Per-voice volume sliders and mute buttons.
- Section looping, seeking, MIDI download, and WAV export.

### Full songs, not just piano

Optional Demucs source separation splits a full mix into vocals, drums, bass,
and other instruments before transcription — slower, but it helps a lot when
the piano part is competing with a full band.

The original MIDI search workflow is still here too: search for a song by
name, pick a result, and it plays through the same engine.

## Development

```bash
npm run typecheck
cd server && npm run build
```

Arrangement/cleanup tests:

```powershell
server/.venv/Scripts/python server/python/test_composer_mode.py
```

## Tech stack

- Frontend: TypeScript, Vite, Web Audio API
- Backend: Node.js, Express
- Audio pipeline: Python, FFmpeg, yt-dlp, librosa, pretty_midi
- Transcription: piano-transcription-inference, Basic Pitch
- Source separation: Demucs

## Responsible use

Only upload, transcribe, or share audio you own or have permission to use.
Turning a recording into a chiptune version doesn't grant copyright
permission or prevent content claims.

## Credits

Forked from [motif](https://github.com/b1rdmania/motif) by
[@b1rdmania](https://x.com/b1rdmania), who created the original concept,
interface, MIDI search, and synthesis foundation.

This fork adds the audio-to-MIDI pipeline, piano transcription, automatic
arrangement and pedal cleanup, source separation, harmony analysis, WAV
export, and the expanded musician-focused player.

![Songboy](public/wario-sprite.png)
