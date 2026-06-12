import type { NoteEvent, MotifConfig, Role, RoleAssignment, TrackFeatures } from '../types';
import { MIDIProcessor } from '../midi/MIDIProcessor';
import { MIDIParser } from '../midi/MIDIParser';
import { MIDIService } from '../services/MIDIService';
import { RoleMapper } from './RoleMapper';
import { SynthesisEngine } from '../synthesis/SynthesisEngine';
import { unlockAudio } from '../utils/audioUnlock';

export interface GenerationOptions {
  lightweightMode?: boolean;
  arrangementMode?: 'original' | 'composer' | 'expanded';
}

export class MotifEngine {
  private audioContext: AudioContext | null = null;
  private config: MotifConfig;
  private midiProcessor: MIDIProcessor;
  private midiService: MIDIService;
  private roleMapper: RoleMapper;
  private synthesisEngine: SynthesisEngine | null = null;

  constructor() {
    this.config = {
      lookaheadTime: 0.18,
      scheduleInterval: 20,
      fadeTime: 0.05,
      maxOscillators: 8
    };
    
    this.midiProcessor = new MIDIProcessor();
    this.midiService = new MIDIService();
    this.roleMapper = new RoleMapper();
  }

  async generateFromMIDI(
    events: NoteEvent[],
    transformMode: 'passthrough' | 'procedural' = 'passthrough',
    options: GenerationOptions = {}
  ): Promise<void> {
    // Initialize audio context using shared unlock (iOS compatibility)
    if (!this.audioContext) {
      this.audioContext = await unlockAudio();
    }

    const lightweightMode = options.lightweightMode === true;
    const arrangementMode = options.arrangementMode;
    const composerArrangement = arrangementMode === 'composer' || arrangementMode === 'expanded';
    this.synthesisEngine = new SynthesisEngine(this.audioContext, this.config, {
      compressionEnabled: lightweightMode,
      cleanArrangement: composerArrangement,
    });

    this.synthesisEngine.setupLayers(this.buildAssignments(events, transformMode, options));
    console.log(`Motif: ${transformMode} mode ready`);
  }

  /** Build role assignments — shared by live playback and offline render. */
  private buildAssignments(
    events: NoteEvent[],
    transformMode: 'passthrough' | 'procedural',
    options: GenerationOptions = {}
  ): RoleAssignment[] {
    const lightweightMode = options.lightweightMode === true;
    const arrangementMode = options.arrangementMode;
    const composerArrangement = arrangementMode === 'composer' || arrangementMode === 'expanded';

    // Drum events (MIDI channel 9) always go to the noise channel, whatever
    // the arrangement does with the pitched material.
    const drumEvents = events.filter(event => event.channel === 9);
    const pitchedEvents = drumEvents.length > 0
      ? events.filter(event => event.channel !== 9)
      : events;

    let assignments: RoleAssignment[];
    if (transformMode === 'passthrough') {
      // Direct playback mode - play MIDI as-is without transformations
      assignments = [{
        role: 'melody' as const,
        sourceTrack: 0,
        events: pitchedEvents.map(event => ({ ...event })),
        chords: [], // No chord processing
        confidence: 1.0,
        features: {
          medianPitch: 60,
          pitchRange: 48,
          noteDensity: 1.0,
          polyphonyRatio: 0.5,
          averageDuration: 0.5,
          repetitionScore: 0.5,
          isMonophonic: false,
          hasPhraseContinuity: true,
          register: 'mid' as const
        }
      }];
    } else {
      // Procedural mode - transform the MIDI with role mapping
      const clonedEvents = pitchedEvents.map(event => ({ ...event }));
      assignments = composerArrangement
        ? this.arrangeComposerTracks(clonedEvents, lightweightMode, arrangementMode)
        : this.looksLikeSoloPiano(clonedEvents)
          ? this.arrangeSoloPiano(clonedEvents, lightweightMode)
          : this.roleMapper.assignRoles(this.midiProcessor.extractFeatures(clonedEvents), clonedEvents);
    }

    if (drumEvents.length > 0) {
      assignments.push(this.makePercussionAssignment(drumEvents.map(event => ({ ...event }))));
    }
    return assignments;
  }

  getActiveVoices(): Role[] {
    return this.synthesisEngine ? this.synthesisEngine.getActiveVoices() : [];
  }

  getVoiceEvents(): Array<{ role: Role; events: NoteEvent[] }> {
    return this.synthesisEngine ? this.synthesisEngine.getVoiceEvents() : [];
  }

  setVoiceLevel(role: Role, level: number): void {
    this.synthesisEngine?.setVoiceLevel(role, level);
  }

  setVoiceMuted(role: Role, muted: boolean): void {
    this.synthesisEngine?.setVoiceMuted(role, muted);
  }

  isVoiceMuted(role: Role): boolean {
    return this.synthesisEngine?.isVoiceMuted(role) ?? false;
  }

  getVoiceLevel(role: Role): number {
    return this.synthesisEngine?.getVoiceLevel(role) ?? 1;
  }

  setLoopRegion(region: { start: number; end: number } | null): void {
    this.synthesisEngine?.setLoopRegion(region);
  }

  private makePercussionAssignment(events: NoteEvent[]): RoleAssignment {
    events.sort((a, b) => a.time - b.time || a.pitch - b.pitch);
    return {
      role: 'percussion',
      sourceTrack: events[0].track,
      events,
      chords: [],
      confidence: 1,
      features: this.describeVoice(events),
    };
  }

  private arrangeComposerTracks(
    events: NoteEvent[],
    lightweightMode: boolean,
    arrangementMode: 'composer' | 'expanded'
  ): RoleAssignment[] {
    const trackIds = [...new Set(events.map(event => event.track))].sort((a, b) => a - b);
    const roles: Role[] = arrangementMode === 'expanded'
      ? ['melody', 'bass', 'texture', 'ostinato']
      : ['melody', 'bass', 'texture'];
    const assignments: RoleAssignment[] = [];
    // Full quality: every track plays. Only Lightweight Mode trims voices.
    const trackLimit = lightweightMode ? 3 : trackIds.length;

    for (let index = 0; index < Math.min(trackIds.length, trackLimit); index++) {
      const role = roles[Math.min(index, roles.length - 1)];
      const voiceEvents = events
        .filter(event => event.track === trackIds[index])
        .sort((a, b) => a.time - b.time || a.pitch - b.pitch);
      if (voiceEvents.length === 0) continue;

      this.cleanComposerVoice(voiceEvents, role, lightweightMode);
      assignments.push({
        role,
        sourceTrack: trackIds[index],
        events: voiceEvents,
        chords: [],
        confidence: 1,
        features: this.describeVoice(voiceEvents),
      });
    }

    return assignments;
  }

  private cleanComposerVoice(events: NoteEvent[], role: Role, lightweightMode: boolean): void {
    const velocityScale = role === 'bass'
      ? 0.78
      : role === 'texture' || role === 'ostinato'
        ? 0.6
        : 0.9;
    for (const event of events) {
      event.velocity *= velocityScale;
    }

    this.trimVoiceOverlap(events, role, true);
    for (let index = 0; index < events.length - 1; index++) {
      const event = events[index];
      const next = events[index + 1];
      const gap = next.time - event.time;
      if (gap <= 0) continue;

      const gate = lightweightMode
        ? 0.68
        : role === 'melody'
          ? 0.9
          : role === 'bass'
            ? 0.76
            : 0.58;
      event.duration = Math.min(event.duration, Math.max(0.06, gap * gate));
    }
  }

  private looksLikeSoloPiano(events: NoteEvent[]): boolean {
    const tracks = new Set(events.map(event => event.track));
    if (tracks.size !== 1 || events.length < 8) return false;

    const groups = this.groupByOnset(events);
    const polyphonicGroups = groups.filter(group => group.length > 1).length;
    return polyphonicGroups / Math.max(groups.length, 1) >= 0.12;
  }

  private arrangeSoloPiano(events: NoteEvent[], lightweightMode: boolean): RoleAssignment[] {
    const voices = new Map<Role, NoteEvent[]>([
      ['bass', []],
      ['texture', []],
      ['ostinato', []],
      ['melody', []],
    ]);
    const groups = this.groupByOnset(this.removePianoBlips(events));
    let leftCenter = 45;
    let rightCenter = 67;
    let texturePitch: number | null = null;
    let ostinatoPitch: number | null = null;

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const ordered = this.limitPianoComplexity(groups, groupIndex, lightweightMode);
      if (ordered.length === 1) {
        const note = ordered[0];
        const leftDistance = Math.abs(note.pitch - leftCenter);
        const rightDistance = Math.abs(note.pitch - rightCenter);
        const role: Role = note.pitch < 52 && leftDistance + 3 < rightDistance ? 'bass' : 'melody';
        voices.get(role)!.push(note);
        if (role === 'bass') leftCenter = this.followPitch(leftCenter, note.pitch);
        else rightCenter = this.followPitch(rightCenter, note.pitch);
        continue;
      }

      const splitPoint = this.findHandSplit(ordered, leftCenter, rightCenter);
      let leftHand = ordered.filter(note => note.pitch <= splitPoint);
      let rightHand = ordered.filter(note => note.pitch > splitPoint);
      if (leftHand.length === 0) leftHand = [rightHand.shift()!];
      if (rightHand.length === 0) rightHand = [leftHand.pop()!];

      const bass = leftHand[0];
      const melody = rightHand[rightHand.length - 1];
      voices.get('bass')!.push(bass);
      voices.get('melody')!.push(melody);
      leftCenter = this.followPitch(leftCenter, bass.pitch);
      rightCenter = this.followPitch(rightCenter, melody.pitch);

      const harmony = leftHand.slice(1).concat(rightHand.slice(0, -1));
      for (const note of harmony) {
        const textureDistance = texturePitch === null ? 0 : Math.abs(note.pitch - texturePitch);
        const ostinatoDistance = ostinatoPitch === null ? 0 : Math.abs(note.pitch - ostinatoPitch);
        const role: Role = texturePitch === null || textureDistance <= ostinatoDistance
          ? 'texture'
          : 'ostinato';
        voices.get(role)!.push(note);
        if (role === 'texture') texturePitch = note.pitch;
        else ostinatoPitch = note.pitch;
      }
    }

    const assignments: RoleAssignment[] = [];
    for (const [role, voiceEvents] of voices) {
      if (voiceEvents.length === 0) continue;
      voiceEvents.sort((a, b) => a.time - b.time || a.pitch - b.pitch);
      this.trimVoiceOverlap(voiceEvents, role, lightweightMode);
      this.cleanDensePianoVoice(voiceEvents, role);
      assignments.push({
        role,
        sourceTrack: voiceEvents[0].track,
        events: voiceEvents,
        chords: [],
        confidence: 1,
        features: this.describeVoice(voiceEvents),
      });
    }
    return assignments;
  }

  private removePianoBlips(events: NoteEvent[]): NoteEvent[] {
    const sorted = [...events].sort((a, b) => a.time - b.time || a.pitch - b.pitch);
    const medianVelocity = [...sorted]
      .map(event => event.velocity)
      .sort((a, b) => a - b)[Math.floor(sorted.length / 2)] ?? 0.5;

    return sorted.filter((event, index) => {
      if (event.duration >= 0.045) return true;

      const previous = sorted[index - 1];
      const next = sorted[index + 1];
      const closeToNeighbor = [previous, next].some(neighbor =>
        neighbor !== undefined
        && Math.abs(neighbor.time - event.time) <= 0.08
        && Math.abs(neighbor.pitch - event.pitch) <= 4
      );

      // A sub-45 ms piano detection is normally an onset fragment. Retain
      // only unusually strong events that clearly belong to a nearby run.
      return event.velocity >= medianVelocity * 1.2 && closeToNeighbor;
    });
  }

  private limitPianoComplexity(
    groups: NoteEvent[][],
    groupIndex: number,
    lightweightMode: boolean
  ): NoteEvent[] {
    const group = [...groups[groupIndex]].sort((a, b) => a.pitch - b.pitch);
    if (group.length <= 2) return group;

    // Remove muddy low-register seconds and redundant inner octave doubles.
    const cleaned: NoteEvent[] = [];
    for (const note of group) {
      const previous = cleaned[cleaned.length - 1];
      if (previous && note.pitch < 55 && note.pitch - previous.pitch <= 2) {
        if (note.velocity > previous.velocity * 1.15) cleaned[cleaned.length - 1] = note;
        continue;
      }
      const octaveDuplicate = cleaned.find(
        existing => existing.pitch % 12 === note.pitch % 12
          && note.pitch - existing.pitch === 12
          && existing !== cleaned[0]
      );
      if (octaveDuplicate && note !== group[group.length - 1]) {
        if (note.velocity > octaveDuplicate.velocity) {
          cleaned[cleaned.indexOf(octaveDuplicate)] = note;
        }
        continue;
      }
      cleaned.push(note);
    }

    const previousTime = groupIndex > 0 ? groups[groupIndex - 1][0].time : group[0].time;
    const nextTime = groupIndex + 1 < groups.length
      ? groups[groupIndex + 1][0].time
      : group[0].time + 0.5;
    const localGap = Math.min(
      groupIndex > 0 ? group[0].time - previousTime : Number.POSITIVE_INFINITY,
      nextTime - group[0].time
    );
    const localOnsets = groups.filter(
      candidate => Math.abs(candidate[0].time - group[0].time) <= 0.35
    ).length;
    const burst = localOnsets >= 8;
    const maxNotes = lightweightMode
      ? 3
      : burst && localGap < 0.12
        ? 4
        : localGap < 0.085
          ? 4
          : localGap < 0.14
            ? 5
            : 6;
    if (cleaned.length <= maxNotes) return cleaned.sort((a, b) => a.pitch - b.pitch);

    const selected = new Set<NoteEvent>([cleaned[0], cleaned[cleaned.length - 1]]);
    const candidates = cleaned.slice(1, -1).sort((a, b) => {
      const aScore = a.velocity + Math.min(a.duration, 0.5) * 30;
      const bScore = b.velocity + Math.min(b.duration, 0.5) * 30;
      return bScore - aScore;
    });
    for (const note of candidates) {
      if (selected.size >= maxNotes) break;
      const clashes = [...selected].some(existing => Math.abs(existing.pitch - note.pitch) <= 1);
      if (!clashes) selected.add(note);
    }
    return [...selected].sort((a, b) => a.pitch - b.pitch);
  }

  private findHandSplit(notes: NoteEvent[], leftCenter: number, rightCenter: number): number {
    let bestIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let index = 0; index < notes.length - 1; index++) {
      const left = notes.slice(0, index + 1);
      const right = notes.slice(index + 1);
      const leftAverage = left.reduce((sum, note) => sum + note.pitch, 0) / left.length;
      const rightAverage = right.reduce((sum, note) => sum + note.pitch, 0) / right.length;
      const crossingPenalty = Math.max(0, 5 - (right[0].pitch - left[left.length - 1].pitch)) * 2;
      const score = Math.abs(leftAverage - leftCenter)
        + Math.abs(rightAverage - rightCenter)
        + crossingPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    return (notes[bestIndex].pitch + notes[bestIndex + 1].pitch) / 2;
  }

  private followPitch(current: number, next: number): number {
    return current + (next - current) * 0.28;
  }

  private cleanDensePianoVoice(events: NoteEvent[], role: Role): void {
    if (events.length < 3) return;

    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      const nearby = events.filter(
        candidate => Math.abs(candidate.time - event.time) <= 0.35
      ).length;
      if (nearby < 6) continue;

      const next = events[index + 1];
      const gap = next ? next.time - event.time : Number.POSITIVE_INFINITY;
      if (role === 'texture' || role === 'ostinato') {
        // Staggered chord fragments can overlap into a large wash even when
        // each individual onset is modest. Gate and duck only these inner
        // voices during bursts; the outer melody and bass remain intact.
        if (gap > 0.015 && gap < 0.18) {
          event.duration = Math.min(event.duration, Math.max(0.035, gap * 0.62));
        }
        event.velocity *= nearby >= 10 ? 0.68 : 0.78;
      } else if (role === 'bass' && gap > 0.015 && gap < 0.1) {
        event.duration = Math.min(event.duration, Math.max(0.04, gap * 0.85));
      }
    }
  }

  private trimVoiceOverlap(events: NoteEvent[], role: Role, lightweightMode: boolean): void {
    const groups = this.groupByOnset(events);

    for (let index = 0; index < groups.length - 1; index++) {
      const nextOnset = groups[index + 1][0].time;
      for (const event of groups[index]) {
        const gap = nextOnset - event.time;
        const nextGroup = groups[index + 1];
        const nearestNextPitch = Math.min(
          ...nextGroup.map(next => Math.abs(next.pitch - event.pitch))
        );
        const phraseBoundary = gap >= 0.16 && nearestNextPitch >= 5;
        const strongEnding = event.duration >= gap * 1.15 && event.velocity >= 0.55;
        const overlap = lightweightMode || gap < 0.09
          ? 0
          : phraseBoundary && strongEnding && role === 'melody'
            ? Math.min(0.14, gap * 0.5)
            : phraseBoundary && strongEnding && role === 'bass'
              ? Math.min(0.08, gap * 0.3)
          : role === 'texture' || role === 'ostinato'
            ? 0.02
            : 0.012;
        const latestEnd = nextOnset + overlap;
        if (event.time < nextOnset && event.time + event.duration > latestEnd) {
          const minimumDuration = Math.max(0.025, Math.min(0.06, gap * 0.75));
          event.duration = Math.max(minimumDuration, latestEnd - event.time);
        }
      }
    }
  }

  private groupByOnset(events: NoteEvent[]): NoteEvent[][] {
    const sorted = [...events].sort((a, b) => a.time - b.time || a.pitch - b.pitch);
    const windowSeconds = this.getOnsetWindow(sorted);
    const groups: NoteEvent[][] = [];

    for (const event of sorted) {
      const current = groups[groups.length - 1];
      if (current && Math.abs(event.time - current[0].time) <= windowSeconds) {
        current.push(event);
      } else {
        groups.push([event]);
      }
    }
    return groups;
  }

  private getOnsetWindow(events: NoteEvent[]): number {
    const distinctOnsets: number[] = [];
    for (const event of events) {
      const previous = distinctOnsets[distinctOnsets.length - 1];
      if (previous === undefined || event.time - previous > 0.008) {
        distinctOnsets.push(event.time);
      }
    }

    const gaps = distinctOnsets
      .slice(1)
      .map((time, index) => time - distinctOnsets[index])
      .filter(gap => gap > 0.012 && gap < 0.5)
      .sort((a, b) => a - b);
    if (gaps.length === 0) return 0.04;

    const medianGap = gaps[Math.floor(gaps.length / 2)];
    if (medianGap < 0.075) return 0.022;
    if (medianGap < 0.12) return 0.03;
    return 0.04;
  }

  private describeVoice(events: NoteEvent[]): TrackFeatures {
    const pitches = events.map(event => event.pitch).sort((a, b) => a - b);
    const medianPitch = pitches[Math.floor(pitches.length / 2)];
    const totalDuration = Math.max(...events.map(event => event.time + event.duration));
    return {
      medianPitch,
      pitchRange: pitches[pitches.length - 1] - pitches[0],
      noteDensity: events.length / Math.max(totalDuration, 1),
      polyphonyRatio: 0,
      averageDuration: events.reduce((sum, event) => sum + event.duration, 0) / events.length,
      repetitionScore: 0,
      isMonophonic: true,
      hasPhraseContinuity: true,
      register: medianPitch < 48 ? 'low' : medianPitch < 72 ? 'mid' : 'high',
    };
  }

  async generateFromSong(songName: string): Promise<void> {
    let events: NoteEvent[];
    
    // Try to find real MIDI first
    try {
      console.log(`Searching for MIDI: ${songName}`);
      const searchResults = await this.midiService.search(songName);
      
      if (searchResults.length > 0) {
        // Try to fetch the best result
        const bestResult = searchResults[0];
        console.log(`Attempting to fetch: ${bestResult.title} (${bestResult.confidence})`);
        
        const midiBuffer = await this.midiService.fetchMIDI(bestResult.midiUrl);
        
        if (midiBuffer) {
          // Parse real MIDI
          events = MIDIParser.parseMIDI(midiBuffer);
          console.log(`Successfully parsed MIDI with ${events.length} events`);
        } else {
          throw new Error('Failed to fetch MIDI');
        }
      } else {
        throw new Error('No MIDI results found');
      }
    } catch (error) {
      console.warn(`MIDI search/fetch failed: ${error}. Falling back to synthetic.`);
      events = this.generateSyntheticMIDI(songName);
    }

    // Process events into structure
    const features = this.midiProcessor.extractFeatures(events);
    const roleAssignments = this.roleMapper.assignRoles(features, events);

    // Initialize audio context using shared unlock (iOS compatibility)
    if (!this.audioContext) {
      this.audioContext = await unlockAudio();
    }

    this.synthesisEngine = new SynthesisEngine(this.audioContext, this.config);
    this.synthesisEngine.setupLayers(roleAssignments);
  }

  async play(): Promise<void> {
    if (!this.audioContext || !this.synthesisEngine) {
      throw new Error('No audio generated yet');
    }

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this.synthesisEngine.start();
  }

  stop(): void {
    if (this.synthesisEngine) {
      this.synthesisEngine.stop();
    }
  }

  setVolume(volume: number): void {
    if (this.synthesisEngine) {
      this.synthesisEngine.setVolume(volume);
    }
  }

  /**
   * Connect an additional output tap node to the synthesis output.
   * Useful for recording/export without changing the audible output.
   */
  connectOutput(node: AudioNode): void {
    if (this.synthesisEngine) {
      this.synthesisEngine.connectOutput(node);
    }
  }

  /**
   * Disconnect a previously connected output tap node.
   */
  disconnectOutput(node: AudioNode): void {
    if (this.synthesisEngine) {
      this.synthesisEngine.disconnectOutput(node);
    }
  }

  seek(progress: number): void {
    if (this.synthesisEngine) {
      this.synthesisEngine.seek(progress);
    }
  }

  getProgress(): number {
    if (this.synthesisEngine) {
      return this.synthesisEngine.getProgress();
    }
    return 0;
  }

  getCurrentTime(): number {
    if (this.synthesisEngine) {
      return this.synthesisEngine.getCurrentTime();
    }
    return 0;
  }

  getDuration(): number {
    if (this.synthesisEngine) {
      return this.synthesisEngine.getDuration();
    }
    return 0;
  }

  /**
   * Render audio offline (faster than real-time) to an AudioBuffer.
   * This does not require play() - it pre-schedules all events and renders in one go.
   */
  async renderOffline(
    events: NoteEvent[],
    transformMode: 'passthrough' | 'procedural' = 'passthrough',
    sampleRate = 44100,
    options: GenerationOptions = {}
  ): Promise<AudioBuffer> {
    // Same assignment pipeline as live playback, so the render matches
    // what the user hears (arrangement modes, drums, voice roles).
    const roleAssignments = this.buildAssignments(events, transformMode, options);
    console.log(`Motif: Offline rendering in ${transformMode} mode`);
    return SynthesisEngine.renderOffline(roleAssignments, this.config, sampleRate);
  }

  private generateSyntheticMIDI(songName: string): NoteEvent[] {
    // Generate procedural MIDI based on song name hash
    const hash = this.simpleHash(songName);
    const events: NoteEvent[] = [];
    
    // Create a simple 4/4 pattern with bass, harmony, and texture
    const duration = 32; // 32 seconds
    const beatsPerSecond = (120 + (hash % 60)) / 60; // Tempo 120-180 BPM
    
    // Bass pattern (track 0)
    for (let beat = 0; beat < duration * beatsPerSecond; beat += 1) {
      if (beat % 4 === 0) { // On beat
        events.push({
          time: beat / beatsPerSecond,
          duration: 0.5,
          pitch: 36 + (hash % 12), // C2 + random root
          velocity: 0.7 + (hash % 3) * 0.1,
          track: 0
        });
      }
    }
    
    // Harmonic drone (track 1)
    events.push({
      time: 0,
      duration: duration,
      pitch: 48 + ((hash * 3) % 12), // C3 + harmonic interval
      velocity: 0.3,
      track: 1
    });
    
    // Textural elements (track 2)
    for (let i = 0; i < 20; i++) {
      events.push({
        time: (hash * i) % duration,
        duration: 0.2 + ((hash * i) % 10) * 0.1,
        pitch: 60 + ((hash * i) % 24), // C4 + 2 octaves
        velocity: 0.2 + ((hash * i) % 5) * 0.1,
        track: 2
      });
    }
    
    return events.sort((a, b) => a.time - b.time);
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }
}
