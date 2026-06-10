"""Sanity checks for the Composer Mode arrangement in audio_to_midi.py."""

import pretty_midi

from audio_to_midi import arrange_for_game_boy, is_dense_polyphony


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
    assert len({note.pitch for note in ordered}) >= 3
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
    assert len(melody.notes) == 1 and melody.notes[0].pitch == 84
    print("ok: sustained melody note keeps the skyline")


if __name__ == "__main__":
    test_monophonic_input_is_untouched()
    test_dense_chords_become_three_voices()
    test_sustained_melody_keeps_skyline()
    print("all composer mode checks passed")
