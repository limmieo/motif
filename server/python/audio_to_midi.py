#!/usr/bin/env python
"""Download or load audio, then transcribe it to MIDI with Basic Pitch."""

from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse

MIN_NOTE_DURATION_SECONDS = 0.09
TARGET_SHORT_NOTE_SECONDS = 0.14
MAX_LEGATO_GAP_SECONDS = 0.16
MAX_SAME_PITCH_GAP_SECONDS = 0.22
MAX_SIMULTANEOUS_NOTES = 4
MIN_MIDI_NOTE = 28
MAX_MIDI_NOTE = 96
MAX_QUANTIZE_SHIFT_SECONDS = 0.045

ARRANGE_ONSET_EPSILON_SECONDS = 0.06
MELODY_BASS_MIN_GAP_SEMITONES = 7
DENSE_ONSET_RATIO = 0.1
ARPEGGIO_MAX_PITCHES = 4

MAJOR_PROFILE = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
MINOR_PROFILE = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)
MAJOR_INTERVALS = {0, 2, 4, 5, 7, 9, 11}
MINOR_INTERVALS = {0, 2, 3, 5, 7, 8, 10}


def find_ffmpeg() -> str:
    configured = os.environ.get("FFMPEG_PATH")
    if configured and Path(configured).is_file():
        return configured

    media_downloader_ffmpeg = (
        Path.home() / "CascadeProjects" / "media-downloader" / "ffmpeg" / "ffmpeg.exe"
    )
    if media_downloader_ffmpeg.is_file():
        return str(media_downloader_ffmpeg)

    discovered = shutil.which("ffmpeg")
    if discovered:
        return discovered
    raise RuntimeError(
        "FFmpeg was not found. Install FFmpeg or set FFMPEG_PATH to ffmpeg.exe."
    )


def validate_youtube_url(value: str) -> None:
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    allowed = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}
    if parsed.scheme not in {"http", "https"} or host not in allowed:
        raise ValueError("Only YouTube URLs are supported.")


def download_audio(url: str, work_dir: Path, ffmpeg_path: str) -> tuple[Path, str]:
    import yt_dlp

    validate_youtube_url(url)
    options = {
        "format": "bestaudio/best",
        "outtmpl": str(work_dir / "source.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "ffmpeg_location": ffmpeg_path,
        "js_runtimes": {"node": {}},
    }
    with yt_dlp.YoutubeDL(options) as downloader:
        info = downloader.extract_info(url, download=True)
        downloaded = Path(downloader.prepare_filename(info))

    title = str(info.get("title") or "YouTube transcription").strip()
    if downloaded.is_file():
        return downloaded, title
    candidates = sorted(work_dir.glob("source.*"))
    if not candidates:
        raise RuntimeError("The YouTube audio download did not produce a file.")
    return candidates[0], title


def convert_to_wav(source: Path, target: Path, ffmpeg_path: str) -> None:
    result = subprocess.run(
        [
            ffmpeg_path,
            "-y",
            "-i",
            str(source),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "22050",
            str(target),
        ],
        capture_output=True,
        text=True,
        timeout=600,
    )
    if result.returncode != 0:
        detail = result.stderr.strip().splitlines()[-1:] or ["Unknown FFmpeg error"]
        raise RuntimeError(f"Audio conversion failed: {detail[0]}")


def transcribe(source: Path, output: Path, mode: str) -> None:
    if mode == "piano":
        transcribe_piano(source, output)
        return

    transcribe_general(source, output)


def transcribe_general(source: Path, output: Path) -> None:
    from basic_pitch.inference import predict

    _, midi_data, note_events = predict(
        str(source),
        onset_threshold=0.58,
        frame_threshold=0.35,
        minimum_note_length=90,
        minimum_frequency=41.2,
        maximum_frequency=2093.0,
        multiple_pitch_bends=False,
        melodia_trick=True,
    )
    if not note_events:
        raise RuntimeError("No clear musical notes were detected in this audio.")

    clean_midi(midi_data)
    output.parent.mkdir(parents=True, exist_ok=True)
    midi_data.write(str(output))


def transcribe_piano(source: Path, output: Path) -> None:
    import librosa
    import pretty_midi
    import torch
    from piano_transcription_inference import PianoTranscription, sample_rate

    checkpoint = (
        Path(__file__).resolve().parents[1] / "models" / "piano-note-pedal.pth"
    )
    if not checkpoint.is_file():
        raise RuntimeError(
            "Piano model checkpoint is missing. Reinstall Piano Mode."
        )

    audio, _ = librosa.load(str(source), sr=sample_rate, mono=True)
    transcriber = PianoTranscription(
        device=torch.device("cpu"),
        checkpoint_path=str(checkpoint),
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    result = transcriber.transcribe(audio, str(output))
    if not result.get("est_note_events"):
        raise RuntimeError("The piano model did not detect any notes.")

    midi_data = pretty_midi.PrettyMIDI(str(output))
    apply_pedal_sustain(midi_data, result.get("est_pedal_events", []))
    clean_piano_midi(midi_data, len(audio) / sample_rate)
    midi_data.write(str(output))


def apply_pedal_sustain(midi_data, pedal_events) -> None:
    """Bake sustain-pedal holds into note lengths for synths that ignore CC64."""
    pedal_ranges = []
    for event in pedal_events:
        start = event.get("onset_time")
        end = event.get("offset_time")
        if start is not None and end is not None and end > start:
            pedal_ranges.append((float(start), float(end)))

    if not pedal_ranges:
        return

    for instrument in midi_data.instruments:
        by_pitch = {}
        for note in instrument.notes:
            by_pitch.setdefault(note.pitch, []).append(note)

        for pitch_notes in by_pitch.values():
            pitch_notes.sort(key=lambda note: note.start)
            for index, note in enumerate(pitch_notes):
                next_start = (
                    pitch_notes[index + 1].start
                    if index + 1 < len(pitch_notes)
                    else float("inf")
                )
                for pedal_start, pedal_end in pedal_ranges:
                    if pedal_start <= note.end <= pedal_end:
                        note.end = min(pedal_end, next_start, note.end + 1.5)
                        break


def clean_piano_midi(midi_data, audio_duration: float) -> None:
    """Keep the piano model's musical timing while removing tiny artifacts."""
    for instrument in midi_data.instruments:
        for note in instrument.notes:
            note.end = min(note.end, audio_duration)
        instrument.notes = [
            note
            for note in instrument.notes
            if (
                note.end - note.start >= 0.06
                and MIN_MIDI_NOTE <= note.pitch <= MAX_MIDI_NOTE
            )
        ]
        instrument.notes.sort(key=lambda note: (note.start, note.pitch, note.end))


def clean_midi(midi_data) -> None:
    """Reduce transcription noise before the four-channel Game Boy arranger."""
    for instrument in midi_data.instruments:
        candidates = [
            note
            for note in instrument.notes
            if (
                note.end - note.start >= MIN_NOTE_DURATION_SECONDS
                and MIN_MIDI_NOTE <= note.pitch <= MAX_MIDI_NOTE
            )
        ]
        candidates.sort(key=lambda note: (note.start, -note.velocity, note.pitch))

        cleaned = []
        for note in candidates:
            # Basic Pitch can emit duplicate/overlapping detections of one pitch.
            duplicate = next(
                (
                    existing
                    for existing in reversed(cleaned)
                    if existing.pitch == note.pitch
                    and note.start < existing.end
                    and abs(note.start - existing.start) < 0.08
                ),
                None,
            )
            if duplicate:
                duplicate.end = max(duplicate.end, note.end)
                duplicate.velocity = max(duplicate.velocity, note.velocity)
                continue

            active = [
                existing
                for existing in cleaned
                if existing.start <= note.start < existing.end
            ]
            if len(active) >= MAX_SIMULTANEOUS_NOTES:
                quietest = min(active, key=lambda existing: existing.velocity)
                if note.velocity <= quietest.velocity:
                    continue
                quietest.end = max(quietest.start + MIN_NOTE_DURATION_SECONDS, note.start)

            cleaned.append(note)

        instrument.notes = [
            note
            for note in cleaned
            if note.end - note.start >= MIN_NOTE_DURATION_SECONDS
        ]
        repair_note_timing(instrument.notes)

    apply_music_intelligence(midi_data)


def apply_music_intelligence(midi_data) -> None:
    """Apply conservative key, rhythm, and voice-leading corrections."""
    notes = [
        note
        for instrument in midi_data.instruments
        if not instrument.is_drum
        for note in instrument.notes
    ]
    if len(notes) < 4:
        return

    key = infer_key(notes)
    if key is not None:
        tonic, mode, confidence = key
        if confidence >= 0.035:
            correct_likely_pitch_errors(notes, tonic, mode)

    quantize_near_grid(midi_data, notes, estimate_tempo(midi_data, notes))


def infer_key(notes):
    """Return (tonic pitch class, mode, confidence) from weighted pitch usage."""
    histogram = [0.0] * 12
    for note in notes:
        duration = max(MIN_NOTE_DURATION_SECONDS, note.end - note.start)
        histogram[note.pitch % 12] += duration * max(1, note.velocity)

    total = sum(histogram)
    if total <= 0:
        return None
    histogram = [value / total for value in histogram]

    candidates = []
    for tonic in range(12):
        for mode, profile in (("major", MAJOR_PROFILE), ("minor", MINOR_PROFILE)):
            rotated = [profile[(pitch_class - tonic) % 12] for pitch_class in range(12)]
            score = cosine_similarity(histogram, rotated)
            candidates.append((score, tonic, mode))

    candidates.sort(reverse=True)
    best_score, tonic, mode = candidates[0]
    second_score = candidates[1][0]
    return tonic, mode, best_score - second_score


def cosine_similarity(left, right) -> float:
    numerator = sum(a * b for a, b in zip(left, right))
    left_size = math.sqrt(sum(value * value for value in left))
    right_size = math.sqrt(sum(value * value for value in right))
    if left_size == 0 or right_size == 0:
        return 0.0
    return numerator / (left_size * right_size)


def correct_likely_pitch_errors(notes, tonic: int, mode: str) -> None:
    """Snap only weak, short, one-semitone scale misses."""
    scale = MAJOR_INTERVALS if mode == "major" else MINOR_INTERVALS
    velocities = [note.velocity for note in notes]
    median_velocity = statistics.median(velocities)

    for note in notes:
        if (note.pitch - tonic) % 12 in scale:
            continue

        duration = note.end - note.start
        is_uncertain = note.velocity <= median_velocity * 0.9 or duration <= 0.28
        if not is_uncertain:
            continue

        candidates = [
            pitch
            for pitch in (note.pitch - 1, note.pitch + 1)
            if MIN_MIDI_NOTE <= pitch <= MAX_MIDI_NOTE
            and (pitch - tonic) % 12 in scale
        ]
        if not candidates:
            continue

        nearby = [
            other.pitch
            for other in notes
            if other is not note and abs(other.start - note.start) <= 0.35
        ]
        if nearby:
            note.pitch = min(
                candidates,
                key=lambda pitch: sum(abs(pitch - nearby_pitch) for nearby_pitch in nearby),
            )
        else:
            note.pitch = min(candidates, key=lambda pitch: abs(pitch - note.pitch))


def estimate_tempo(midi_data, notes) -> float:
    try:
        tempo = float(midi_data.estimate_tempo())
        if math.isfinite(tempo) and 55 <= tempo <= 200:
            return tempo
    except Exception:
        pass

    onsets = sorted({round(note.start, 3) for note in notes})
    intervals = [
        later - earlier
        for earlier, later in zip(onsets, onsets[1:])
        if 0.18 <= later - earlier <= 1.2
    ]
    if not intervals:
        return 120.0
    beat = statistics.median(intervals)
    tempo = 60.0 / beat
    while tempo < 70:
        tempo *= 2
    while tempo > 180:
        tempo /= 2
    return tempo


def quantize_near_grid(midi_data, notes, tempo: float) -> None:
    """Remove small transcription jitter without flattening expressive timing."""
    grid = (60.0 / tempo) / 4.0
    if grid <= 0:
        return
    origin = min(note.start for note in notes)

    def snap(value: float) -> float:
        target = origin + round((value - origin) / grid) * grid
        if abs(target - value) <= MAX_QUANTIZE_SHIFT_SECONDS:
            return max(0.0, target)
        return value

    for note in notes:
        original_end = note.end
        note.start = snap(note.start)
        note.end = snap(note.end)
        if note.end - note.start < MIN_NOTE_DURATION_SECONDS:
            note.end = max(original_end, note.start + MIN_NOTE_DURATION_SECONDS)

    for instrument in midi_data.instruments:
        instrument.notes.sort(key=lambda note: (note.start, note.pitch, note.end))


def repair_note_timing(notes) -> None:
    """Close transcription micro-gaps while preserving deliberate musical rests."""
    notes.sort(key=lambda note: (note.start, note.pitch, note.end))

    # Join repeated notes that Basic Pitch split around a tiny confidence dip.
    merged = []
    for note in notes:
        previous_same_pitch = next(
            (
                previous
                for previous in reversed(merged)
                if previous.pitch == note.pitch
                and 0 <= note.start - previous.end <= MAX_SAME_PITCH_GAP_SECONDS
            ),
            None,
        )
        if previous_same_pitch:
            previous_same_pitch.end = max(previous_same_pitch.end, note.end)
            previous_same_pitch.velocity = max(previous_same_pitch.velocity, note.velocity)
            continue
        merged.append(note)

    onset_times = sorted({note.start for note in merged})
    for note in merged:
        next_onset = next((start for start in onset_times if start > note.start + 0.01), None)
        if next_onset is None:
            continue

        gap = next_onset - note.end
        if 0 < gap <= MAX_LEGATO_GAP_SECONDS:
            note.end = next_onset
        elif note.end - note.start < TARGET_SHORT_NOTE_SECONDS and next_onset > note.end:
            note.end = min(next_onset, note.start + TARGET_SHORT_NOTE_SECONDS)

    notes[:] = sorted(merged, key=lambda note: (note.start, note.pitch, note.end))


def apply_composer_arrangement(midi_path: Path) -> bool:
    import pretty_midi

    midi_data = pretty_midi.PrettyMIDI(str(midi_path))
    if not arrange_for_game_boy(midi_data):
        return False
    midi_data.write(str(midi_path))
    return True


def arrange_for_game_boy(midi_data) -> bool:
    """Composer Mode: rewrite dense polyphony as separate Game Boy voices.

    A ten-note piano chord cannot play on Game Boy hardware (two pulse
    channels plus one wave channel). Instead of dropping notes arbitrarily,
    split the transcription the way a chiptune composer would: skyline
    melody, bass floor, and the inner chord tones rolled into an arpeggio.
    """
    import pretty_midi

    notes = sorted(
        (
            note
            for instrument in midi_data.instruments
            if not instrument.is_drum
            for note in instrument.notes
        ),
        key=lambda note: (note.start, -note.pitch, note.end),
    )
    if len(notes) < 8 or not is_dense_polyphony(notes):
        return False

    melody, bass, inner = separate_voices(notes)
    if not melody:
        return False

    arpeggio = arpeggiate_inner_voices(inner, estimate_tempo(midi_data, notes))

    instruments = []
    for name, voice in (("Melody", melody), ("Bass", bass), ("Arpeggio", arpeggio)):
        if not voice:
            continue
        instrument = pretty_midi.Instrument(program=0, name=name)
        instrument.notes = sorted(voice, key=lambda note: (note.start, note.pitch))
        instruments.append(instrument)

    midi_data.instruments = instruments
    return True


def is_dense_polyphony(notes) -> bool:
    """True when chords are thick enough that voice separation helps."""
    import bisect

    starts = sorted(note.start for note in notes)
    ends = sorted(note.end for note in notes)
    onsets = sorted(set(starts))

    dense_onsets = 0
    for onset in onsets:
        sounding = bisect.bisect_right(starts, onset) - bisect.bisect_right(ends, onset)
        if sounding >= 3:
            dense_onsets += 1

    return dense_onsets / len(onsets) >= DENSE_ONSET_RATIO


def separate_voices(notes):
    """Split notes into melody (skyline), bass (floor), and inner voices."""
    melody = []
    bass = []
    inner = []

    clusters = []
    for note in notes:
        if clusters and note.start - clusters[-1][0].start <= ARRANGE_ONSET_EPSILON_SECONDS:
            clusters[-1].append(note)
        else:
            clusters.append([note])

    for cluster in clusters:
        cluster.sort(key=lambda note: (-note.pitch, -note.velocity))
        remaining = list(cluster)

        # The top of the cluster leads unless a sustained melody note still
        # rings above it, in which case the whole cluster is accompaniment.
        top = remaining[0]
        held_melody = melody[-1] if melody else None
        melody_is_held = (
            held_melody is not None
            and held_melody.end > top.start + ARRANGE_ONSET_EPSILON_SECONDS
            and held_melody.pitch > top.pitch
        )
        if not melody_is_held:
            melody.append(top)
            remaining = remaining[1:]

        if remaining:
            low = remaining[-1]
            reference = melody[-1].pitch if melody else top.pitch
            if reference - low.pitch >= MELODY_BASS_MIN_GAP_SEMITONES:
                bass.append(low)
                remaining = remaining[:-1]

        inner.extend(remaining)

    enforce_monophony(melody)
    enforce_monophony(bass)
    return melody, bass, inner


def enforce_monophony(voice) -> None:
    """Trim overlaps so the voice fits a single Game Boy channel."""
    voice.sort(key=lambda note: (note.start, note.pitch))
    for current, upcoming in zip(voice, voice[1:]):
        if current.end > upcoming.start:
            current.end = upcoming.start
    voice[:] = [
        note for note in voice if note.end - note.start >= MIN_NOTE_DURATION_SECONDS
    ]


def arpeggiate_inner_voices(inner, tempo: float):
    """Roll sustained inner chords into a low-to-high arpeggio pattern."""
    import pretty_midi

    if not inner:
        return []
    inner = sorted(inner, key=lambda note: (note.start, note.pitch))

    segments = []
    for note in inner:
        if segments and note.start < segments[-1]["end"]:
            segments[-1]["notes"].append(note)
            segments[-1]["end"] = max(segments[-1]["end"], note.end)
        else:
            segments.append({"notes": [note], "end": note.end})

    # Sixteenth-note arp rate, clamped so chords always cycle audibly.
    step = min(0.25, max(0.1, (60.0 / tempo) / 4.0))
    result = []
    for segment in segments:
        segment_notes = segment["notes"]
        start = min(note.start for note in segment_notes)
        end = segment["end"]
        pitches = sorted({note.pitch for note in segment_notes})
        if len(pitches) > ARPEGGIO_MAX_PITCHES:
            stride = max(1, len(pitches) // ARPEGGIO_MAX_PITCHES)
            pitches = pitches[::stride][:ARPEGGIO_MAX_PITCHES]

        # A single sustained pitch is a counter-line, not a chord: keep it.
        if len(pitches) < 2 or end - start < step * 1.5:
            result.extend(segment_notes)
            continue

        velocity = int(statistics.mean(note.velocity for note in segment_notes) * 0.9)
        velocity = max(1, min(127, velocity))
        position = start
        index = 0
        while position < end - 1e-6:
            note_end = min(position + step, end)
            if note_end - position >= MIN_NOTE_DURATION_SECONDS:
                result.append(
                    pretty_midi.Note(
                        velocity=velocity,
                        pitch=pitches[index % len(pitches)],
                        start=position,
                        end=note_end,
                    )
                )
            position += step
            index += 1

    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    source_group = parser.add_mutually_exclusive_group(required=True)
    source_group.add_argument("--input", type=Path)
    source_group.add_argument("--url")
    parser.add_argument("--mode", choices=("general", "piano"), default="piano")
    parser.add_argument("--arrange", choices=("composer", "off"), default="composer")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--metadata-output", type=Path)
    args = parser.parse_args()

    try:
        ffmpeg_path = find_ffmpeg()
        with tempfile.TemporaryDirectory(prefix="motif-audio-") as temp:
            work_dir = Path(temp)
            if args.url:
                source, title = download_audio(args.url, work_dir, ffmpeg_path)
            else:
                source = args.input.resolve()
                if not source.is_file():
                    raise FileNotFoundError(f"Audio file not found: {source}")
                title = source.stem

            normalized = work_dir / "normalized.wav"
            convert_to_wav(source, normalized, ffmpeg_path)
            transcribe(normalized, args.output.resolve(), args.mode)
            arranged = (
                args.arrange == "composer"
                and apply_composer_arrangement(args.output.resolve())
            )
            if args.metadata_output:
                args.metadata_output.resolve().write_text(
                    json.dumps(
                        {
                            "title": title,
                            "arrangement": "composer" if arranged else "original",
                        },
                        ensure_ascii=True,
                    ),
                    encoding="utf-8",
                )
        return 0
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
