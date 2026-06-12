# Songboy

![Songboy Logo](public/wariosynthlogo.png)

Turn an audio recording into a cleaner, expressive Game Boy-inspired version.
Upload a song or provide a YouTube link, and Songboy transcribes the
performance, separates its musical roles, controls dense piano passages, and
resynthesizes it in the browser.

This is not a strict four-channel Game Boy emulator. The goal is to preserve
the identity, harmony, rhythm, and dynamics of the original performance while
using chip-style tone as a musical color.

> Songboy is a fork of
> [b1rdmania/motif](https://github.com/b1rdmania/motif), which introduced the
> original MIDI search and Game Boy-style synthesis experience. This fork adds
> audio transcription, piano-focused arrangement intelligence, source
> separation, export tools, and an expanded player.

## Features

### Audio transcription

- Upload MP3, WAV, M4A, OGG, FLAC, AAC, WebM, or MP4 audio.
- Transcribe permitted YouTube audio by URL.
- Use a dedicated piano model with note velocity, offset, and sustain-pedal
  detection.
- Use Basic Pitch for general musical audio.
- Detect timestamped audio chords with Chordino through `sonic-annotator`
  when the native `nnls-chroma` Vamp plugin is installed.
- Fall back to librosa chroma automatically when Chordino is unavailable.
- Use music21 to check the MIDI key and symbolic harmony.
- Correct only weak, short notes that disagree with both the audio chord and
  detected key. Confident chromatic notes remain untouched.
- On Windows, Sonic Annotator is detected automatically at
  `C:\Tools\sonic-annotator-win64\sonic-annotator.exe`. A different location
  can be selected with `SONIC_ANNOTATOR_PATH`.
- Enter a known BPM or allow automatic tempo detection.
- Cache completed transcriptions so repeated conversions load quickly.

### Automatic piano cleanup

There is one faithful conversion workflow. Songboy automatically adapts
to the performance instead of asking the user to choose an arrangement mode.

- Tracks the likely left and right hands across the performance.
- Protects the melody, bass line, and important chord movement.
- Limits quiet sustain-pedal buildup during crowded passages.
- Preserves stronger phrase-ending notes across musical transitions.
- Keeps fast arpeggios articulate with shorter releases.
- Gives slower notes and phrase endings softer, longer tails.
- Removes muddy low-register seconds and redundant octave doubling.
- Reduces inner notes only when a passage becomes overloaded.
- Uses adaptive onset grouping so fast runs are not mistaken for block chords.

### Game Boy-inspired synthesis

- Pulse-wave lead and arpeggio voices.
- Softer triangle bass and sine-based harmony.
- White-noise kick, snare, and hi-hat synthesis.
- Velocity-sensitive loudness and brightness.
- Automatic chord loudness compensation.
- Gentle filtering, compression, and stereo voice separation.
- Matching live playback and offline WAV rendering.

### Musician-friendly player

- Scrolling piano-roll visualization in the original Game Boy palette.
- Note names and octave guides.
- Live display of the notes and musical voices currently sounding.
- Pause and hover over a note to inspect its:
  - pitch name
  - MIDI number
  - voice
  - velocity
  - start time
  - duration
- Per-voice volume and mute controls.
- Section looping, seeking, MIDI download, and WAV export.

### Full-song support

Optional Demucs source separation splits a recording into vocals, drums, bass,
and other material before transcription. This is slower, but it can improve
results for complete mixes where several instruments compete with the piano.

The original MIDI search workflow remains available: search for a song, select
a MIDI result, and process it through the same player and synthesis engine.

## How It Works

1. Songboy receives an uploaded file or permitted YouTube URL.
2. FFmpeg normalizes the audio.
3. The selected neural model converts the recording into timed MIDI notes.
4. The cleanup pipeline estimates tempo, applies gentle quantization, handles
   pedal information, and removes likely transcription artifacts.
5. Piano material is divided into melody, bass, and smoothly moving harmony
   voices using hand-aware tracking.
6. Automatic complexity control simplifies only the moments that would
   otherwise become crowded or muddy.
7. Web Audio oscillators render the result with a Game Boy-inspired timbre.

All generated sound is synthesized. The player does not replay samples from
the source recording.

## Quick Start

### Windows launcher

Double-click:

```text
Start Songboy.bat
```

The launcher installs the Node dependencies, creates the Python environment,
downloads the piano model when needed, starts the frontend and backend, and
opens the app.

### Manual setup

Install the frontend and backend dependencies:

```bash
npm install
cd server
npm install
cd ..
```

Create the Python environment and install the transcription dependencies:

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

## Requirements

- Node.js 20 or newer
- Python 3.11 or earlier
- FFmpeg
- Approximately 165 MB for the piano transcription checkpoint

Set `FFMPEG_PATH` to the full path of `ffmpeg.exe` if FFmpeg is not available
on `PATH`.

An NVIDIA GPU is optional. CUDA significantly speeds up piano transcription
and source separation:

```powershell
server/.venv/Scripts/python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128 --upgrade
```

The Windows launcher attempts to configure the appropriate Torch build
automatically.

## Development

Useful checks:

```bash
npm run typecheck
cd server && npm run build
```

Piano cleanup tests:

```powershell
server/.venv/Scripts/python server/python/test_composer_mode.py
```

## Tech Stack

- Frontend: TypeScript, Vite, Web Audio API
- Backend: Node.js, Express
- Audio pipeline: Python, FFmpeg, yt-dlp, librosa, pretty_midi
- Transcription: piano-transcription-inference, Basic Pitch
- Source separation: Demucs

## Responsible Use

Only download, upload, transcribe, or redistribute audio that you own or have
permission to use. Transforming a recording does not automatically grant
copyright permission or prevent content claims.

## Credits

Forked from [motif](https://github.com/b1rdmania/motif) by
[@b1rdmania](https://x.com/b1rdmania), who created the original concept,
interface, MIDI search, and synthesis foundation.

This fork adds the audio-to-MIDI pipeline, piano transcription, automatic
arrangement and pedal cleanup, source separation, WAV export, and the expanded
musician-focused visualizer.

![Songboy](public/wario-sprite.png)
