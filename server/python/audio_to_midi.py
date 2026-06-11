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
# Polyphony safety cap. Generous on purpose: the goal is the retro timbre,
# not strict Game Boy hardware limits — keep the full musical picture.
MAX_SIMULTANEOUS_NOTES = 10
MIN_MIDI_NOTE = 28
MAX_MIDI_NOTE = 96
MAX_QUANTIZE_SHIFT_SECONDS = 0.045

ARRANGE_ONSET_EPSILON_SECONDS = 0.06
MELODY_BASS_MIN_GAP_SEMITONES = 7
DENSE_ONSET_RATIO = 0.1
ARPEGGIO_MAX_PITCHES = 2
ARPEGGIO_VELOCITY_SCALE = 0.45
ARPEGGIO_GATE_RATIO = 0.55
BASS_VELOCITY_SCALE = 0.72
MELODY_OUTPUT_RANGE = (55, 81)
BASS_OUTPUT_RANGE = (31, 52)
ARPEGGIO_OUTPUT_RANGE = (48, 72)
HARMONY_LOW_OUTPUT_RANGE = (43, 67)
HARMONY_HIGH_OUTPUT_RANGE = (52, 76)

# Full-mix transcriptions are noisy: harmonics show up as weak notes an
# octave or two above the real melody, and quiet artifacts clutter the
# texture. These thresholds reject them without touching confident notes.
NOISE_VELOCITY_RATIO = 0.4
NOISE_MAX_DURATION_SECONDS = 0.12
MELODY_MAX_LEAP_SEMITONES = 12
MELODY_SPIKE_MAX_DURATION_SECONDS = 0.2
MELODY_EMA_WEIGHT = 0.25
BASS_MAX_PITCH = 55
INNER_VELOCITY_RATIO = 0.45
STUCK_HIGH_MIN_PITCH = 84
STUCK_HIGH_MIN_DURATION_SECONDS = 1.2
STUCK_HIGH_MIN_LOWER_ONSETS = 4
STUCK_HIGH_MIN_INTERVAL_SEMITONES = 7

MAJOR_PROFILE = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
MINOR_PROFILE = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)
MAJOR_INTERVALS = {0, 2, 4, 5, 7, 9, 11}
MINOR_INTERVALS = {0, 2, 3, 5, 7, 8, 10}


def report_progress(percent: int, label: str) -> None:
    """Emit a machine-readable progress line for the Node server to relay."""
    print("PROGRESS " + json.dumps({"percent": percent, "label": label}), flush=True)


def select_torch_device() -> str:
    """Use the GPU when one is available — Demucs runs ~10x faster on CUDA."""
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


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


def analyze_audio_timing(source: Path) -> tuple[float | None, list[float]]:
    """Detect tempo and section boundaries in one pass over the audio.

    Decoding the file and tracking beats once (instead of separately for
    tempo and for sections) halves the analysis cost with identical results.
    """
    try:
        import librosa
        import numpy as np

        audio, sample_rate = librosa.load(str(source), sr=22050, mono=True)
        if len(audio) < sample_rate * 3:
            return None, []
        duration = len(audio) / sample_rate

        onset_envelope = librosa.onset.onset_strength(
            y=audio,
            sr=sample_rate,
            aggregate=np.median,
        )
        tempo_raw, beats = librosa.beat.beat_track(
            onset_envelope=onset_envelope,
            sr=sample_rate,
        )

        tempo = None
        tempo_values = np.asarray(tempo_raw).reshape(-1)
        if tempo_values.size > 0 and len(beats) >= 4:
            detected = float(tempo_values[0])
            if math.isfinite(detected) and 40 <= detected <= 240:
                tempo = round(detected, 1)

        sections: list[float] = []
        if duration >= 40 and len(beats) >= 16:
            chroma = librosa.feature.chroma_cqt(y=audio, sr=sample_rate)
            synced = librosa.util.sync(chroma, beats)
            segment_count = int(max(3, min(10, duration // 25)))
            if synced.shape[1] > segment_count:
                boundaries = librosa.segment.agglomerative(synced, segment_count)
                boundary_beats = beats[np.clip(boundaries, 0, len(beats) - 1)]
                times = librosa.frames_to_time(boundary_beats, sr=sample_rate)
                sections = sorted({round(float(time), 2) for time in times if time < duration - 5})
                if sections and sections[0] > 1.0:
                    sections.insert(0, 0.0)

        return tempo, sections
    except Exception as error:
        print(f"Audio timing analysis skipped: {error}", file=sys.stderr)
        return None, []


def transcribe(source: Path, output: Path, mode: str, tempo_override: float | None = None) -> None:
    if mode == "piano":
        transcribe_piano(source, output, tempo_override)
        return

    transcribe_general(source, output, tempo_override)


def transcribe_general(source: Path, output: Path, tempo_override: float | None = None) -> None:
    report_progress(35, "Loading the transcription model")
    from basic_pitch.inference import predict

    report_progress(45, "Listening for notes (the long part)")
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

    report_progress(88, "Cleaning up the notes")
    clean_midi(midi_data, tempo_override)
    output.parent.mkdir(parents=True, exist_ok=True)
    midi_data.write(str(output))


def transcribe_piano(source: Path, output: Path, tempo_override: float | None = None) -> None:
    report_progress(35, "Loading the piano model")
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
        device=torch.device(select_torch_device()),
        checkpoint_path=str(checkpoint),
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    report_progress(45, "Transcribing piano audio (the long part)")
    result = transcriber.transcribe(audio, str(output))
    if not result.get("est_note_events"):
        raise RuntimeError("The piano model did not detect any notes.")

    report_progress(88, "Cleaning up the notes")
    midi_data = pretty_midi.PrettyMIDI(str(output))
    apply_pedal_sustain(midi_data, result.get("est_pedal_events", []))
    clean_piano_midi(midi_data, len(audio) / sample_rate)
    if tempo_override is not None:
        notes = [
            note
            for instrument in midi_data.instruments
            if not instrument.is_drum
            for note in instrument.notes
        ]
        if notes:
            quantize_near_grid(midi_data, notes, tempo_override)
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


def clean_midi(midi_data, tempo_override: float | None = None) -> None:
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

    apply_music_intelligence(midi_data, tempo_override)


def apply_music_intelligence(midi_data, tempo_override: float | None = None) -> None:
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

    tempo = tempo_override if tempo_override is not None else estimate_tempo(midi_data, notes)
    quantize_near_grid(midi_data, notes, tempo)


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


def separate_stems(source: Path, work_dir: Path) -> dict[str, Path]:
    """Split the mix into vocals / drums / bass / other with Demucs.

    Drives the model directly (librosa in, soundfile out) because the
    demucs CLI save path requires torchcodec, which is not available on
    this platform.
    """
    import librosa
    import soundfile
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    device = select_torch_device()
    model = get_model("htdemucs")
    model.to(device)
    model.eval()

    audio, _ = librosa.load(str(source), sr=model.samplerate, mono=False)
    wav = torch.from_numpy(audio)
    if wav.dim() == 1:
        wav = wav[None]
    if wav.shape[0] < model.audio_channels:
        wav = wav.repeat(model.audio_channels, 1)

    reference = wav.mean(0)
    mean, std = reference.mean(), reference.std() + 1e-8
    normalized = ((wav - mean) / std).to(device)

    with torch.no_grad():
        sources = apply_model(
            model,
            normalized[None],
            device=device,
            progress=False,
            split=True,
            overlap=0.25,
            # Process segments on a thread pool: same output, much faster on CPU.
            num_workers=0 if device == "cuda" else min(8, os.cpu_count() or 1),
        )[0]
    sources = (sources.cpu() * std + mean)

    stem_dir = work_dir / "stems"
    stem_dir.mkdir(parents=True, exist_ok=True)
    stems: dict[str, Path] = {}
    for name, tensor in zip(model.sources, sources):
        stem_path = stem_dir / f"{name}.wav"
        soundfile.write(str(stem_path), tensor.numpy().T, model.samplerate)
        stems[name] = stem_path

    if not stems:
        raise RuntimeError("Source separation produced no stems.")
    return stems


def transcribe_stem_notes(source: Path, minimum_frequency: float, maximum_frequency: float):
    """Transcribe one isolated stem and return its cleaned notes."""
    from basic_pitch.inference import predict

    _, midi_data, note_events = predict(
        str(source),
        onset_threshold=0.55,
        frame_threshold=0.32,
        minimum_note_length=90,
        minimum_frequency=minimum_frequency,
        maximum_frequency=maximum_frequency,
        multiple_pitch_bends=False,
        melodia_trick=True,
    )
    if not note_events:
        return []

    clean_midi(midi_data)
    return [
        note
        for instrument in midi_data.instruments
        if not instrument.is_drum
        for note in instrument.notes
    ]


def reduce_to_lead(notes):
    """Keep the strongest voice per onset — the lead line of a vocal stem."""
    if not notes:
        return []
    clusters = []
    for note in sorted(notes, key=lambda item: (item.start, -item.velocity)):
        if clusters and note.start - clusters[-1][0].start <= ARRANGE_ONSET_EPSILON_SECONDS:
            clusters[-1].append(note)
        else:
            clusters.append([note])
    lead = [
        max(cluster, key=lambda note: (note.velocity, note.pitch))
        for cluster in clusters
    ]
    enforce_monophony(lead)
    return lead


def reduce_to_bass_line(notes):
    """Keep the lowest voice per onset — the actual bass line of a bass stem."""
    if not notes:
        return []
    clusters = []
    for note in sorted(notes, key=lambda item: (item.start, item.pitch)):
        if clusters and note.start - clusters[-1][0].start <= ARRANGE_ONSET_EPSILON_SECONDS:
            clusters[-1].append(note)
        else:
            clusters.append([note])
    line = [min(cluster, key=lambda note: note.pitch) for cluster in clusters]
    enforce_monophony(line)
    return line


def detect_drum_hits(source: Path):
    """Turn the drum stem into kick/hat onsets for the noise channel."""
    import librosa
    import numpy as np

    audio, sample_rate = librosa.load(str(source), sr=22050, mono=True)
    if len(audio) < sample_rate:
        return []

    onset_envelope = librosa.onset.onset_strength(y=audio, sr=sample_rate)
    onset_times = librosa.onset.onset_detect(
        onset_envelope=onset_envelope,
        sr=sample_rate,
        units="time",
        backtrack=False,
    )
    if len(onset_times) == 0:
        return []

    onset_frames = librosa.time_to_frames(onset_times, sr=sample_rate)
    strengths = [
        float(onset_envelope[frame]) if 0 <= frame < len(onset_envelope) else 0.0
        for frame in onset_frames
    ]
    peak_strength = max(strengths) or 1.0

    hits = []
    for time, strength in zip(onset_times, strengths):
        begin = int(time * sample_rate)
        window = audio[begin : begin + int(0.05 * sample_rate)]
        if len(window) < 64:
            continue
        centroid = float(
            librosa.feature.spectral_centroid(y=window, sr=sample_rate).mean()
        )
        # Low-centroid hits are kicks, bright ones are hats/snares.
        pitch = 36 if centroid < 1800 else 42
        velocity = int(40 + (strength / peak_strength) * 70)
        hits.append((float(time), pitch, max(1, min(127, velocity))))

    return hits


def transcribe_with_stems(
    source: Path,
    output: Path,
    work_dir: Path,
    tempo_override: float | None = None,
) -> None:
    """Full-quality path: separate instruments, then transcribe each stem.

    The stems already answer "what is melody / bass / drums", so this path
    skips the guessing that Composer Mode does on a mixed transcription.
    """
    import pretty_midi

    from concurrent.futures import ThreadPoolExecutor

    report_progress(34, "Separating instruments (vocals, drums, bass, other)")
    stems = separate_stems(source, work_dir)

    combined = pretty_midi.PrettyMIDI()
    stem_plan = (
        ("vocals", "Melody", 73.4, 1318.5),
        ("other", "Harmony", 65.4, 2093.0),
        ("bass", "Bass", 30.9, 523.3),
    )

    # The stems are independent: transcribe them (and detect drums) in
    # parallel. Identical results, roughly a third of the wall time.
    report_progress(50, "Transcribing all stems in parallel")
    with ThreadPoolExecutor(max_workers=4) as pool:
        note_futures = {
            track_name: pool.submit(
                transcribe_stem_notes, stems[stem_name], minimum_frequency, maximum_frequency
            )
            for stem_name, track_name, minimum_frequency, maximum_frequency in stem_plan
            if stem_name in stems
        }
        drum_future = (
            pool.submit(detect_drum_hits, stems["drums"]) if "drums" in stems else None
        )

        done_count = 0
        for track_name, future in note_futures.items():
            notes = future.result()
            done_count += 1
            report_progress(50 + done_count * 12, f"{track_name} stem transcribed")
            if track_name == "Melody":
                notes = reduce_to_lead(notes)
            elif track_name == "Bass":
                notes = reduce_to_bass_line(notes)
            if not notes:
                continue
            instrument = pretty_midi.Instrument(program=0, name=track_name)
            instrument.notes = sorted(notes, key=lambda note: (note.start, note.pitch))
            combined.instruments.append(instrument)

        if drum_future is not None:
            hits = drum_future.result()
            if hits:
                drums = pretty_midi.Instrument(program=0, is_drum=True, name="Drums")
                drums.notes = [
                    pretty_midi.Note(velocity=velocity, pitch=pitch, start=time, end=time + 0.08)
                    for time, pitch, velocity in hits
                ]
                combined.instruments.append(drums)

    if not combined.instruments:
        raise RuntimeError("Source separation found no transcribable music in this audio.")

    report_progress(90, "Aligning the timing")
    pitched_notes = [
        note
        for instrument in combined.instruments
        if not instrument.is_drum
        for note in instrument.notes
    ]
    if pitched_notes:
        tempo = tempo_override if tempo_override is not None else estimate_tempo(combined, pitched_notes)
        quantize_near_grid(combined, pitched_notes, tempo)

    output.parent.mkdir(parents=True, exist_ok=True)
    combined.write(str(output))


def apply_composer_arrangement(
    midi_path: Path,
    expanded: bool = False,
    tempo_override: float | None = None,
) -> bool:
    import pretty_midi

    midi_data = pretty_midi.PrettyMIDI(str(midi_path))
    if not arrange_for_game_boy(
        midi_data,
        expanded=expanded,
        tempo_override=tempo_override,
    ):
        return False
    midi_data.write(str(midi_path))
    return True


def arrange_for_game_boy(
    midi_data,
    expanded: bool = False,
    tempo_override: float | None = None,
) -> bool:
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
    notes = drop_noise_floor(notes)
    notes = drop_stuck_high_tones(notes)
    if len(notes) < 8 or not is_dense_polyphony(notes):
        return False

    melody, bass, inner = separate_voices(notes)
    if not melody:
        return False

    scale = None
    key = infer_key(notes)
    if key is not None:
        tonic, mode, confidence = key
        if confidence >= 0.02:
            intervals = MAJOR_INTERVALS if mode == "major" else MINOR_INTERVALS
            scale = {(tonic + interval) % 12 for interval in intervals}

    fit_voice_register(melody, *MELODY_OUTPUT_RANGE)
    fit_voice_register(bass, *BASS_OUTPUT_RANGE)
    scale_voice_velocity(bass, BASS_VELOCITY_SCALE)

    if expanded:
        harmony_low, harmony_high = split_harmony_voices(inner, scale)
        fit_voice_register(harmony_low, *HARMONY_LOW_OUTPUT_RANGE)
        fit_voice_register(harmony_high, *HARMONY_HIGH_OUTPUT_RANGE)
        scale_voice_velocity(harmony_low, 0.62)
        scale_voice_velocity(harmony_high, 0.58)
        named_voices = (
            ("Melody", melody),
            ("Bass", bass),
            ("Harmony Low", harmony_low),
            ("Harmony High", harmony_high),
        )
    else:
        tempo = tempo_override if tempo_override is not None else estimate_tempo(midi_data, notes)
        arpeggio = arpeggiate_inner_voices(inner, tempo, scale)
        fit_voice_register(arpeggio, *ARPEGGIO_OUTPUT_RANGE)
        named_voices = (("Melody", melody), ("Bass", bass), ("Arpeggio", arpeggio))

    instruments = []
    for name, voice in named_voices:
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


def drop_noise_floor(notes):
    """Discard weak, short detections — typical full-mix transcription noise."""
    if len(notes) < 12:
        return notes
    median_velocity = statistics.median(note.velocity for note in notes)
    return [
        note
        for note in notes
        if not (
            note.velocity < median_velocity * NOISE_VELOCITY_RATIO
            and note.end - note.start <= NOISE_MAX_DURATION_SECONDS
        )
    ]


def drop_stuck_high_tones(notes):
    """Remove long high spectral lines that sit above changing real notes."""
    if len(notes) < 12:
        return notes

    median_velocity = statistics.median(note.velocity for note in notes)
    filtered = []
    for note in notes:
        duration = note.end - note.start
        if note.pitch < STUCK_HIGH_MIN_PITCH or duration < STUCK_HIGH_MIN_DURATION_SECONDS:
            filtered.append(note)
            continue

        lower_onsets = {
            round(other.start / ARRANGE_ONSET_EPSILON_SECONDS)
            for other in notes
            if other is not note
            and note.start <= other.start < note.end
            and note.pitch - other.pitch >= STUCK_HIGH_MIN_INTERVAL_SEMITONES
        }
        is_confident_lead = note.velocity >= median_velocity * 1.35
        if len(lower_onsets) < STUCK_HIGH_MIN_LOWER_ONSETS or is_confident_lead:
            filtered.append(note)

    return filtered


def is_melody_spike(note, melody_center, median_velocity) -> bool:
    """Detect short or weak notes leaping far above the established melody.

    On full mixes the transcriber hears overtones as real notes an octave or
    two above the tune; a naive skyline hands them the lead. A genuine
    register change is sustained and confident, a harmonic is not.
    """
    if melody_center is None:
        return False
    if note.pitch - melody_center <= MELODY_MAX_LEAP_SEMITONES:
        return False
    return (
        note.end - note.start < MELODY_SPIKE_MAX_DURATION_SECONDS
        or note.velocity < median_velocity
    )


def separate_voices(notes):
    """Split notes into melody (skyline), bass (floor), and inner voices."""
    melody = []
    bass = []
    inner = []
    median_velocity = statistics.median(note.velocity for note in notes)

    clusters = []
    for note in notes:
        if clusters and note.start - clusters[-1][0].start <= ARRANGE_ONSET_EPSILON_SECONDS:
            clusters[-1].append(note)
        else:
            clusters.append([note])

    melody_center = None
    for cluster in clusters:
        cluster.sort(key=lambda note: (-note.pitch, -note.velocity))
        # Harmonic spikes are artifacts: drop them entirely rather than
        # letting them lead the melody or clutter the arpeggio.
        remaining = [
            note
            for note in cluster
            if not is_melody_spike(note, melody_center, median_velocity)
        ]
        if not remaining:
            continue

        # The top of the cluster leads unless a sustained melody note still
        # rings above a multi-note chord. A single following note is usually
        # the next step of a melodic arpeggio, so it must replace the held note
        # instead of disappearing underneath it.
        top = remaining[0]
        held_melody = melody[-1] if melody else None
        melody_is_held = (
            held_melody is not None
            and len(remaining) > 1
            and held_melody.end > top.start + ARRANGE_ONSET_EPSILON_SECONDS
            and held_melody.pitch > top.pitch
        )
        if not melody_is_held:
            melody.append(top)
            remaining = remaining[1:]
            melody_center = (
                float(top.pitch)
                if melody_center is None
                else melody_center + MELODY_EMA_WEIGHT * (top.pitch - melody_center)
            )

        if remaining:
            low = remaining[-1]
            reference = melody[-1].pitch if melody else top.pitch
            if (
                reference - low.pitch >= MELODY_BASS_MIN_GAP_SEMITONES
                and low.pitch <= BASS_MAX_PITCH
            ):
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


def fit_voice_register(voice, low: int, high: int) -> None:
    """Octave-fold a voice into a comfortable Game Boy register."""
    for note in voice:
        while note.pitch > high:
            note.pitch -= 12
        while note.pitch < low:
            note.pitch += 12


def scale_voice_velocity(voice, scale: float) -> None:
    for note in voice:
        note.velocity = max(1, min(127, round(note.velocity * scale)))


def split_harmony_voices(inner, scale=None):
    """Keep two smooth independent inner lines for expanded four-voice mode."""
    if not inner:
        return [], []

    median_velocity = statistics.median(note.velocity for note in inner)
    candidates = [
        note
        for note in inner
        if note.velocity >= median_velocity * INNER_VELOCITY_RATIO
    ]
    clusters = []
    for note in sorted(candidates, key=lambda item: (item.start, item.pitch)):
        if clusters and note.start - clusters[-1][0].start <= ARRANGE_ONSET_EPSILON_SECONDS:
            clusters[-1].append(note)
        else:
            clusters.append([note])

    low_voice = []
    high_voice = []
    for cluster in clusters:
        pitches = sorted(cluster, key=lambda note: (note.pitch, -note.velocity))
        if scale:
            in_scale = [note for note in pitches if note.pitch % 12 in scale]
            if in_scale:
                pitches = in_scale

        # Same-pitch re-strikes inside one onset window are a single harmony
        # note, not a pair — route them by unique pitch count or the pair
        # chooser has nothing to pair.
        if len({note.pitch for note in pitches}) == 1:
            note = max(pitches, key=lambda item: item.velocity)
            low_distance = abs(note.pitch - low_voice[-1].pitch) if low_voice else float("inf")
            high_distance = abs(note.pitch - high_voice[-1].pitch) if high_voice else float("inf")
            (low_voice if low_distance <= high_distance else high_voice).append(note)
            continue

        previous_low = low_voice[-1] if low_voice else None
        previous_high = high_voice[-1] if high_voice else None
        low, high = choose_smooth_harmony_pair(pitches, previous_low, previous_high)
        low_voice.append(low)
        high_voice.append(high)

    enforce_monophony(low_voice)
    enforce_monophony(high_voice)
    return low_voice, high_voice


def choose_smooth_harmony_pair(notes, previous_low=None, previous_high=None):
    """Choose two detected chord notes with minimal voice-leading motion."""
    by_pitch = {}
    for note in notes:
        existing = by_pitch.get(note.pitch)
        if existing is None or note.velocity > existing.velocity:
            by_pitch[note.pitch] = note
    unique = sorted(by_pitch.values(), key=lambda note: note.pitch)
    if len(unique) < 2:
        raise ValueError("At least two harmony notes are required.")

    if previous_low is None or previous_high is None:
        return unique[0], unique[-1]

    candidates = []
    for low_index, low in enumerate(unique[:-1]):
        for high in unique[low_index + 1:]:
            spacing = high.pitch - low.pitch
            movement = abs(low.pitch - previous_low.pitch) + abs(high.pitch - previous_high.pitch)
            leap_penalty = (
                max(0, abs(low.pitch - previous_low.pitch) - 7)
                + max(0, abs(high.pitch - previous_high.pitch) - 7)
            ) * 2
            spacing_penalty = max(0, 3 - spacing) * 4
            common_tone_bonus = (
                (3 if low.pitch in {previous_low.pitch, previous_high.pitch} else 0)
                + (3 if high.pitch in {previous_low.pitch, previous_high.pitch} else 0)
            )
            strength_bonus = (low.velocity + high.velocity) / 127.0
            score = movement + leap_penalty + spacing_penalty - common_tone_bonus - strength_bonus
            candidates.append((score, low.pitch, high.pitch, low, high))

    _, _, _, low, high = min(candidates, key=lambda candidate: candidate[:3])
    return low, high


def arpeggiate_inner_voices(inner, tempo: float, scale=None):
    """Roll sustained inner chords into a low-to-high arpeggio pattern."""
    import pretty_midi

    if not inner:
        return []

    # Weak inner notes are texture mud on a Game Boy channel: drop them.
    median_velocity = statistics.median(note.velocity for note in inner)
    inner = [
        note
        for note in inner
        if note.velocity >= median_velocity * INNER_VELOCITY_RATIO
    ]
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

    # A quarter-note pulse keeps the harmony recognizable without hammering
    # continuously underneath the melody.
    step = min(0.5, max(0.24, 60.0 / tempo))
    result = []
    for segment in segments:
        segment_notes = segment["notes"]
        start = min(note.start for note in segment_notes)
        end = segment["end"]
        pitches = sorted({note.pitch for note in segment_notes})
        if scale and len(pitches) > 2:
            in_scale = [pitch for pitch in pitches if pitch % 12 in scale]
            if len(in_scale) >= 2:
                pitches = in_scale
        if len(pitches) > ARPEGGIO_MAX_PITCHES:
            stride = max(1, len(pitches) // ARPEGGIO_MAX_PITCHES)
            pitches = pitches[::stride][:ARPEGGIO_MAX_PITCHES]

        # A single sustained pitch is a counter-line, not a chord: keep it.
        if len(pitches) < 2 or end - start < step * 1.5:
            result.extend(segment_notes)
            continue

        velocity = int(
            statistics.mean(note.velocity for note in segment_notes)
            * ARPEGGIO_VELOCITY_SCALE
        )
        velocity = max(1, min(127, velocity))
        position = start
        index = 0
        while position < end - 1e-6:
            note_end = min(position + step * ARPEGGIO_GATE_RATIO, end)
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
    parser.add_argument("--arrange", choices=("composer", "expanded", "off"), default="off")
    parser.add_argument("--separate", action="store_true")
    parser.add_argument("--bpm", type=float)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--metadata-output", type=Path)
    args = parser.parse_args()
    if args.bpm is not None and not 40 <= args.bpm <= 240:
        parser.error("--bpm must be between 40 and 240")

    try:
        report_progress(2, "Starting up")
        ffmpeg_path = find_ffmpeg()
        with tempfile.TemporaryDirectory(prefix="motif-audio-") as temp:
            work_dir = Path(temp)
            if args.url:
                report_progress(5, "Downloading audio from YouTube")
                source, title = download_audio(args.url, work_dir, ffmpeg_path)
                report_progress(20, "Audio downloaded")
            else:
                source = args.input.resolve()
                if not source.is_file():
                    raise FileNotFoundError(f"Audio file not found: {source}")
                title = source.stem

            report_progress(25, "Converting audio")
            normalized = work_dir / "normalized.wav"
            convert_to_wav(source, normalized, ffmpeg_path)
            report_progress(30, "Analyzing tempo and sections")
            detected_tempo, sections = analyze_audio_timing(normalized)
            tempo = args.bpm
            bpm_source = "manual" if tempo is not None else None
            if tempo is None and detected_tempo is not None:
                tempo = detected_tempo
                bpm_source = "detected"
            if args.separate:
                transcribe_with_stems(normalized, args.output.resolve(), work_dir, tempo)
                arrangement_value = "stems"
            else:
                transcribe(normalized, args.output.resolve(), args.mode, tempo)
                arranged = False
                if args.arrange in {"composer", "expanded"}:
                    label = (
                        "Applying expanded four-voice arrangement"
                        if args.arrange == "expanded"
                        else "Applying classic three-voice arrangement"
                    )
                    report_progress(94, label)
                    arranged = apply_composer_arrangement(
                        args.output.resolve(),
                        expanded=args.arrange == "expanded",
                        tempo_override=tempo,
                    )
                else:
                    report_progress(94, "Preserving the transcription")
                arrangement_value = args.arrange if arranged else "original"
            report_progress(99, "Finishing")
            if args.metadata_output:
                args.metadata_output.resolve().write_text(
                    json.dumps(
                        {
                            "title": title,
                            "arrangement": arrangement_value,
                            "bpm": tempo,
                            "bpm_source": bpm_source,
                            "sections": sections,
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
