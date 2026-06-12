import type { NoteEvent } from '../types';

export type StylePreset = 'normal' | 'spooky' | 'dance';

// Krumhansl-Schmuckler key profiles (same ones the Python cleanup uses).
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** How much a preset stretches the timeline (>1 slower, <1 faster). */
export function styleTimeScale(preset: StylePreset): number {
  if (preset === 'spooky') return 1.12;
  if (preset === 'dance') return 0.85;
  return 1;
}

/**
 * Rewrite the note events in a chosen style. Returns fresh copies; the
 * original transcription is never mutated, so styles can be switched freely.
 */
export function applyStyle(events: NoteEvent[], preset: StylePreset, bpm?: number): NoteEvent[] {
  const scale = styleTimeScale(preset);
  const styled = events.map(event => ({
    ...event,
    time: event.time * scale,
    duration: event.duration * scale,
  }));
  if (preset === 'spooky') minorize(styled);
  if (preset === 'dance') addDanceDrums(styled, bpm, scale);
  return styled;
}

function inferKey(events: NoteEvent[]): { tonic: number; mode: 'major' | 'minor' } | null {
  const histogram = new Array(12).fill(0) as number[];
  for (const event of events) {
    if (event.channel === 9) continue;
    histogram[event.pitch % 12] += Math.max(0.05, event.duration) * Math.max(0.05, event.velocity);
  }
  if (histogram.every(value => value === 0)) return null;

  let best: { score: number; tonic: number; mode: 'major' | 'minor' } | null = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, profile] of [['major', MAJOR_PROFILE], ['minor', MINOR_PROFILE]] as const) {
      const rotated = profile.map((_, pitchClass) => profile[(pitchClass - tonic + 12) % 12]);
      const score = cosineSimilarity(histogram, rotated);
      if (!best || score > best.score) best = { score, tonic, mode };
    }
  }
  return best && { tonic: best.tonic, mode: best.mode };
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

/** Flatten scale degrees 3, 6, and 7 of a major key: instant natural minor. */
function minorize(events: NoteEvent[]): void {
  const key = inferKey(events);
  if (!key || key.mode === 'minor') return; // already dark enough
  const flattened = new Set([
    (key.tonic + 4) % 12, // major third
    (key.tonic + 9) % 12, // major sixth
    (key.tonic + 11) % 12, // major seventh
  ]);
  for (const event of events) {
    if (event.channel === 9) continue;
    if (flattened.has(event.pitch % 12)) event.pitch -= 1;
  }
}

/** Four-on-the-floor noise drums, unless the song already has a drum track. */
function addDanceDrums(events: NoteEvent[], bpm: number | undefined, timeScale: number): void {
  if (events.length === 0) return;
  if (events.some(event => event.channel === 9)) return;

  const beatSeconds = (60 / (bpm && bpm >= 40 && bpm <= 240 ? bpm : 120)) * timeScale;
  const start = Math.min(...events.map(event => event.time));
  const end = Math.max(...events.map(event => event.time + event.duration));
  const drumTrack = Math.max(...events.map(event => event.track)) + 1;

  let beat = 0;
  for (let time = start; time < end; time += beatSeconds) {
    // Kick on every beat.
    events.push(makeDrum(time, 36, 0.85, drumTrack));
    // Snare on 2 and 4.
    if (beat % 4 === 1 || beat % 4 === 3) {
      events.push(makeDrum(time, 38, 0.7, drumTrack));
    }
    // Hat on the offbeat.
    events.push(makeDrum(time + beatSeconds / 2, 42, 0.45, drumTrack));
    beat++;
  }
  events.sort((a, b) => a.time - b.time || a.pitch - b.pitch);
}

function makeDrum(time: number, pitch: number, velocity: number, track: number): NoteEvent {
  return { time, duration: 0.06, pitch, velocity, track, channel: 9 };
}
