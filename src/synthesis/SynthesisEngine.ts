import type { RoleAssignment, MotifConfig, SynthLayer, Role, NoteEvent } from '../types';

interface SynthesisOptions {
  compressionEnabled?: boolean;
  cleanArrangement?: boolean;
}

export class SynthesisEngine {
  private audioContext: AudioContext;
  private config: MotifConfig;
  private masterGain: GainNode;
  private compressor: DynamicsCompressorNode;
  private layers: Map<Role, SynthLayer> = new Map();
  private roleAssignments: Map<Role, RoleAssignment> = new Map();
  private isPlaying = false;
  private schedulerIntervalId: number | null = null;
  private startTime = 0;
  private nextEventIndex = new Map<Role, number>();
  private cleanArrangement: boolean;
  private noiseBuffer: AudioBuffer | null = null;
  private pulseWaves = new Map<number, PeriodicWave>();
  private voiceLevels = new Map<Role, number>();
  private mutedVoices = new Set<Role>();
  private loopRegion: { start: number; end: number } | null = null;

  constructor(audioContext: AudioContext, config: MotifConfig, options: SynthesisOptions = {}) {
    this.audioContext = audioContext;
    this.config = config;
    this.cleanArrangement = options.cleanArrangement === true;
    this.masterGain = audioContext.createGain();
    this.compressor = audioContext.createDynamicsCompressor();
    const compressionEnabled = options.compressionEnabled === true;
    this.compressor.threshold.value = compressionEnabled ? -18 : 0;
    this.compressor.knee.value = compressionEnabled ? 12 : 0;
    this.compressor.ratio.value = compressionEnabled ? 4 : 1;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.18;
    this.masterGain.connect(this.compressor);
    this.compressor.connect(audioContext.destination);
    this.masterGain.gain.value = 0.3;
  }

  /**
   * Connect the master output to an additional node (e.g. recorder tap).
   * This does not change the default destination routing.
   */
  connectOutput(node: AudioNode): void {
    this.masterGain.connect(node);
  }

  /**
   * Disconnect a previously connected output tap.
   */
  disconnectOutput(node: AudioNode): void {
    try {
      this.masterGain.disconnect(node);
    } catch {
      // ignore (node might not be connected)
    }
  }

  /** Voices currently set up, in a stable order for UI display. */
  getActiveVoices(): Role[] {
    return Array.from(this.layers.keys());
  }

  /** Per-voice note events (normalized timeline) for visualization. */
  getVoiceEvents(): Array<{ role: Role; events: NoteEvent[] }> {
    return Array.from(this.roleAssignments.entries()).map(([role, assignment]) => ({
      role,
      events: assignment.events,
    }));
  }

  /** Set a per-voice volume multiplier (0..1). */
  setVoiceLevel(role: Role, level: number): void {
    this.voiceLevels.set(role, Math.max(0, Math.min(1, level)));
    this.applyVoiceGain(role);
  }

  setVoiceMuted(role: Role, muted: boolean): void {
    if (muted) this.mutedVoices.add(role);
    else this.mutedVoices.delete(role);
    this.applyVoiceGain(role);
  }

  isVoiceMuted(role: Role): boolean {
    return this.mutedVoices.has(role);
  }

  getVoiceLevel(role: Role): number {
    return this.voiceLevels.get(role) ?? 1;
  }

  private effectiveLayerGain(role: Role): number {
    if (this.mutedVoices.has(role)) return 0;
    return this.getLayerGainForRole(role) * (this.voiceLevels.get(role) ?? 1);
  }

  private applyVoiceGain(role: Role): void {
    const layer = this.layers.get(role);
    if (!layer) return;
    layer.gainNode.gain.cancelScheduledValues(this.audioContext.currentTime);
    layer.gainNode.gain.setValueAtTime(this.effectiveLayerGain(role), this.audioContext.currentTime);
  }

  /** Loop a time region (seconds) instead of the whole song. Null = whole song. */
  setLoopRegion(region: { start: number; end: number } | null): void {
    this.loopRegion = region && region.end - region.start > 1 ? region : null;
    if (this.isPlaying && this.loopRegion) {
      this.seek(this.loopRegion.start / Math.max(this.getDuration(), 0.001));
    }
  }

  /** Band-limited pulse wave for classic 12.5% / 25% duty chip leads. */
  private getPulseWave(duty: number): PeriodicWave {
    let wave = this.pulseWaves.get(duty);
    if (!wave) {
      wave = SynthesisEngine.createPulseWave(this.audioContext, duty);
      this.pulseWaves.set(duty, wave);
    }
    return wave;
  }

  private static createPulseWave(ctx: BaseAudioContext, duty: number): PeriodicWave {
    const harmonics = 32;
    const real = new Float32Array(harmonics);
    const imag = new Float32Array(harmonics);
    for (let n = 1; n < harmonics; n++) {
      imag[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
    }
    return ctx.createPeriodicWave(real, imag);
  }

  setupLayers(assignments: RoleAssignment[]): void {
    // Clean up existing layers
    this.cleanupLayers();

    // Find the earliest event time across all assignments
    let earliestTime = Infinity;
    for (const assignment of assignments) {
      if (assignment.events.length > 0) {
        earliestTime = Math.min(earliestTime, assignment.events[0].time);
      }
      if (assignment.chords.length > 0) {
        earliestTime = Math.min(earliestTime, assignment.chords[0].time);
      }
    }

    // If we found events, normalize times to start at 0
    if (earliestTime !== Infinity && earliestTime > 0) {
      console.log('Normalizing event times, earliest was:', earliestTime);
      for (const assignment of assignments) {
        // Normalize note events
        for (const event of assignment.events) {
          event.time -= earliestTime;
        }
        // Normalize chord events
        for (const chord of assignment.chords) {
          chord.time -= earliestTime;
        }
      }
    }

    // Store role assignments and create layers. Multiple tracks can share a
    // role (e.g. several texture tracks): merge their events instead of
    // letting the last one overwrite the rest.
    for (const assignment of assignments) {
      const existing = this.roleAssignments.get(assignment.role);
      if (existing) {
        existing.events = existing.events
          .concat(assignment.events)
          .sort((a, b) => a.time - b.time || a.pitch - b.pitch);
        existing.chords = existing.chords
          .concat(assignment.chords)
          .sort((a, b) => a.time - b.time);
        continue;
      }
      const layer = this.createSynthLayer(assignment.role);
      this.layers.set(assignment.role, layer);
      this.roleAssignments.set(assignment.role, assignment);
      this.nextEventIndex.set(assignment.role, 0);
    }

    console.log('Setup layers for roles:', Array.from(this.roleAssignments.keys()));
  }

  start(): void {
    if (this.isPlaying) return;

    this.isPlaying = true;
    this.startTime = this.audioContext.currentTime;

    // Reset event indices
    for (const role of this.roleAssignments.keys()) {
      this.nextEventIndex.set(role, 0);
    }

    // Restore layer gains (they may have been faded to 0 on stop)
    for (const [role, layer] of this.layers) {
      layer.gainNode.gain.cancelScheduledValues(this.audioContext.currentTime);
      this.restoreLayerGain(layer.gainNode, role);
    }

    // Start scheduler to play actual MIDI events
    this.schedulerIntervalId = window.setInterval(() => {
      this.scheduleEvents();
    }, this.config.scheduleInterval);

    console.log('Started synthesis with', this.roleAssignments.size, 'roles');
  }

  stop(): void {
    if (!this.isPlaying) return;

    this.isPlaying = false;

    if (this.schedulerIntervalId) {
      clearInterval(this.schedulerIntervalId);
      this.schedulerIntervalId = null;
    }

    // Fade out all layers
    this.fadeOutAllLayers();
  }

  setVolume(volume: number): void {
    this.masterGain.gain.value = Math.max(0, Math.min(1, volume));
  }

  seek(progress: number): void {
    if (!this.isPlaying) return;

    // Calculate the new start time based on progress
    const duration = this.getDuration();
    const targetTime = progress * duration;

    // Adjust startTime to effectively seek to the target position
    this.startTime = this.audioContext.currentTime - targetTime;

    // Reset event indices to the appropriate position
    for (const [role, assignment] of this.roleAssignments) {
      const events = assignment.events;
      if (events.length > 0) {
        // Find the first event after the target time
        let index = 0;
        while (index < events.length && events[index].time < targetTime) {
          index++;
        }
        this.nextEventIndex.set(role, index);
      }
    }
  }

  getProgress(): number {
    if (!this.isPlaying) return 0;

    const duration = this.getDuration();
    if (duration === 0) return 0;

    const currentTime = this.audioContext.currentTime - this.startTime;
    return Math.max(0, Math.min(1, currentTime / duration));
  }

  getCurrentTime(): number {
    if (!this.isPlaying) return 0;
    return Math.max(0, this.audioContext.currentTime - this.startTime);
  }

  getDuration(): number {
    let maxDuration = 0;

    for (const assignment of this.roleAssignments.values()) {
      if (assignment.events.length > 0) {
        const lastEvent = assignment.events[assignment.events.length - 1];
        const eventEnd = lastEvent.time + lastEvent.duration;
        maxDuration = Math.max(maxDuration, eventEnd);
      }

      if (assignment.chords.length > 0) {
        const lastChord = assignment.chords[assignment.chords.length - 1];
        const chordEnd = lastChord.time + lastChord.duration;
        maxDuration = Math.max(maxDuration, chordEnd);
      }
    }

    return maxDuration;
  }

  private createSynthLayer(role: Role): SynthLayer {
    const gainNode = this.audioContext.createGain();
    const filterNode = this.audioContext.createBiquadFilter();

    filterNode.connect(gainNode);
    gainNode.connect(this.masterGain);

    // Configure based on role
    this.configureLayerForRole(gainNode, filterNode, role);

    const extraNodes: AudioNode[] = [];
    if (role === 'melody') {
      // GB composers faked echo by repeating the lead quietly on the free
      // pulse channel; a low-mix slapback delay gets the same feel.
      const delay = this.audioContext.createDelay(1);
      delay.delayTime.value = 0.165;
      const feedback = this.audioContext.createGain();
      feedback.gain.value = 0.18;
      const wet = this.audioContext.createGain();
      wet.gain.value = 0.25;
      gainNode.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(wet);
      wet.connect(this.masterGain);
      extraNodes.push(delay, feedback, wet);
    }

    return {
      role,
      oscillators: [],
      gainNode,
      filterNode,
      extraNodes
    };
  }

  private getLayerGainForRole(role: Role): number {
    switch (role) {
      case 'bass': return this.cleanArrangement ? 0.27 : 0.4;
      case 'drone': return 0.2;
      // Square waves carry far more harmonic energy than triangles, so the
      // pulse-style layers sit lower to keep the mix balanced.
      case 'ostinato': return this.cleanArrangement ? 0.045 : 0.14;
      case 'texture': return this.cleanArrangement ? 0.032 : 0.045;
      case 'accents': return 0.5;
      case 'melody': return this.cleanArrangement ? 0.22 : 0.26;
      case 'percussion': return 0.5;
      default: return 0.3;
    }
  }

  private restoreLayerGain(gain: GainNode, role: Role): void {
    gain.gain.setValueAtTime(this.effectiveLayerGain(role), this.audioContext.currentTime);
  }

  private configureLayerForRole(gain: GainNode, filter: BiquadFilterNode, role: Role): void {
    gain.gain.value = this.effectiveLayerGain(role);

    switch (role) {
      case 'bass':
        filter.type = 'lowpass';
        filter.frequency.value = 200;
        break;
      case 'drone':
        filter.type = 'bandpass';
        filter.frequency.value = 400;
        break;
      case 'ostinato':
        filter.type = 'highpass';
        filter.frequency.value = 300;
        break;
      case 'texture':
        filter.type = 'bandpass';
        filter.frequency.value = 800;
        break;
      case 'accents':
        filter.type = 'peaking';
        filter.frequency.value = 1000;
        break;
      case 'melody':
        filter.type = 'lowpass';
        filter.frequency.value = 2600;
        break;
      case 'percussion':
        // The noise hits bring their own per-hit filters.
        filter.type = 'allpass';
        filter.frequency.value = 1000;
        break;
    }
  }

  private midiToFrequency(midiNote: number): number {
    return 440 * Math.pow(2, (midiNote - 69) / 12);
  }

  private getNoiseBuffer(): AudioBuffer {
    if (!this.noiseBuffer) {
      const length = this.audioContext.sampleRate;
      this.noiseBuffer = this.audioContext.createBuffer(1, length, this.audioContext.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noiseBuffer;
  }

  /** kick / snare / hat profiles for the noise channel. */
  private static noiseHitProfile(pitch: number): {
    filterType: BiquadFilterType;
    frequency: number;
    q: number;
    decay: number;
    gainScale: number;
  } {
    if (pitch <= 36) {
      return { filterType: 'lowpass', frequency: 220, q: 1, decay: 0.14, gainScale: 0.9 };
    }
    if (pitch <= 40) {
      // Snare: broadband mids, fuller and longer than a hat.
      return { filterType: 'bandpass', frequency: 1900, q: 0.7, decay: 0.1, gainScale: 0.85 };
    }
    return { filterType: 'highpass', frequency: 5200, q: 1, decay: 0.05, gainScale: 0.5 };
  }

  /** Game Boy noise channel: filtered white-noise bursts for drum hits. */
  private scheduleNoiseHit(layer: SynthLayer, pitch: number, velocity: number, when: number): void {
    const source = this.audioContext.createBufferSource();
    source.buffer = this.getNoiseBuffer();

    const hitFilter = this.audioContext.createBiquadFilter();
    const envelope = this.audioContext.createGain();
    const profile = SynthesisEngine.noiseHitProfile(pitch);
    hitFilter.type = profile.filterType;
    hitFilter.frequency.value = profile.frequency;
    hitFilter.Q.value = profile.q;

    const decay = profile.decay;
    const gainValue = velocity * profile.gainScale;
    envelope.gain.setValueAtTime(gainValue, when);
    envelope.gain.exponentialRampToValueAtTime(0.001, when + decay);

    source.connect(hitFilter);
    hitFilter.connect(envelope);
    envelope.connect(layer.filterNode);
    source.start(when);
    source.stop(when + decay + 0.02);

    setTimeout(() => {
      try {
        source.disconnect();
        hitFilter.disconnect();
        envelope.disconnect();
      } catch (e) {
        // Already disconnected
      }
    }, (when - this.audioContext.currentTime + decay + 0.1) * 1000);
  }

  private scheduleNote(role: Role, pitch: number, duration: number, velocity: number, when: number): void {
    const layer = this.layers.get(role);
    if (!layer) return;

    if (role === 'percussion') {
      this.scheduleNoiseHit(layer, pitch, velocity, when);
      return;
    }

    const osc = this.audioContext.createOscillator();
    const envelope = this.audioContext.createGain();

    // Convert MIDI pitch to frequency
    const frequency = this.midiToFrequency(pitch);
    osc.frequency.value = frequency;

    // Game Boy timbres: thin pulse leads, soft wave-channel bass.
    switch (role) {
      case 'bass':
        osc.type = 'triangle';
        break;
      case 'drone':
        osc.type = 'sawtooth';
        break;
      case 'ostinato':
        osc.setPeriodicWave(this.getPulseWave(0.125));
        break;
      case 'melody':
        osc.setPeriodicWave(this.getPulseWave(0.25));
        break;
      case 'texture':
      case 'accents':
        osc.type = 'sine';
        break;
    }

    // Delayed vibrato on sustained lead notes — the classic chip-lead touch.
    let lfo: OscillatorNode | null = null;
    let lfoDepth: GainNode | null = null;
    if (role === 'melody' && duration > 0.25) {
      lfo = this.audioContext.createOscillator();
      lfo.frequency.value = 5.6;
      lfoDepth = this.audioContext.createGain();
      const vibratoStart = when + Math.min(0.2, duration * 0.4);
      lfoDepth.gain.setValueAtTime(0, when);
      lfoDepth.gain.setValueAtTime(0, vibratoStart);
      lfoDepth.gain.linearRampToValueAtTime(14, vibratoStart + 0.12);
      lfo.connect(lfoDepth);
      lfoDepth.connect(osc.detune);
      lfo.start(when);
      lfo.stop(when + duration + 0.2);
    }
    
    osc.connect(envelope);
    envelope.connect(layer.filterNode);
    
    // Envelope based on velocity and duration with minimum times to prevent clicks
    const highNoteScale = pitch > 79 ? 0.65 : 1;
    const cleanScale = this.cleanArrangement ? 0.82 : 1;
    const gainValue = velocity * 0.5 * highNoteScale * cleanScale;
    const minimumAttack = this.cleanArrangement ? 0.012 : 0.003;
    const attackTime = Math.max(minimumAttack, Math.min(0.03, duration * 0.08));
    const maxRelease = this.cleanArrangement ? 0.055 : role === 'texture' ? 0.07 : 0.11;
    const releaseTime = Math.max(0.03, Math.min(maxRelease, duration * 0.2));

    envelope.gain.setValueAtTime(0, when);
    envelope.gain.linearRampToValueAtTime(gainValue, when + attackTime);
    envelope.gain.setValueAtTime(gainValue, when + Math.max(attackTime, duration - releaseTime));
    envelope.gain.exponentialRampToValueAtTime(0.001, when + duration + releaseTime);

    osc.start(when);
    osc.stop(when + duration + releaseTime + 0.01); // Stop after envelope completes
    
    // Clean up after note ends
    setTimeout(() => {
      try {
        osc.disconnect();
        envelope.disconnect();
        lfo?.disconnect();
        lfoDepth?.disconnect();
      } catch (e) {
        // Already disconnected
      }
    }, (duration + releaseTime + 0.1) * 1000);
  }

  private scheduleEvents(): void {
    if (!this.isPlaying) return;

    // When looping a section, jump back to its start as we reach its end.
    if (this.loopRegion) {
      const songTime = this.audioContext.currentTime - this.startTime;
      if (songTime >= this.loopRegion.end - 0.05) {
        this.startTime = this.audioContext.currentTime - this.loopRegion.start;
        for (const [role, assignment] of this.roleAssignments) {
          let index = 0;
          while (
            index < assignment.events.length
            && assignment.events[index].time < this.loopRegion.start
          ) {
            index++;
          }
          this.nextEventIndex.set(role, index);
        }
      }
    }

    const currentTime = this.audioContext.currentTime;
    const scheduleUntil = currentTime + this.config.lookaheadTime;

    // Schedule events for each role
    for (const [role, assignment] of this.roleAssignments) {
      this.scheduleRoleEvents(role, assignment, scheduleUntil);
    }
  }

  private scheduleRoleEvents(role: Role, assignment: RoleAssignment, scheduleUntil: number): void {
    const events = assignment.events;

    // The event list already contains every note in each chord. Scheduling the
    // derived chord list instead used to drop all standalone notes between
    // chord attacks, which made solo-piano transcriptions sound fragmented.
    if (events.length > 0) this.scheduleSingleEvents(role, events, scheduleUntil);
  }

  private scheduleSingleEvents(role: Role, events: NoteEvent[], scheduleUntil: number): void {
    let eventIndex = this.nextEventIndex.get(role) || 0;
    
    while (eventIndex < events.length) {
      const event = events[eventIndex];
      const eventTime = this.startTime + event.time;

      // Stop if we're past the lookahead window
      if (eventTime > scheduleUntil) break;

      // Inside a loop region, don't schedule past its end — the scheduler
      // jumps back to the region start instead.
      if (this.loopRegion && event.time >= this.loopRegion.end) break;

      // Schedule if the event hasn't been played yet
      if (eventTime >= this.audioContext.currentTime) {
        this.scheduleNote(
          role,
          event.pitch,
          Math.max(0.05, event.duration), // Minimum duration
          event.velocity,
          eventTime
        );
      }
      
      eventIndex++;
    }
    
    // Update the next event index
    this.nextEventIndex.set(role, eventIndex);
    
    // Loop the whole song when we reach the end (section loops are handled
    // by the loop-region jump in scheduleEvents instead).
    if (!this.loopRegion && eventIndex >= events.length) {
      this.nextEventIndex.set(role, 0);
      // Reset start time for looping
      if (Array.from(this.nextEventIndex.values()).every(idx => idx === 0)) {
        this.startTime = this.audioContext.currentTime;
      }
    }
  }





  private fadeOutAllLayers(): void {
    const fadeTime = this.config.fadeTime;
    const when = this.audioContext.currentTime;

    for (const layer of this.layers.values()) {
      // Cancel any scheduled ramps and fade to 0
      layer.gainNode.gain.cancelScheduledValues(when);
      layer.gainNode.gain.setValueAtTime(layer.gainNode.gain.value, when);
      layer.gainNode.gain.linearRampToValueAtTime(0, when + fadeTime);
    }

    // Don't cleanup layers - keep them connected for resume
    // Layers are only cleaned up when setupLayers is called with new data
  }

  private cleanupLayers(): void {
    for (const layer of this.layers.values()) {
      for (const osc of layer.oscillators) {
        try {
          osc.stop();
          osc.disconnect();
        } catch (e) {
          // Oscillator might already be stopped
        }
      }
      layer.gainNode.disconnect();
      layer.filterNode.disconnect();
      for (const node of layer.extraNodes ?? []) {
        try {
          node.disconnect();
        } catch (e) {
          // Already disconnected
        }
      }
    }
    this.layers.clear();
    this.roleAssignments.clear();
  }

  /**
   * Render audio offline (faster than real-time) to an AudioBuffer.
   * This is a static method that creates its own offline context and scheduling.
   */
  static async renderOffline(
    assignments: RoleAssignment[],
    _config: MotifConfig,
    sampleRate = 44100
  ): Promise<AudioBuffer> {
    // Calculate duration from assignments
    let maxDuration = 0;
    for (const assignment of assignments) {
      for (const event of assignment.events) {
        const eventEnd = event.time + event.duration;
        maxDuration = Math.max(maxDuration, eventEnd);
      }
      for (const chord of assignment.chords) {
        const chordEnd = chord.time + chord.duration;
        maxDuration = Math.max(maxDuration, chordEnd);
      }
    }

    // Add a little padding for release envelopes
    const totalDuration = maxDuration + 0.5;
    const totalSamples = Math.ceil(totalDuration * sampleRate);

    // Create offline context
    const offlineCtx = new OfflineAudioContext(2, totalSamples, sampleRate);

    // Create master gain
    const masterGain = offlineCtx.createGain();
    masterGain.connect(offlineCtx.destination);
    masterGain.gain.value = 0.3;

    // Normalize times (same logic as setupLayers)
    let earliestTime = Infinity;
    for (const assignment of assignments) {
      if (assignment.events.length > 0) {
        earliestTime = Math.min(earliestTime, assignment.events[0].time);
      }
      if (assignment.chords.length > 0) {
        earliestTime = Math.min(earliestTime, assignment.chords[0].time);
      }
    }
    if (earliestTime !== Infinity && earliestTime > 0) {
      for (const assignment of assignments) {
        for (const event of assignment.events) {
          event.time -= earliestTime;
        }
        for (const chord of assignment.chords) {
          chord.time -= earliestTime;
        }
      }
    }

    // Schedule all events for each assignment
    for (const assignment of assignments) {
      const { role, events, chords } = assignment;

      // Create layer nodes for this role
      const { filterNode } = SynthesisEngine.createOfflineLayer(offlineCtx, masterGain, role);

      // For roles that support polyphony, prefer chords
      if ((role === 'drone' || role === 'texture') && chords.length > 0) {
        for (const chord of chords) {
          SynthesisEngine.scheduleOfflineChord(
            offlineCtx,
            filterNode,
            role,
            chord.pitches,
            Math.max(0.05, chord.duration),
            chord.velocity,
            chord.time
          );
        }
      } else {
        for (const event of events) {
          SynthesisEngine.scheduleOfflineNote(
            offlineCtx,
            filterNode,
            role,
            event.pitch,
            Math.max(0.05, event.duration),
            event.velocity,
            event.time
          );
        }
      }
    }

    // Render and return
    return offlineCtx.startRendering();
  }

  private static createOfflineLayer(
    ctx: OfflineAudioContext,
    masterGain: GainNode,
    role: Role
  ): { gainNode: GainNode; filterNode: BiquadFilterNode } {
    const gainNode = ctx.createGain();
    const filterNode = ctx.createBiquadFilter();

    filterNode.connect(gainNode);
    gainNode.connect(masterGain);

    if (role === 'melody') {
      // Same slapback echo as the live melody layer.
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.165;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.18;
      const wet = ctx.createGain();
      wet.gain.value = 0.25;
      gainNode.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(wet);
      wet.connect(masterGain);
    }

    // Set gain based on role (square layers sit lower than triangles)
    switch (role) {
      case 'bass': gainNode.gain.value = 0.4; break;
      case 'drone': gainNode.gain.value = 0.2; break;
      case 'ostinato': gainNode.gain.value = 0.22; break;
      case 'texture': gainNode.gain.value = 0.1; break;
      case 'accents': gainNode.gain.value = 0.5; break;
      case 'melody': gainNode.gain.value = 0.26; break;
      case 'percussion': gainNode.gain.value = 0.5; break;
      default: gainNode.gain.value = 0.3;
    }

    // Configure filter based on role
    switch (role) {
      case 'bass':
        filterNode.type = 'lowpass';
        filterNode.frequency.value = 200;
        break;
      case 'drone':
        filterNode.type = 'bandpass';
        filterNode.frequency.value = 400;
        break;
      case 'ostinato':
        filterNode.type = 'highpass';
        filterNode.frequency.value = 300;
        break;
      case 'texture':
        filterNode.type = 'bandpass';
        filterNode.frequency.value = 800;
        break;
      case 'accents':
        filterNode.type = 'peaking';
        filterNode.frequency.value = 1000;
        break;
      case 'melody':
        filterNode.type = 'lowpass';
        filterNode.frequency.value = 4000;
        break;
      case 'percussion':
        filterNode.type = 'allpass';
        filterNode.frequency.value = 1000;
        break;
    }

    return { gainNode, filterNode };
  }

  private static midiToFreq(midiNote: number): number {
    return 440 * Math.pow(2, (midiNote - 69) / 12);
  }

  private static getOscillatorType(role: Role): OscillatorType {
    switch (role) {
      case 'bass': return 'triangle';
      case 'drone': return 'sawtooth';
      case 'ostinato': return 'square';
      case 'melody': return 'square';
      case 'texture': return 'sine';
      case 'accents': return 'sine';
      default: return 'sine';
    }
  }

  /** Offline twin of scheduleNoiseHit for renders/exports. */
  private static scheduleOfflineNoiseHit(
    ctx: OfflineAudioContext,
    filterNode: BiquadFilterNode,
    pitch: number,
    velocity: number,
    when: number
  ): void {
    const length = Math.ceil(ctx.sampleRate * 0.2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const hitFilter = ctx.createBiquadFilter();
    const envelope = ctx.createGain();
    const profile = SynthesisEngine.noiseHitProfile(pitch);
    hitFilter.type = profile.filterType;
    hitFilter.frequency.value = profile.frequency;
    hitFilter.Q.value = profile.q;

    const decay = profile.decay;
    const gainValue = velocity * profile.gainScale;
    envelope.gain.setValueAtTime(gainValue, when);
    envelope.gain.exponentialRampToValueAtTime(0.001, when + decay);

    source.connect(hitFilter);
    hitFilter.connect(envelope);
    envelope.connect(filterNode);
    source.start(when);
    source.stop(when + decay + 0.02);
  }

  private static scheduleOfflineNote(
    ctx: OfflineAudioContext,
    filterNode: BiquadFilterNode,
    role: Role,
    pitch: number,
    duration: number,
    velocity: number,
    when: number
  ): void {
    if (role === 'percussion') {
      SynthesisEngine.scheduleOfflineNoiseHit(ctx, filterNode, pitch, velocity, when);
      return;
    }

    const osc = ctx.createOscillator();
    const envelope = ctx.createGain();

    osc.frequency.value = SynthesisEngine.midiToFreq(pitch);
    if (role === 'melody') {
      osc.setPeriodicWave(SynthesisEngine.createPulseWave(ctx, 0.25));
    } else if (role === 'ostinato') {
      osc.setPeriodicWave(SynthesisEngine.createPulseWave(ctx, 0.125));
    } else {
      osc.type = SynthesisEngine.getOscillatorType(role);
    }

    osc.connect(envelope);
    envelope.connect(filterNode);

    // Same delayed vibrato as the live lead.
    if (role === 'melody' && duration > 0.25) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5.6;
      const lfoDepth = ctx.createGain();
      const vibratoStart = when + Math.min(0.2, duration * 0.4);
      lfoDepth.gain.setValueAtTime(0, when);
      lfoDepth.gain.setValueAtTime(0, vibratoStart);
      lfoDepth.gain.linearRampToValueAtTime(14, vibratoStart + 0.12);
      lfo.connect(lfoDepth);
      lfoDepth.connect(osc.detune);
      lfo.start(when);
      lfo.stop(when + duration + 0.2);
    }

    const gainValue = velocity * 0.5;
    const attackTime = Math.max(0.003, Math.min(0.025, duration * 0.06));
    const releaseTime = Math.max(0.04, Math.min(0.16, duration * 0.25));

    envelope.gain.setValueAtTime(0, when);
    envelope.gain.linearRampToValueAtTime(gainValue, when + attackTime);
    envelope.gain.setValueAtTime(gainValue, when + Math.max(attackTime, duration - releaseTime));
    envelope.gain.exponentialRampToValueAtTime(0.001, when + duration + releaseTime);

    osc.start(when);
    osc.stop(when + duration + releaseTime + 0.01);
  }

  private static scheduleOfflineChord(
    ctx: OfflineAudioContext,
    filterNode: BiquadFilterNode,
    role: Role,
    pitches: number[],
    duration: number,
    velocity: number,
    when: number
  ): void {
    for (const pitch of pitches) {
      const osc = ctx.createOscillator();
      const envelope = ctx.createGain();

      osc.frequency.value = SynthesisEngine.midiToFreq(pitch);
      osc.type = SynthesisEngine.getOscillatorType(role);

      osc.connect(envelope);
      envelope.connect(filterNode);

      const gainValue = (velocity * 0.3) / Math.max(pitches.length * 0.5, 1);
      const attackTime = Math.max(0.003, Math.min(0.025, duration * 0.06));
      const releaseTime = Math.max(0.04, Math.min(0.16, duration * 0.25));

      envelope.gain.setValueAtTime(0, when);
      envelope.gain.linearRampToValueAtTime(gainValue, when + attackTime);
      envelope.gain.setValueAtTime(gainValue, when + Math.max(attackTime, duration - releaseTime));
      envelope.gain.exponentialRampToValueAtTime(0.001, when + duration + releaseTime);

      osc.start(when);
      osc.stop(when + duration + releaseTime + 0.01);
    }
  }
}
