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
      lookaheadTime: 0.1,
      scheduleInterval: 25,
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

    if (transformMode === 'passthrough') {
      // Direct playback mode - play MIDI as-is without transformations
      // Create a single "melody" role assignment with all original events
      const passthroughAssignment = [{
        role: 'melody' as const,
        sourceTrack: 0,
        events: events,
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

      this.synthesisEngine.setupLayers(passthroughAssignment);
      console.log('Motif: Passthrough mode - playing original MIDI patterns');
    } else {
      // Procedural mode - transform the MIDI with role mapping
      const clonedEvents = events.map(event => ({ ...event }));
      const roleAssignments = composerArrangement
        ? this.arrangeComposerTracks(clonedEvents, lightweightMode, arrangementMode)
        : this.looksLikeSoloPiano(clonedEvents)
          ? this.arrangeSoloPiano(clonedEvents, lightweightMode)
          : this.roleMapper.assignRoles(this.midiProcessor.extractFeatures(clonedEvents), clonedEvents);
      this.synthesisEngine.setupLayers(roleAssignments);
      console.log('Motif: Procedural mode - transforming MIDI with role mapping');
    }
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
    const trackLimit = lightweightMode ? 3 : roles.length;

    for (let index = 0; index < Math.min(trackIds.length, trackLimit); index++) {
      const role = roles[index];
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
      ['melody', []],
    ]);

    for (const group of this.groupByOnset(events)) {
      const ordered = [...group].sort((a, b) => a.pitch - b.pitch);
      if (ordered.length === 1) {
        const note = ordered[0];
        const role: Role = note.pitch < 48 ? 'bass' : 'melody';
        voices.get(role)!.push(note);
        continue;
      }

      voices.get('bass')!.push(ordered[0]);
      voices.get('melody')!.push(ordered[ordered.length - 1]);
      if (ordered.length > 2) {
        const innerVoices = ordered.slice(1, -1);
        const center = innerVoices.reduce((sum, note) => sum + note.pitch, 0) / innerVoices.length;
        voices.get('texture')!.push(
          ...innerVoices
            .sort((a, b) => Math.abs(a.pitch - center) - Math.abs(b.pitch - center))
            .slice(0, lightweightMode ? 1 : 2)
        );
      }
    }

    const assignments: RoleAssignment[] = [];
    for (const [role, voiceEvents] of voices) {
      if (voiceEvents.length === 0) continue;
      voiceEvents.sort((a, b) => a.time - b.time || a.pitch - b.pitch);
      this.trimVoiceOverlap(voiceEvents, role, lightweightMode);
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

  private trimVoiceOverlap(events: NoteEvent[], role: Role, lightweightMode: boolean): void {
    const groups = this.groupByOnset(events);
    const overlap = lightweightMode ? 0 : role === 'texture' ? 0.03 : 0.015;

    for (let index = 0; index < groups.length - 1; index++) {
      const nextOnset = groups[index + 1][0].time;
      for (const event of groups[index]) {
        const latestEnd = nextOnset + overlap;
        if (event.time < nextOnset && event.time + event.duration > latestEnd) {
          event.duration = Math.max(0.06, latestEnd - event.time);
        }
      }
    }
  }

  private groupByOnset(events: NoteEvent[]): NoteEvent[][] {
    const windowSeconds = 0.055;
    const sorted = [...events].sort((a, b) => a.time - b.time || a.pitch - b.pitch);
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
    sampleRate = 44100
  ): Promise<AudioBuffer> {
    let roleAssignments;

    if (transformMode === 'passthrough') {
      // Direct playback mode - play MIDI as-is without transformations
      roleAssignments = [{
        role: 'melody' as const,
        sourceTrack: 0,
        events: [...events], // Clone to avoid mutation
        chords: [],
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
      // Clone events to avoid mutating originals
      const clonedEvents = events.map(e => ({ ...e }));
      const features = this.midiProcessor.extractFeatures(clonedEvents);
      roleAssignments = this.roleMapper.assignRoles(features, clonedEvents);
    }

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
