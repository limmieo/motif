"""Sanity checks for the Composer Mode arrangement in audio_to_midi.py."""

import pretty_midi

from audio_to_midi import (
    arrange_for_game_boy,
    choose_smooth_harmony_pair,
    is_dense_polyphony,
    quantize_near_grid,
)


def make_note(pitch, start, end, velocity=80):
    return pretty_midi.Note(velocity=velocity, pitch=pitch, start=start, end=end)


def make_midi(notes):
    midi = pretty_midi.PrettyMIDI()
    instrument = pretty_midi.Instrument(program=0)
    instrument.notes = notes
    midi.instruments.append(instrument)
    return midi


def test_monophonic_input_is_untouched():
    notes = [make_note(60 + i % 5, i * 0.5, i * 0.5 + 0.4) for i in range(20)]
    midi = make_midi(notes)
    assert not arrange_for_game_boy(midi)
    assert len(midi.instruments) == 1
    print("ok: monophonic input left alone")


def test_dense_chords_become_three_voices():
    notes = []
    # Eight bars of dense piano: melody on top, bass low, fat chord inside.
    for bar in range(8):
        t = bar * 1.0
        notes.append(make_note(76 + (bar % 3), t, t + 0.9, velocity=95))  # melody
        notes.append(make_note(40, t, t + 0.9, velocity=70))              # bass
        for chord_pitch in (52, 55, 59, 64, 67):                          # inner chord
            notes.append(make_note(chord_pitch, t, t + 0.9, velocity=60))
    midi = make_midi(notes)

    assert is_dense_polyphony(midi.instruments[0].notes)
    assert arrange_for_game_boy(midi)

    names = [instrument.name for instrument in midi.instruments]
    assert names == ["Melody", "Bass", "Arpeggio"], names

    melody, bass, arpeggio = midi.instruments
    # Melody keeps the skyline pitches.
    assert all(note.pitch >= 76 for note in melody.notes)
    # Bass keeps the floor.
    assert all(note.pitch == 40 for note in bass.notes)
    # Melody and bass are monophonic.
    for voice in (melody.notes, bass.notes):
        ordered = sorted(voice, key=lambda note: note.start)
        for current, upcoming in zip(ordered, ordered[1:]):
            assert current.end <= upcoming.start + 1e-9
    # Inner chords were rolled into a single-voice arpeggio: no two arp
    # notes sound at once, and pitches cycle through the chord tones.
    ordered = sorted(arpeggio.notes, key=lambda note: note.start)
    for current, upcoming in zip(ordered, ordered[1:]):
        assert current.end <= upcoming.start + 1e-9
    assert len({note.pitch for note in ordered}) == 2
    assert {note.pitch for note in ordered} <= {52, 55, 59, 64, 67}
    print(
        f"ok: dense chords split into {len(melody.notes)} melody, "
        f"{len(bass.notes)} bass, {len(arpeggio.notes)} arpeggio notes"
    )


def test_sustained_melody_keeps_skyline():
    notes = [make_note(84, 0.0, 4.0, velocity=100)]  # long high melody note
    for beat in range(8):
        t = beat * 0.5
        for chord_pitch in (48, 60, 64, 67):
            notes.append(make_note(chord_pitch, t, t + 0.45, velocity=60))
    midi = make_midi(notes)
    assert arrange_for_game_boy(midi)

    melody = next(i for i in midi.instruments if i.name == "Melody")
    # The chord stabs under the sustained note must not steal the melody.
    assert len(melody.notes) == 1 and melody.notes[0].pitch == 72
    print("ok: sustained melody keeps the skyline in a comfortable octave")


def test_sequential_arpeggio_keeps_full_contour():
    notes = []
    expected_first_bar = [79, 67, 71, 74]
    for bar in range(8):
        t = bar * 1.0
        # The peak overlaps the lower sequential notes, like a piano or vocal
        # arpeggio with sustain. Those lower steps must remain audible.
        notes.append(make_note(79, t, t + 0.9, velocity=95))
        notes.append(make_note(40, t, t + 0.9, velocity=70))
        notes.append(make_note(55, t, t + 0.9, velocity=60))
        notes.append(make_note(67, t + 0.2, t + 0.38, velocity=88))
        notes.append(make_note(71, t + 0.4, t + 0.58, velocity=88))
        notes.append(make_note(74, t + 0.6, t + 0.78, velocity=88))

    midi = make_midi(notes)
    assert arrange_for_game_boy(midi)

    melody = next(i for i in midi.instruments if i.name == "Melody")
    first_bar = [
        note.pitch
        for note in sorted(melody.notes, key=lambda note: note.start)
        if note.start < 0.8
    ]
    assert first_bar == expected_first_bar, first_bar
    print("ok: sequential arpeggio keeps its full up-and-down contour")


def test_harmonic_blips_do_not_steal_melody():
    notes = []
    for bar in range(8):
        t = bar * 1.0
        notes.append(make_note(72 + (bar % 4), t, t + 0.9, velocity=95))  # melody
        notes.append(make_note(40, t, t + 0.9, velocity=70))              # bass
        for chord_pitch in (52, 55, 59, 64):                              # chord
            notes.append(make_note(chord_pitch, t, t + 0.9, velocity=60))
        # Full-mix transcription artifacts: short, weak overtones far above.
        notes.append(make_note(96 + (bar % 3), t + 0.3, t + 0.42, velocity=40))
        notes.append(make_note(91, t + 0.6, t + 0.7, velocity=35))
    midi = make_midi(notes)
    assert arrange_for_game_boy(midi)

    melody = next(i for i in midi.instruments if i.name == "Melody")
    melody_pitches = sorted({note.pitch for note in melody.notes})
    assert all(pitch <= 80 for pitch in melody_pitches), melody_pitches
    # The blips should be discarded entirely, not relocated into another voice.
    for instrument in midi.instruments:
        loud_highs = [n.pitch for n in instrument.notes if n.pitch >= 85]
        assert not loud_highs, (instrument.name, loud_highs)
    print("ok: harmonic blips discarded, melody keeps the real tune")


def test_stuck_high_tone_is_removed():
    notes = [make_note(96, 0.0, 8.0, velocity=55)]
    for bar in range(8):
        t = bar * 1.0
        notes.append(make_note(72 + (bar % 4), t, t + 0.8, velocity=90))
        notes.append(make_note(40, t, t + 0.8, velocity=70))
        for chord_pitch in (52, 55, 59, 64):
            notes.append(make_note(chord_pitch, t, t + 0.8, velocity=60))
    midi = make_midi(notes)
    assert arrange_for_game_boy(midi)

    all_notes = [note for instrument in midi.instruments for note in instrument.notes]
    assert all(note.pitch <= 81 for note in all_notes)
    assert not any(note.duration > 2.0 and note.pitch >= 80 for note in all_notes)
    print("ok: stuck high tone removed")


def test_output_uses_comfortable_registers():
    notes = []
    for bar in range(8):
        t = bar * 1.0
        notes.append(make_note(91 + (bar % 2), t, t + 0.8, velocity=95))
        notes.append(make_note(28, t, t + 0.8, velocity=70))
        for chord_pitch in (76, 79, 83):
            notes.append(make_note(chord_pitch, t, t + 0.8, velocity=60))
    midi = make_midi(notes)
    assert arrange_for_game_boy(midi)

    ranges = {
        instrument.name: (min(note.pitch for note in instrument.notes), max(note.pitch for note in instrument.notes))
        for instrument in midi.instruments
    }
    assert 55 <= ranges["Melody"][0] <= ranges["Melody"][1] <= 81
    assert 31 <= ranges["Bass"][0] <= ranges["Bass"][1] <= 52
    assert 48 <= ranges["Arpeggio"][0] <= ranges["Arpeggio"][1] <= 72
    print("ok: voices octave-folded into comfortable registers")


def test_expanded_mode_keeps_two_harmony_lines():
    notes = []
    for bar in range(8):
        t = bar * 1.0
        notes.append(make_note(79, t, t + 0.9, velocity=95))
        notes.append(make_note(40, t, t + 0.9, velocity=70))
        for chord_pitch in (52, 55, 59, 64):
            notes.append(make_note(chord_pitch, t, t + 0.9, velocity=65))
    midi = make_midi(notes)
    assert arrange_for_game_boy(midi, expanded=True)

    names = [instrument.name for instrument in midi.instruments]
    assert names == ["Melody", "Bass", "Harmony Low", "Harmony High"], names
    harmony_low = midi.instruments[2].notes
    harmony_high = midi.instruments[3].notes
    assert len(harmony_low) == 8
    assert len(harmony_high) == 8
    assert all(low.pitch < high.pitch for low, high in zip(harmony_low, harmony_high))
    print("ok: expanded mode keeps two independent harmony lines")


def test_harmony_voice_leading_prefers_common_tones():
    first = [
        make_note(60, 0.0, 0.8, velocity=70),
        make_note(64, 0.0, 0.8, velocity=70),
        make_note(67, 0.0, 0.8, velocity=70),
    ]
    low, high = choose_smooth_harmony_pair(first)
    assert (low.pitch, high.pitch) == (60, 67)

    inversion = [
        make_note(64, 1.0, 1.8, velocity=70),
        make_note(67, 1.0, 1.8, velocity=70),
        make_note(72, 1.0, 1.8, velocity=70),
    ]
    next_low, next_high = choose_smooth_harmony_pair(inversion, low, high)
    assert (next_low.pitch, next_high.pitch) == (64, 67)
    assert abs(next_low.pitch - low.pitch) + abs(next_high.pitch - high.pitch) == 4
    print("ok: harmony follows common tones instead of jumping with chord inversions")


def test_known_bpm_gently_aligns_note_timing():
    notes = [
        make_note(60, 0.02, 0.48),
        make_note(62, 0.52, 0.98),
        make_note(64, 1.03, 1.49),
    ]
    midi = make_midi(notes)
    quantize_near_grid(midi, notes, 120)
    starts = [round(note.start, 3) for note in notes]
    assert starts == [0.02, 0.52, 1.02], starts
    assert all(abs(original - snapped) <= 0.045 for original, snapped in zip((0.02, 0.52, 1.03), starts))
    print("ok: known BPM gently aligns timing without large shifts")


def test_same_pitch_restrike_does_not_crash_expanded_mode():
    from audio_to_midi import split_harmony_voices

    inner = [
        make_note(60, 0.0, 0.4),
        make_note(64, 0.0, 0.4),
        # Re-struck pitch inside one onset window: one harmony note, not two.
        make_note(62, 0.5, 0.9),
        make_note(62, 0.53, 0.9),
    ]
    low_voice, high_voice = split_harmony_voices(inner)
    assert low_voice and high_voice
    assert 62 in {note.pitch for note in low_voice + high_voice}
    print("ok: same-pitch re-strike handled in expanded mode")


if __name__ == "__main__":
    test_monophonic_input_is_untouched()
    test_dense_chords_become_three_voices()
    test_sustained_melody_keeps_skyline()
    test_sequential_arpeggio_keeps_full_contour()
    test_harmonic_blips_do_not_steal_melody()
    test_stuck_high_tone_is_removed()
    test_output_uses_comfortable_registers()
    test_expanded_mode_keeps_two_harmony_lines()
    test_harmony_voice_leading_prefers_common_tones()
    test_known_bpm_gently_aligns_note_timing()
    test_same_pitch_restrike_does_not_crash_expanded_mode()
    print("all composer mode checks passed")
