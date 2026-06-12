import { MotifEngine } from './core/MotifEngine';
import { MIDIService, type AudioTranscriptionProgress } from './services/MIDIService';
import { MIDIParser } from './midi/MIDIParser';
import { SoundfontMIDIPlayer } from './synthesis/SoundfontMIDIPlayer';
import { getAudioContext, isAudioReady, peekAudioContext, unlockAudio } from './utils/audioUnlock';
import type { NoteEvent } from './types';

class MotifApp {
  private motifEngine: MotifEngine;
  private midiService: MIDIService;

  // Preview player (lazily created for iOS compatibility)
  private soundfontPlayer: SoundfontMIDIPlayer | null = null;
  private previewStopTimeout: number | null = null;
  
  private searchBtn!: HTMLButtonElement;
  private songInput!: HTMLInputElement;
  private audioUrlInput!: HTMLInputElement;
  private transcriptionMode!: HTMLSelectElement;
  private transcriptionBpm!: HTMLInputElement;
  private separateStems!: HTMLInputElement;
  private voiceMixer!: HTMLElement;
  private sectionLoopRow!: HTMLElement;
  private sectionLoopSelect!: HTMLSelectElement;
  private downloadMidiBtn!: HTMLButtonElement;
  private downloadWavBtn!: HTMLButtonElement;
  private pianoRoll!: HTMLCanvasElement;
  private liveNotes!: HTMLElement;
  private pianoRollFrame: number | null = null;
  private pianoRollRange: { min: number; max: number } | null = null;
  private inspectedRollNote: { role: string; event: NoteEvent } | null = null;
  private transcribeUrlBtn!: HTMLButtonElement;
  private audioFileInput!: HTMLInputElement;
  private chooseAudioBtn!: HTMLButtonElement;
  private transcriptionProgress!: HTMLElement;
  private transcriptionProgressFill!: HTMLElement;
  private transcriptionProgressLabel!: HTMLElement;
  private transcriptionProgressPercent!: HTMLElement;
  private transcriptionProgressHideTimeout: number | null = null;
  private status!: HTMLElement;
  
  private resultsSection!: HTMLElement;
  private resultsBody!: HTMLElement;
  private playerSection!: HTMLElement;
  private chooseHelper!: HTMLElement;
  
  private selectedTitle!: HTMLElement;
  private selectedMeta!: HTMLElement;
  private preGenActions!: HTMLElement;
  private preGenSupport!: HTMLElement;
  private generatedBlock!: HTMLElement;
  private playPauseBtn!: HTMLButtonElement;
  private previewBtn!: HTMLButtonElement;
  private previewStopBtn!: HTMLButtonElement;
  private previewState!: HTMLElement;

  private isPreviewPlaying = false;
  private hasGenerated = false;
  private isMotifPlaying = false;
  private motifResumeProgress = 0;

  // Preview player (no UI volume)

  // Motif controls
  private motifBtn!: HTMLButtonElement;
  private motifProgressContainer!: HTMLElement;
  private motifProgressBar!: HTMLInputElement;
  private motifProgressFill!: HTMLElement;
  private motifCurrentTime!: HTMLElement;
  private motifDuration!: HTMLElement;
  private motifProgressInterval: number | null = null;

  // iOS audio unlock UI (Motif only)
  private iosAudioBanner!: HTMLElement;
  private enableAudioBtn!: HTMLButtonElement;
  private iosAudioState!: HTMLElement;

  private copyLinkBtn!: HTMLButtonElement;
  private shareToXBtn!: HTMLButtonElement;
  private shareFallback!: HTMLElement;
  private shareFallbackInput!: HTMLInputElement;

  // Embed snippet UI
  private embedSection: HTMLElement | null = null;
  private embedCodeEl: HTMLElement | null = null;
  private copyEmbedBtn: HTMLButtonElement | null = null;
  private copyToast: HTMLElement | null = null;

  // FAQ modal
  private faqBtnTop: HTMLButtonElement | null = null;
  private newSearchBtn: HTMLButtonElement | null = null;
  private faqBackdrop!: HTMLElement;
  private faqCloseBtn!: HTMLButtonElement;

  private searchResults: any[] = [];
  private selectedResultIndex = 0;
  private currentMIDI: { events: NoteEvent[], metadata: any, buffer?: ArrayBuffer } | null = null;
  private currentMIDIIsShareable = false;

  constructor() {
    this.motifEngine = new MotifEngine();
    this.midiService = new MIDIService();
    // soundfontPlayer created lazily on first play for iOS compatibility

    this.initializeUI();
    this.setupEventListeners();

    // Always play at 100%
    this.motifEngine.setVolume(1);
  }

  /**
   * Ensure audio is unlocked and soundfontPlayer is ready.
   * Must be called from a user gesture context.
   */
  private async ensureAudioReady(): Promise<SoundfontMIDIPlayer> {
    const audioContext = await unlockAudio();
    if (!this.soundfontPlayer) {
      this.soundfontPlayer = new SoundfontMIDIPlayer(audioContext);
      this.soundfontPlayer.setVolume(1);
    }
    return this.soundfontPlayer;
  }

  private initializeUI(): void {
    this.searchBtn = document.getElementById('searchBtn') as HTMLButtonElement;
    this.songInput = document.getElementById('songInput') as HTMLInputElement;
    this.audioUrlInput = document.getElementById('audioUrlInput') as HTMLInputElement;
    this.transcriptionMode = document.getElementById('transcriptionMode') as HTMLSelectElement;
    this.transcriptionBpm = document.getElementById('transcriptionBpm') as HTMLInputElement;
    this.separateStems = document.getElementById('separateStems') as HTMLInputElement;
    this.voiceMixer = document.getElementById('voiceMixer')!;
    this.sectionLoopRow = document.getElementById('sectionLoopRow')!;
    this.sectionLoopSelect = document.getElementById('sectionLoopSelect') as HTMLSelectElement;
    this.downloadMidiBtn = document.getElementById('downloadMidiBtn') as HTMLButtonElement;
    this.downloadWavBtn = document.getElementById('downloadWavBtn') as HTMLButtonElement;
    this.pianoRoll = document.getElementById('pianoRoll') as HTMLCanvasElement;
    this.liveNotes = document.getElementById('liveNotes')!;
    this.transcribeUrlBtn = document.getElementById('transcribeUrlBtn') as HTMLButtonElement;
    this.audioFileInput = document.getElementById('audioFileInput') as HTMLInputElement;
    this.chooseAudioBtn = document.getElementById('chooseAudioBtn') as HTMLButtonElement;
    this.transcriptionProgress = document.getElementById('transcriptionProgress')!;
    this.transcriptionProgressFill = document.getElementById('transcriptionProgressFill')!;
    this.transcriptionProgressLabel = document.getElementById('transcriptionProgressLabel')!;
    this.transcriptionProgressPercent = document.getElementById('transcriptionProgressPercent')!;
    this.status = document.getElementById('status')!;

    this.resultsSection = document.getElementById('resultsSection')!;
    this.resultsBody = document.getElementById('resultsBody')!;
    this.playerSection = document.getElementById('playerSection')!;
    this.chooseHelper = document.getElementById('chooseHelper')!;
    
    this.selectedTitle = document.getElementById('selectedTitle')!;
    this.selectedMeta = document.getElementById('selectedMeta')!;
    this.preGenActions = document.getElementById('preGenActions')!;
    this.preGenSupport = document.getElementById('preGenSupport')!;
    this.generatedBlock = document.getElementById('generatedBlock')!;
    this.playPauseBtn = document.getElementById('playPauseBtn') as HTMLButtonElement;
    this.previewBtn = document.getElementById('previewBtn') as HTMLButtonElement;
    this.previewStopBtn = document.getElementById('previewStopBtn') as HTMLButtonElement;
    this.previewState = document.getElementById('previewState')!;

    // Motif controls
    this.motifBtn = document.getElementById('motifBtn') as HTMLButtonElement;
    this.motifProgressContainer = document.getElementById('motifProgressContainer')!;
    this.motifProgressBar = document.getElementById('motifProgressBar') as HTMLInputElement;
    this.motifProgressFill = document.getElementById('motifProgressFill')!;
    this.motifCurrentTime = document.getElementById('motifCurrentTime')!;
    this.motifDuration = document.getElementById('motifDuration')!;

    this.copyLinkBtn = document.getElementById('copyLinkBtn') as HTMLButtonElement;
    this.shareToXBtn = document.getElementById('shareToXBtn') as HTMLButtonElement;
    this.shareFallback = document.getElementById('shareFallback')!;
    this.shareFallbackInput = document.getElementById('shareFallbackInput') as HTMLInputElement;

    // iOS audio unlock UI (Motif)
    this.iosAudioBanner = document.getElementById('iosAudioBanner')!;
    this.enableAudioBtn = document.getElementById('enableAudioBtn') as HTMLButtonElement;
    this.iosAudioState = document.getElementById('iosAudioState')!;

    // Optional embed UI (only present on main page)
    this.embedSection = document.getElementById('embedSection');
    this.embedCodeEl = document.getElementById('embedCode');
    this.copyEmbedBtn = document.getElementById('copyEmbedBtn') as HTMLButtonElement | null;
    this.copyToast = document.getElementById('copyToast');

    // FAQ modal
    this.faqBtnTop = document.getElementById('faqBtnTop') as HTMLButtonElement | null;
    this.newSearchBtn = document.getElementById('newSearchBtn') as HTMLButtonElement | null;
    this.faqBackdrop = document.getElementById('faqModalBackdrop')!;
    this.faqCloseBtn = document.getElementById('faqCloseBtn') as HTMLButtonElement;
  }

  private setupEventListeners(): void {
    const doSearch = () => {
      console.log('[MotifApp] Search triggered');
      // Immediately show feedback so user knows click registered
      this.status.textContent = 'Starting search...';
      this.handleSearch().catch(err => {
        console.error('[MotifApp] Search error:', err);
        this.updateStatus(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      });
    };

    // Use both click and touchend for iOS compatibility
    this.searchBtn.addEventListener('click', doSearch);
    this.transcribeUrlBtn.addEventListener('click', () => void this.handleYouTubeTranscription());
    this.chooseAudioBtn.addEventListener('click', () => this.audioFileInput.click());
    this.audioFileInput.addEventListener('change', () => {
      const file = this.audioFileInput.files?.[0];
      if (file) void this.handleAudioUpload(file);
    });

    this.songInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        doSearch();
      }
    });

    // Preview MIDI (verification only) — controlled from results table rows

    // Motif
    this.motifBtn.addEventListener('click', () => this.handleMotif());
    this.playPauseBtn.addEventListener('click', () => void this.handlePlayPause());

    // Preview inside selected source only
    this.previewBtn.addEventListener('click', () => void this.handlePreviewToggle());
    this.previewStopBtn.addEventListener('click', () => this.stopPreview());
    // Use both input and change for iOS compatibility
    const seekHandler = (e: Event) => {
      const progress = parseFloat((e.target as HTMLInputElement).value) / 100;
      this.handleMotifSeek(progress);
    };
    this.motifProgressBar.addEventListener('input', seekHandler);
    this.motifProgressBar.addEventListener('change', seekHandler);
    this.pianoRoll.addEventListener('mousemove', event => this.handlePianoRollHover(event));
    this.pianoRoll.addEventListener('mouseleave', () => {
      if (!this.inspectedRollNote) return;
      this.inspectedRollNote = null;
      this.pianoRoll.style.cursor = 'default';
      this.drawPianoRoll();
    });

    this.copyLinkBtn.addEventListener('click', () => void this.handleCopyLink());
    this.shareToXBtn.addEventListener('click', () => void this.handleShareToX());

    // Downloads + section looping (generated block)
    this.downloadMidiBtn.addEventListener('click', () => this.handleDownloadMidi());
    this.downloadWavBtn.addEventListener('click', () => void this.handleDownloadWav());
    this.sectionLoopSelect.addEventListener('change', () => this.handleSectionLoopChange());

    // Embed snippet copy (may be disabled / not-live)
    this.copyEmbedBtn?.addEventListener('click', () => void this.copyEmbedSnippet());

    // iOS audio unlock CTA — must be a user gesture
    const enable = () => void this.handleEnableAudio();
    this.enableAudioBtn.addEventListener('click', enable);
    this.enableAudioBtn.addEventListener('touchend', enable, { passive: true });

    // FAQ
    this.faqBtnTop?.addEventListener('click', () => this.openFaq());
    this.newSearchBtn?.addEventListener('click', () => this.resetToNewSearch());
    this.faqCloseBtn.addEventListener('click', () => this.closeFaq());
    this.faqBackdrop.addEventListener('click', (e) => {
      if (e.target === this.faqBackdrop) this.closeFaq();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeFaq();
    });
  }

  private async handleYouTubeTranscription(): Promise<void> {
    const url = this.audioUrlInput.value.trim();
    if (!url) {
      this.updateStatus('Paste a YouTube URL first.');
      return;
    }
    await this.runTranscription(
      onProgress => this.midiService.transcribeYouTube(
        url,
        this.getTranscriptionMode(),
        'off',
        this.getTranscriptionBpm(),
        this.separateStems.checked,
        onProgress
      ),
      'YouTube transcription'
    );
  }

  private async handleAudioUpload(file: File): Promise<void> {
    await this.runTranscription(
      onProgress => this.midiService.transcribeAudioFile(
        file,
        this.getTranscriptionMode(),
        'off',
        this.getTranscriptionBpm(),
        this.separateStems.checked,
        onProgress
      ),
      file.name.replace(/\.[^.]+$/, '') || 'Audio transcription'
    );
    this.audioFileInput.value = '';
  }

  private getTranscriptionMode(): 'piano' | 'general' {
    return this.transcriptionMode.value === 'general' ? 'general' : 'piano';
  }

  private getTranscriptionBpm(): number | undefined {
    const value = this.transcriptionBpm.value.trim();
    if (!value) return undefined;
    const bpm = Number(value);
    if (!Number.isFinite(bpm) || bpm < 40 || bpm > 240) {
      throw new Error('Song speed must be between 40 and 240 BPM.');
    }
    return bpm;
  }

  private async runTranscription(
    load: (
      onProgress: (progress: AudioTranscriptionProgress) => void
    ) => Promise<{
      midi: ArrayBuffer;
      title?: string;
      arrangement?: string;
      bpm?: number;
      bpmSource?: string;
      sections?: number[];
      analysis?: import('./services/MIDIService').AudioTranscriptionResult['analysis'];
    }>,
    fallbackTitle: string
  ): Promise<void> {
    this.transcribeUrlBtn.disabled = true;
    this.chooseAudioBtn.disabled = true;
    const modeLabel = this.getTranscriptionMode() === 'piano' ? 'piano model' : 'general model';
    this.updateStatus(`Transcribing with the ${modeLabel}. This can take several minutes...`);
    this.showTranscriptionProgress();
    this.handleMotifStop();
    this.stopPreview();

    try {
      const transcription = await load(progress => {
        this.updateTranscriptionProgress(progress.percent, progress.label);
        this.updateStatus(`${progress.label} (${progress.percent}%)`);
      });
      const midiBuffer = transcription.midi;
      const title = transcription.title || fallbackTitle;
      const events = MIDIParser.parseMIDI(midiBuffer);
      if (events.length === 0) throw new Error('The transcription contained no playable notes.');
      const metadata = MIDIParser.getMIDIInfo(midiBuffer);
      const duration = Math.max(...events.map(event => event.time + event.duration));
      this.currentMIDI = {
        events,
        metadata: {
          ...metadata,
          duration,
          arrangement: transcription.arrangement,
          bpm: transcription.bpm,
          bpmSource: transcription.bpmSource,
          sections: transcription.sections,
          analysis: transcription.analysis,
        },
        buffer: midiBuffer,
      };
      this.currentMIDIIsShareable = false;
      this.hasGenerated = false;
      this.selectedTitle.textContent = this.cleanSongTitle(title);
      const arrangementLabel = transcription.arrangement === 'stems'
        ? 'Audio converted with separated instruments (melody / harmony / bass / drums)'
        : 'Audio converted with automatic faithful piano cleanup';
      const bpmLabel = transcription.bpm === undefined
        ? ''
        : ` | Timing: ${transcription.bpm} BPM (${
          transcription.bpmSource === 'manual' ? 'entered' : 'auto-detected'
        })`;
      const analysis = transcription.analysis;
      const summary = analysis?.summary;
      const harmonyLabel = analysis
        ? ` | Harmony: ${analysis.key ?? 'unknown key'} via ${
          analysis.chord_source === 'chordino' ? 'Chordino' : analysis.chord_source ?? 'audio chroma'
        } | ${summary?.corrected ?? 0} corrected, ${summary?.removed ?? 0} removed`
        : '';
      this.selectedMeta.textContent = arrangementLabel + bpmLabel + harmonyLabel;
      this.enablePlayerControls();
      this.copyLinkBtn.disabled = true;
      this.updateIOSAudioBanner();
      this.setState('selected');
      this.resultsSection.classList.remove('visible');
      this.updateTranscriptionProgress(100, 'MIDI ready');
      this.scheduleTranscriptionProgressHide(1400);
      this.updateStatus('MIDI created. Preview it, then generate the Game Boy version.');
      this.playerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      this.updateTranscriptionProgress(100, 'Transcription failed');
      this.scheduleTranscriptionProgressHide(3000);
      this.updateStatus(`Transcription error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      this.transcribeUrlBtn.disabled = false;
      this.chooseAudioBtn.disabled = false;
    }
  }

  private showTranscriptionProgress(): void {
    if (this.transcriptionProgressHideTimeout !== null) {
      window.clearTimeout(this.transcriptionProgressHideTimeout);
      this.transcriptionProgressHideTimeout = null;
    }
    this.transcriptionProgress.hidden = false;
    this.updateTranscriptionProgress(0, 'Starting transcription');
  }

  private updateTranscriptionProgress(percent: number, label: string): void {
    const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
    this.transcriptionProgressFill.style.width = `${safePercent}%`;
    this.transcriptionProgress.setAttribute('aria-valuenow', String(safePercent));
    this.transcriptionProgressLabel.textContent = label;
    this.transcriptionProgressPercent.textContent = `${safePercent}%`;
  }

  private scheduleTranscriptionProgressHide(delayMs: number): void {
    this.transcriptionProgressHideTimeout = window.setTimeout(() => {
      this.transcriptionProgress.hidden = true;
      this.transcriptionProgressHideTimeout = null;
    }, delayMs);
  }

  private openFaq(): void {
    this.faqBackdrop.classList.add('open');
    // focus close for keyboard users
    this.faqCloseBtn.focus();
  }

  private closeFaq(): void {
    this.faqBackdrop.classList.remove('open');
  }

  private resetToNewSearch(): void {
    // Stop all audio and return to the search workbench.
    this.stopPreview();
    this.handleMotifStop();
    this.hasGenerated = false;
    this.isMotifPlaying = false;
    this.motifResumeProgress = 0;
    this.currentMIDI = null;
    this.currentMIDIIsShareable = false;

    this.setState('idle');
    this.updateStatus('Ready. Search any song to make a Game Boy version.');

    try {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      // ignore
    }
    // Focus search field for immediate next query
    window.setTimeout(() => {
      try {
        this.songInput.focus();
        this.songInput.select();
      } catch {
        // ignore
      }
    }, 150);
  }

  private isIOSLike(): boolean {
    const ua = navigator.userAgent || '';
    const iOS = /iPad|iPhone|iPod/.test(ua);
    const iPadOS13Plus = /Macintosh/.test(ua) && (navigator as any).maxTouchPoints > 1;
    return iOS || iPadOS13Plus;
  }

  private updateIOSAudioBanner(): void {
    // Only show this UX on iOS-like browsers, and only until audio is running.
    if (!this.isIOSLike()) {
      this.iosAudioBanner.style.display = 'none';
      return;
    }

    const ready = isAudioReady();
    this.iosAudioBanner.style.display = ready ? 'none' : 'block';

    // Optional tiny state readout (helps support debugging)
    const ctx = peekAudioContext();
    if (!ready && ctx) {
      this.iosAudioState.style.display = 'block';
      this.iosAudioState.textContent = `Audio: ${ctx.state} @ ${ctx.sampleRate}Hz`;
    } else {
      this.iosAudioState.style.display = 'none';
      this.iosAudioState.textContent = '';
    }
  }

  private async handleEnableAudio(): Promise<void> {
    // Must run in a user gesture context.
    try {
      this.enableAudioBtn.disabled = true;
      this.iosAudioState.style.display = 'block';
      this.iosAudioState.textContent = 'Audio: enabling…';

      await unlockAudio();

      // Update banner state
      const ctx = getAudioContext();
      if (ctx.state !== 'running') {
        this.enableAudioBtn.disabled = false;
        this.iosAudioState.textContent = 'Audio still locked. Tap Enable Audio again.';
        return;
      }

      this.iosAudioState.textContent = `Audio: running @ ${ctx.sampleRate}Hz`;
      // Hide after a short beat to reduce flicker
      window.setTimeout(() => this.updateIOSAudioBanner(), 250);
    } catch {
      this.enableAudioBtn.disabled = false;
      this.iosAudioState.style.display = 'block';
      this.iosAudioState.textContent = 'Audio enable failed. Tap again, or disable Silent Mode.';
    } finally {
      this.enableAudioBtn.disabled = false;
    }
  }

  private async handleSearch(): Promise<void> {
    console.log('[MotifApp] handleSearch called');
    const songName = this.songInput.value.trim();
    console.log('[MotifApp] songName:', songName);
    if (!songName) {
      this.updateStatus('Enter a song name to search.');
      this.songInput.focus();
      return;
    }

    // Stop any playing Motif audio
    this.handleMotifStop();

    this.updateStatus('Searching…');
    console.log('[MotifApp] Starting search for:', songName);
    this.searchBtn.disabled = true;
    this.setState('idle');

    try {
      const results = await this.midiService.search(songName);
      
      if (results.length === 0) {
        this.updateStatus('No MIDI files found. Try a different search.');
        return;
      }

      this.searchResults = results;
      this.selectedResultIndex = 0;

      // Parse metadata for results
      this.updateStatus('Analyzing MIDI files...');
      for (let i = 0; i < Math.min(results.length, 3); i++) {
        const metadata = await this.midiService.parseMIDI(results[i].midiUrl);
        if (metadata) {
          results[i].parsed = metadata;
        }
      }

      this.displayResults();
      this.setState('results');
      this.updateStatus('Pick a midi source. Try another if it sounds bad, some work better than others.');
      this.updateIOSAudioBanner();

    } catch (error) {
      this.updateStatus(`Search error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      this.searchBtn.disabled = false;
    }
  }

  private displayResults(): void {
    this.resultsBody.innerHTML = '';

    this.searchResults.forEach((result, index) => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${this.cleanSongTitle(result.title)}</td>
        <td class="source-col">${this.formatSourceLabel(result.source)}</td>
        <td class="action-col">
          <div style="display:flex; gap: 10px; justify-content: flex-end; align-items:center;">
            <button type="button" class="row-use-btn">Use</button>
          </div>
        </td>
      `;

      // Use explicit action button to reduce accidental selection
      const useBtn = row.querySelector('button.row-use-btn') as HTMLButtonElement;
      useBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.selectResult(index);
      });

      this.resultsBody.appendChild(row);
    });

    // No auto-select: user should choose "Use this"
  }

  private stopPreview(): void {
    if (this.previewStopTimeout) {
      window.clearTimeout(this.previewStopTimeout);
      this.previewStopTimeout = null;
    }
    this.soundfontPlayer?.stop();
    this.isPreviewPlaying = false;
    this.previewState.style.display = 'none';
    this.previewStopBtn.style.display = 'none';
    this.previewBtn.disabled = this.currentMIDI == null;
  }

  public async selectResult(index: number): Promise<void> {
    if (index < 0 || index >= this.searchResults.length) return;

    // Stop any playing Motif audio
    this.handleMotifStop();
    // Stop any playing preview audio
    this.soundfontPlayer?.stop();
    this.stopPreview();
    this.hasGenerated = false;

    this.selectedResultIndex = index;
    const result = this.searchResults[index];

    // Update selection highlighting
    const rows = this.resultsBody.querySelectorAll('tr');
    rows.forEach((row, i) => {
      row.classList.toggle('selected', i === index);
    });
    
    this.updateStatus('Loading…');
    this.disablePlayerControls();

    try {
      // Fetch and parse MIDI
      const midiBuffer = await this.midiService.fetchMIDI(result.midiUrl);
      if (!midiBuffer) {
        throw new Error('Failed to fetch MIDI file');
      }

      const events = MIDIParser.parseMIDI(midiBuffer);
      const metadata = result.parsed || MIDIParser.getMIDIInfo(midiBuffer);

      // Calculate duration from events if metadata duration is 0 or missing
      let actualDuration = metadata.duration || metadata.durationSec || 0;
      if (actualDuration === 0 && events.length > 0) {
        // Calculate duration from the last event
        actualDuration = Math.max(...events.map(e => e.time + e.duration));
      }

      this.currentMIDI = { events, metadata: { ...metadata, duration: actualDuration }, buffer: midiBuffer };
      this.currentMIDIIsShareable = true;

      // Update UI
      const displayTitle = this.cleanSongTitle(result.title);
      this.selectedTitle.textContent = displayTitle;
      this.selectedMeta.textContent = `Source: ${this.formatSourceLabel(result.source)}`;

      this.updateEmbedSnippet(result.title);
      this.updateIOSAudioBanner();
      
      this.playerSection.classList.add('visible');
      this.resultsSection.classList.add('collapsed');
      this.enablePlayerControls();
      this.updateStatus('');
      this.setState('selected');

      // Intent: after selecting "Use this", bring the workbench controls into view.
      // Do this after the card is visible and MIDI is loaded.
      try {
        this.playerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch {
        // ignore
      }

    } catch (error) {
      this.updateStatus(`Load error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handlePreviewToggle(): Promise<void> {
    if (!this.currentMIDI) return;
    if (this.isPreviewPlaying) {
      this.stopPreview();
      return;
    }

    // Audio exclusivity
    this.handleMotifStop();

    try {
      this.previewBtn.disabled = true;
      const player = await this.ensureAudioReady();
      await player.load(this.currentMIDI.events);
      // conservative fixed preview level
      player.setVolume(0.8);
      await player.play();

      this.isPreviewPlaying = true;
      this.previewState.style.display = 'inline';
      this.previewStopBtn.style.display = 'inline';
      this.previewBtn.disabled = false;

      const duration = player.getDuration();
      if (this.previewStopTimeout) window.clearTimeout(this.previewStopTimeout);
      this.previewStopTimeout = window.setTimeout(() => {
        this.stopPreview();
      }, Math.max(0.5, duration + 0.5) * 1000);
    } catch {
      this.stopPreview();
    }
  }

  // Motif handlers
  private async handleMotif(): Promise<void> {
    if (!this.currentMIDI) {
      return;
    }

    try {
      // Audio exclusivity
      this.stopPreview();
      // Best-effort: ensure iOS audio is unlocked from this user gesture.
      await unlockAudio();
      this.updateIOSAudioBanner();

      // Preserve scroll position during state change
      const scrollY = window.scrollY;
      // Once generation starts: lock into generated experience mode.
      this.setState('generated');
      window.scrollTo(0, scrollY);
      this.updateStatus('Generating…');
      this.motifBtn.disabled = true;
      this.playPauseBtn.disabled = true;

      // Generate a variation using the procedural role-mapping mode
      const arrangementMode = this.currentMIDI.metadata?.arrangement as
        | 'original'
        | 'composer'
        | 'expanded'
        | undefined;
      await this.motifEngine.generateFromMIDI(
        this.currentMIDI.events,
        'procedural',
        {
          arrangementMode,
        }
      );
      this.motifEngine.setVolume(0.8);

      await this.motifEngine.play();

      this.isMotifPlaying = true;
      this.playPauseBtn.disabled = false;
      this.playPauseBtn.textContent = 'Pause';

      // Show progress bar and set duration
      this.motifProgressContainer.style.display = 'block';
      const duration = this.motifEngine.getDuration();
      this.motifDuration.textContent = this.formatTime(duration);
      this.motifProgressBar.value = '0';
      this.motifProgressFill.style.width = '0%';

      // Start progress updates
      this.startMotifProgressUpdates();

      this.updateStatus('');
      this.hasGenerated = true;
      this.renderVoiceMixer();
      this.setupSectionLoop();
      this.initPianoRoll();
      this.startPianoRollAnimation();
      // Refresh generated state now that generation succeeded (enables Copy link, etc.)
      const scrollYEnd = window.scrollY;
      this.setState('generated');
      window.scrollTo(0, scrollYEnd);
    } catch (error) {
      this.updateStatus(`Motif error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      this.motifBtn.disabled = false;
      this.playPauseBtn.disabled = false;
      // If generation fails, return to selected state
      this.setState('selected');
    }
  }

  private handleMotifStop(): void {
    this.motifEngine.stop();
    this.isMotifPlaying = false;
    this.playPauseBtn.textContent = 'Play';
    this.stopMotifProgressUpdates();
    this.stopPianoRollAnimation();
    this.drawPianoRoll();
    this.updateStatus('');
  }

  private static readonly VOICE_LABELS: Record<string, string> = {
    melody: 'Melody (lead)',
    bass: 'Bass',
    texture: 'Harmony',
    ostinato: 'Arpeggio',
    drone: 'Drone',
    accents: 'Accents',
    percussion: 'Drums (noise)',
  };

  // Original DMG screen shades, brightest for the lead.
  private static readonly ROLL_COLORS: Record<string, string> = {
    melody: '#9bbc0e',
    ostinato: '#8bac0f',
    texture: '#8bac0f',
    accents: '#9bbc0e',
    drone: '#306230',
    bass: '#306230',
  };

  private initPianoRoll(): void {
    const voices = this.motifEngine.getVoiceEvents();
    const pitches = voices
      .filter(voice => voice.role !== 'percussion')
      .flatMap(voice => voice.events.map(event => event.pitch));
    if (pitches.length === 0) {
      this.pianoRoll.style.display = 'none';
      this.liveNotes.style.display = 'none';
      this.pianoRollRange = null;
      return;
    }
    this.pianoRollRange = {
      min: Math.min(...pitches) - 2,
      max: Math.max(...pitches) + 2,
    };
    this.pianoRoll.style.display = 'block';
    this.liveNotes.style.display = 'block';
    this.drawPianoRoll();
  }

  private startPianoRollAnimation(): void {
    this.stopPianoRollAnimation();
    if (!this.pianoRollRange) return;
    const loop = () => {
      this.drawPianoRoll();
      this.pianoRollFrame = requestAnimationFrame(loop);
    };
    this.pianoRollFrame = requestAnimationFrame(loop);
  }

  private stopPianoRollAnimation(): void {
    if (this.pianoRollFrame !== null) {
      cancelAnimationFrame(this.pianoRollFrame);
      this.pianoRollFrame = null;
    }
  }

  private drawPianoRoll(): void {
    const range = this.pianoRollRange;
    if (!range) return;
    const voices = this.motifEngine.getVoiceEvents();
    if (voices.length === 0) return;

    const canvas = this.pianoRoll;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // The playhead sits a quarter in: 2 seconds of past, 6 of future.
    // When paused the engine reports 0, so fall back to the resume position.
    const now = this.isMotifPlaying
      ? this.motifEngine.getCurrentTime()
      : this.motifResumeProgress * this.motifEngine.getDuration();
    const windowStart = now - 2;
    const windowSpan = 8;
    const analysis = this.currentMIDI?.metadata?.analysis as
      | import('./services/MIDIService').AudioTranscriptionResult['analysis']
      | undefined;

    ctx.fillStyle = '#0f380f';
    ctx.fillRect(0, 0, width, height);
    const labelWidth = 42;
    const chartWidth = Math.max(1, width - labelWidth);

    // One faint gridline per second.
    ctx.strokeStyle = 'rgba(139, 172, 15, 0.16)';
    ctx.lineWidth = 1;
    for (let second = Math.ceil(windowStart); second <= windowStart + windowSpan; second++) {
      if (second < 0) continue;
      const x = labelWidth + ((second - windowStart) / windowSpan) * chartWidth;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    const drumLaneHeight = 18;
    const pitchedHeight = height - drumLaneHeight - 4;
    const laneCount = Math.max(1, range.max - range.min);
    const laneHeight = pitchedHeight / laneCount;
    ctx.font = '8px "Press Start 2P", monospace';
    ctx.textBaseline = 'middle';

    // Pitch guides and octave labels let musicians orient themselves quickly.
    for (let pitch = Math.ceil(range.min); pitch <= Math.floor(range.max); pitch++) {
      if (pitch % 12 !== 0) continue;
      const y = ((range.max - pitch) / laneCount) * pitchedHeight + 2;
      ctx.strokeStyle = 'rgba(139, 172, 15, 0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(labelWidth, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      ctx.fillStyle = '#8bac0f';
      ctx.fillText(MotifApp.noteName(pitch), 3, y);
    }

    const activeNotes: Array<{ role: string; pitch: number; velocity: number }> = [];
    for (const voice of voices) {
      const isDrums = voice.role === 'percussion';
      const baseColor = MotifApp.ROLL_COLORS[voice.role] ?? '#8bac0f';
      for (const event of voice.events) {
        if (event.time >= windowStart + windowSpan) break;
        if (event.time + event.duration <= windowStart) continue;
        const x = labelWidth + ((event.time - windowStart) / windowSpan) * chartWidth;
        const noteWidth = Math.max(2, (event.duration / windowSpan) * chartWidth - 1);
        const active = now >= event.time && now <= event.time + event.duration;
        const inspected = this.inspectedRollNote?.role === voice.role
          && this.inspectedRollNote.event === event;
        const diagnostic = analysis?.events?.find(item =>
          item.status !== 'removed'
          && Math.abs(item.time - event.time) <= 0.06
          && Math.abs(item.pitch - event.pitch) <= 1
        );
        ctx.fillStyle = inspected || active ? '#e0f8d0' : baseColor;
        if (active && !isDrums) {
          activeNotes.push({ role: voice.role, pitch: event.pitch, velocity: event.velocity });
        }
        if (isDrums) {
          // Three thin lanes at the bottom: hats, snares, kicks (top to bottom).
          const lane = event.pitch <= 36 ? 2 : event.pitch <= 40 ? 1 : 0;
          const laneSize = drumLaneHeight / 3;
          const y = height - drumLaneHeight + lane * laneSize + 1;
          ctx.fillRect(x, y, Math.max(2, Math.min(noteWidth, 4)), Math.max(2, laneSize - 2));
        } else {
          const y = ((range.max - event.pitch) / laneCount) * pitchedHeight + 2;
          ctx.fillRect(x, y, noteWidth, Math.max(2, laneHeight - 1));
          if (diagnostic?.status === 'corrected') {
            ctx.strokeStyle = '#e0f8d0';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 2]);
            ctx.strokeRect(x, y, noteWidth, Math.max(2, laneHeight - 1));
            ctx.setLineDash([]);
          } else if (diagnostic?.status === 'conflict') {
            ctx.strokeStyle = '#8bac0f';
            ctx.lineWidth = 1;
            ctx.strokeRect(x, y, noteWidth, Math.max(2, laneHeight - 1));
          }
          if (inspected) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.strokeRect(x - 1, y - 1, noteWidth + 2, Math.max(3, laneHeight));
          }
          if (active && laneHeight >= 5) {
            ctx.fillStyle = '#0f380f';
            ctx.font = '7px "Press Start 2P", monospace';
            ctx.fillText(MotifApp.noteName(event.pitch), x + 3, y + laneHeight / 2);
          }
        }
      }
    }

    for (const item of analysis?.events ?? []) {
      if (item.status !== 'removed') continue;
      if (item.time >= windowStart + windowSpan || item.time + item.duration <= windowStart) continue;
      const x = labelWidth + ((item.time - windowStart) / windowSpan) * chartWidth;
      const y = ((range.max - item.original_pitch) / laneCount) * pitchedHeight + 2;
      const noteWidth = Math.max(2, (item.duration / windowSpan) * chartWidth - 1);
      ctx.strokeStyle = 'rgba(224, 248, 208, 0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.strokeRect(x, y, noteWidth, Math.max(2, laneHeight - 1));
      ctx.setLineDash([]);
    }

    // Playhead.
    const playheadX = labelWidth + (2 / windowSpan) * chartWidth;
    ctx.strokeStyle = 'rgba(224, 248, 208, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();

    const uniqueActive = [...new Map(
      activeNotes
        .sort((a, b) => a.pitch - b.pitch)
        .map(note => [`${note.role}:${note.pitch}`, note])
    ).values()];
    if (this.inspectedRollNote && !this.isMotifPlaying) {
      const { role, event } = this.inspectedRollNote;
      const voice = MotifApp.VOICE_LABELS[role] ?? role;
      const diagnostic = analysis?.events?.find(item =>
        item.status !== 'removed'
        && Math.abs(item.time - event.time) <= 0.06
        && Math.abs(item.pitch - event.pitch) <= 1
      );
      this.liveNotes.textContent = `INSPECT: ${MotifApp.noteName(event.pitch)}`
        + ` | MIDI ${event.pitch}`
        + ` | ${voice}`
        + ` | velocity ${Math.round(event.velocity * 100)}%`
        + ` | starts ${event.time.toFixed(2)}s`
        + ` | lasts ${event.duration.toFixed(2)}s`
        + (diagnostic
          ? ` | ${diagnostic.status.toUpperCase()}: ${diagnostic.reason ?? 'harmony check'}`
          : '');
    } else {
      const currentChord = analysis?.chords?.find(chord => chord.start <= now && now < chord.end);
      this.liveNotes.textContent = uniqueActive.length === 0
      ? `NOW: -${currentChord ? ` | CHORD: ${currentChord.label}` : ''}`
      : `NOW: ${uniqueActive.map(note => {
        const voice = MotifApp.VOICE_LABELS[note.role] ?? note.role;
        return `${MotifApp.noteName(note.pitch)} ${voice}`;
      }).join('  |  ')}${currentChord ? ` | CHORD: ${currentChord.label}` : ''}`;
    }
  }

  private handlePianoRollHover(pointer: MouseEvent): void {
    if (this.isMotifPlaying || !this.pianoRollRange) {
      this.pianoRoll.style.cursor = 'default';
      return;
    }

    const canvas = this.pianoRoll;
    const rect = canvas.getBoundingClientRect();
    const x = pointer.clientX - rect.left;
    const y = pointer.clientY - rect.top;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const labelWidth = 42;
    const drumLaneHeight = 18;
    const pitchedHeight = height - drumLaneHeight - 4;
    const chartWidth = Math.max(1, width - labelWidth);
    if (x < labelWidth || y < 0 || y > pitchedHeight) {
      this.setInspectedRollNote(null);
      return;
    }

    const now = this.motifResumeProgress * this.motifEngine.getDuration();
    const windowStart = now - 2;
    const windowSpan = 8;
    const hoveredTime = windowStart + ((x - labelWidth) / chartWidth) * windowSpan;
    const range = this.pianoRollRange;
    const laneCount = Math.max(1, range.max - range.min);
    const hoveredPitch = range.max - (y / pitchedHeight) * laneCount;
    let best: { role: string; event: NoteEvent; distance: number } | null = null;

    for (const voice of this.motifEngine.getVoiceEvents()) {
      if (voice.role === 'percussion') continue;
      for (const event of voice.events) {
        if (event.time > hoveredTime) break;
        if (hoveredTime > event.time + event.duration) continue;
        const distance = Math.abs(event.pitch - hoveredPitch);
        if (distance <= 0.8 && (!best || distance < best.distance)) {
          best = { role: voice.role, event, distance };
        }
      }
    }

    this.setInspectedRollNote(best ? { role: best.role, event: best.event } : null);
  }

  private setInspectedRollNote(note: { role: string; event: NoteEvent } | null): void {
    if (
      this.inspectedRollNote?.role === note?.role
      && this.inspectedRollNote?.event === note?.event
    ) return;
    this.inspectedRollNote = note;
    this.pianoRoll.style.cursor = note ? 'pointer' : 'default';
    this.drawPianoRoll();
  }

  private static noteName(pitch: number): string {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return `${names[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
  }

  private renderVoiceMixer(): void {
    const voices = this.motifEngine.getActiveVoices();
    this.voiceMixer.innerHTML = '';
    if (voices.length < 2) {
      this.voiceMixer.style.display = 'none';
      return;
    }
    for (const role of voices) {
      const row = document.createElement('div');
      row.className = 'mixer-row';

      const name = document.createElement('span');
      name.className = 'voice-name';
      name.textContent = MotifApp.VOICE_LABELS[role] ?? role;

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.value = String(Math.round(this.motifEngine.getVoiceLevel(role) * 100));
      slider.setAttribute('aria-label', `${name.textContent} volume`);
      slider.addEventListener('input', () => {
        this.motifEngine.setVoiceLevel(role, Number(slider.value) / 100);
      });

      const muteBtn = document.createElement('button');
      muteBtn.type = 'button';
      muteBtn.textContent = this.motifEngine.isVoiceMuted(role) ? 'Unmute' : 'Mute';
      muteBtn.classList.toggle('muted', this.motifEngine.isVoiceMuted(role));
      muteBtn.addEventListener('click', () => {
        const muted = !this.motifEngine.isVoiceMuted(role);
        this.motifEngine.setVoiceMuted(role, muted);
        muteBtn.classList.toggle('muted', muted);
        muteBtn.textContent = muted ? 'Unmute' : 'Mute';
      });

      row.append(name, slider, muteBtn);
      this.voiceMixer.appendChild(row);
    }
    this.voiceMixer.style.display = 'flex';
  }

  private setupSectionLoop(): void {
    // Section times come from the original audio; rescale to the styled timeline.
    const sections = ((this.currentMIDI?.metadata?.sections as number[] | undefined) ?? [])
      .slice();
    const duration = this.motifEngine.getDuration();
    this.sectionLoopSelect.innerHTML = '';
    this.motifEngine.setLoopRegion(null);
    if (sections.length < 2 || duration <= 0) {
      this.sectionLoopRow.style.display = 'none';
      return;
    }

    const whole = document.createElement('option');
    whole.value = '';
    whole.textContent = 'Whole song';
    this.sectionLoopSelect.appendChild(whole);

    sections.forEach((start, index) => {
      const end = index + 1 < sections.length ? sections[index + 1] : duration;
      if (end - start < 2 || start >= duration) return;
      const option = document.createElement('option');
      option.value = `${start}|${Math.min(end, duration)}`;
      option.textContent = `Section ${index + 1} (${this.formatTime(start)}-${this.formatTime(Math.min(end, duration))})`;
      this.sectionLoopSelect.appendChild(option);
    });

    this.sectionLoopRow.style.display = this.sectionLoopSelect.options.length > 1 ? 'flex' : 'none';
  }

  private handleSectionLoopChange(): void {
    const value = this.sectionLoopSelect.value;
    if (!value) {
      this.motifEngine.setLoopRegion(null);
      return;
    }
    const [start, end] = value.split('|').map(Number);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      this.motifEngine.setLoopRegion({ start, end });
    }
  }

  private handleDownloadMidi(): void {
    const buffer = this.currentMIDI?.buffer;
    if (!buffer) {
      this.updateStatus('No MIDI is loaded to download.');
      return;
    }
    const name = `${this.sanitizeFileName(this.selectedTitle.textContent || 'wario-synth')}.mid`;
    this.triggerDownload(new Blob([buffer], { type: 'audio/midi' }), name);
  }

  private async handleDownloadWav(): Promise<void> {
    if (!this.currentMIDI) {
      this.updateStatus('Load a song first.');
      return;
    }
    this.downloadWavBtn.disabled = true;
    this.updateStatus('Rendering WAV...');
    try {
      const arrangementMode = this.currentMIDI.metadata?.arrangement as
        | 'original'
        | 'composer'
        | 'expanded'
        | undefined;
      const rendered = await this.motifEngine.renderOffline(
        this.currentMIDI.events,
        'procedural',
        44100,
        { arrangementMode }
      );
      const name = `${this.sanitizeFileName(this.selectedTitle.textContent || 'wario-synth')}.wav`;
      this.triggerDownload(MotifApp.audioBufferToWavBlob(rendered), name);
      this.updateStatus('');
    } catch (error) {
      this.updateStatus(`WAV render error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      this.downloadWavBtn.disabled = false;
    }
  }

  private sanitizeFileName(name: string): string {
    return (
      name.replace(/[^a-z0-9\- _]/gi, '').trim().replace(/\s+/g, '-').toLowerCase()
      || 'wario-synth'
    );
  }

  private triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  private static audioBufferToWavBlob(buffer: AudioBuffer): Blob {
    const channels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const frames = buffer.length;
    const bytesPerSample = 2;
    const dataSize = frames * channels * bytesPerSample;
    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);
    const writeString = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * bytesPerSample, true);
    view.setUint16(32, channels * bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    const channelData = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
    let offset = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        const sample = Math.max(-1, Math.min(1, channelData[c][i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += bytesPerSample;
      }
    }
    return new Blob([arrayBuffer], { type: 'audio/wav' });
  }

  private handleMotifSeek(progress: number): void {
    this.motifResumeProgress = progress;
    if (this.isMotifPlaying) {
      this.motifEngine.seek(progress);
      this.updateMotifProgress();
      return;
    }
    const duration = this.motifEngine.getDuration();
    this.motifProgressBar.value = (progress * 100).toString();
    this.motifProgressFill.style.width = `${progress * 100}%`;
    this.motifCurrentTime.textContent = this.formatTime(progress * duration);
    this.drawPianoRoll();
  }

  private startMotifProgressUpdates(): void {
    this.stopMotifProgressUpdates();
    this.motifProgressInterval = window.setInterval(() => {
      this.updateMotifProgress();
    }, 100); // Update 10 times per second
  }

  private stopMotifProgressUpdates(): void {
    if (this.motifProgressInterval !== null) {
      clearInterval(this.motifProgressInterval);
      this.motifProgressInterval = null;
    }
  }

  private updateMotifProgress(): void {
    const progress = this.motifEngine.getProgress();
    const currentTime = this.motifEngine.getCurrentTime();

    this.motifProgressBar.value = (progress * 100).toString();
    this.motifProgressFill.style.width = `${progress * 100}%`;
    this.motifCurrentTime.textContent = this.formatTime(currentTime);

    // Auto-pause at end
    const duration = this.motifEngine.getDuration();
    if (duration > 0 && progress >= 0.999) {
      this.motifResumeProgress = 0;
      this.handleMotifStop();
      this.motifCurrentTime.textContent = this.formatTime(duration);
      this.motifProgressBar.value = '100';
      this.motifProgressFill.style.width = '100%';
    }
  }

  private formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  private titleCase(input: string): string {
    const small = new Set([
      'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into',
      'nor', 'of', 'on', 'or', 'per', 'the', 'to', 'via', 'with',
    ]);
    const words = (input || '')
      .split(/\s+/g)
      .filter(Boolean)
      .map((w) => w.trim());
    return words
      .map((word, idx) => {
        if (/^[A-Z0-9]+$/.test(word)) return word;
        const lower = word.toLowerCase();
        if (idx !== 0 && small.has(lower)) return lower;
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      })
      .join(' ');
  }

  private cleanSongTitle(raw: string): string {
    const cleaned = (raw || '')
      .replace(/\.mid$/i, '')
      .replace(/[_]+/g, ' ')
      .replace(/[.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      // Strip standalone "mid" or "midi" words (case insensitive)
      .replace(/\b(midi?)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    return this.titleCase(cleaned || 'Unknown');
  }

  private formatSourceLabel(source: string): string {
    const s = String(source || '').toLowerCase();
    if (s === 'bitmidi') return 'BitMidi';
    if (s === 'dongrays') return 'Dongrays';
    return this.titleCase(s);
  }

  private enablePlayerControls(): void {
    this.motifBtn.disabled = false;
    this.copyLinkBtn.disabled = this.currentMIDI == null;
    this.previewBtn.disabled = this.currentMIDI == null;
  }

  private disablePlayerControls(): void {
    this.motifBtn.disabled = true;
    this.copyLinkBtn.disabled = true;
    this.previewBtn.disabled = true;
  }

  private updateStatus(message: string): void {
    this.status.textContent = message;
  }

  private async handleCopyLink(): Promise<void> {
    if (!this.hasGenerated || !this.currentMIDIIsShareable) return;
    const result = this.searchResults[this.selectedResultIndex];
    if (!result?.midiUrl) return;

    const title = result.title || '';

    // Try to get a short link with dynamic OG tags
    let shareUrl: string | null = null;
    try {
      let payload: any = null;
      if (result.source === 'bitmidi') {
        const m = String(result.midiUrl).match(/\/uploads\/(\d+)\.mid/i);
        if (m?.[1]) payload = { src: 'bitmidi', id: m[1], title };
      }
      if (!payload) payload = { u: result.midiUrl, title };

      const resp = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data?.url) shareUrl = `${window.location.origin}${data.url}`;
      }
    } catch {
      // Fall through to long URL
    }

    // Fallback: direct /play link
    if (!shareUrl) {
      const encodedTitle = encodeURIComponent(title);
      if (result.source === 'bitmidi') {
        const m = String(result.midiUrl).match(/\/uploads\/(\d+)\.mid/i);
        if (m?.[1]) {
          shareUrl = `${window.location.origin}/play?src=bitmidi&id=${encodeURIComponent(m[1])}&title=${encodedTitle}`;
        } else {
          shareUrl = `${window.location.origin}/play?u=${encodeURIComponent(result.midiUrl)}&title=${encodedTitle}`;
        }
      } else {
        shareUrl = `${window.location.origin}/play?u=${encodeURIComponent(result.midiUrl)}&title=${encodedTitle}`;
      }
    }

    // Try to copy to clipboard
    let copied = false;

    // Method 1: Modern Clipboard API
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
        copied = true;
      }
    } catch {
      // Clipboard API failed, try fallback
    }

    // Method 2: execCommand fallback (works better on iOS Safari)
    if (!copied) {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = shareUrl;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '0';
        textarea.setAttribute('readonly', ''); // Prevent zoom on iOS
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        // iOS needs setSelectionRange
        textarea.setSelectionRange(0, shareUrl.length);
        copied = document.execCommand('copy');
        document.body.removeChild(textarea);
      } catch {
        // execCommand failed too
      }
    }

    // Show feedback
    if (copied) {
      const originalText = this.copyLinkBtn.textContent;
      this.copyLinkBtn.textContent = 'Copied!';
      this.shareFallback.style.display = 'none';
      setTimeout(() => {
        this.copyLinkBtn.textContent = originalText;
      }, 1500);
    } else {
      // Show fallback with the link for manual copying
      this.shareFallbackInput.value = shareUrl;
      this.shareFallback.style.display = 'block';
      // Select the text so user can easily copy
      this.shareFallbackInput.focus();
      this.shareFallbackInput.select();
    }
  }

  private async handleShareToX(): Promise<void> {
    if (!this.hasGenerated || !this.currentMIDIIsShareable) return;
    const result = this.searchResults[this.selectedResultIndex];
    if (!result?.midiUrl) return;

    const title = this.cleanSongTitle(result.title || 'a song');

    // Open window immediately (must be in user gesture context for mobile)
    // We'll navigate it after getting the share URL
    const popup = window.open('about:blank', '_blank');

    // Get share URL (try short link first)
    let shareUrl: string | null = null;
    try {
      let payload: any = null;
      if (result.source === 'bitmidi') {
        const m = String(result.midiUrl).match(/\/uploads\/(\d+)\.mid/i);
        if (m?.[1]) payload = { src: 'bitmidi', id: m[1], title: result.title };
      }
      if (!payload) payload = { u: result.midiUrl, title: result.title };

      const resp = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data?.url) shareUrl = `${window.location.origin}${data.url}`;
      }
    } catch {
      // Fall through
    }

    if (!shareUrl) {
      shareUrl = window.location.href;
    }

    // Compose tweet text
    const tweetText = `I made a Game Boy version of ${title}\n\nUsing @b1rdmania's Wario Synthesis Midi Engine\n\nCheck it out here`;
    const twitterUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}&url=${encodeURIComponent(shareUrl)}`;

    // Navigate the already-opened window
    if (popup) {
      popup.location.href = twitterUrl;
    } else {
      // Fallback if popup was blocked
      window.location.href = twitterUrl;
    }
  }

  private setState(state: 'idle' | 'results' | 'selected' | 'generated'): void {
    // results - keep visible in all states except idle so user can pick a different source
    const hasResults = state === 'results' || state === 'selected' || state === 'generated';
    this.resultsSection.classList.toggle('visible', hasResults);
    this.chooseHelper.style.display = 'none';

    // selected card
    const hasSelection = state === 'selected' || state === 'generated';
    this.playerSection.classList.toggle('visible', hasSelection);

    // share buttons only after generation
    const canShare = state === 'generated' && this.hasGenerated && this.currentMIDIIsShareable;
    this.copyLinkBtn.style.display = canShare ? 'inline-block' : 'none';
    this.copyLinkBtn.disabled = !canShare;
    this.shareToXBtn.style.display = canShare ? 'inline-block' : 'none';
    this.shareToXBtn.disabled = !canShare;
    // Hide share fallback when state changes
    this.shareFallback.style.display = 'none';

    // New search button only after generation
    if (this.newSearchBtn) {
      this.newSearchBtn.style.display = state === 'generated' ? 'inline-block' : 'none';
    }

    // Dim results when selected/generated, but keep them interactive
    this.resultsSection.classList.toggle('collapsed', state === 'selected' || state === 'generated');

    // Never lock search - users should always be able to search or pick different results

    // Selected pre-generation content
    const showPreGen = state === 'selected';
    this.preGenActions.style.display = showPreGen ? 'block' : 'none';
    this.preGenSupport.style.display = showPreGen ? 'flex' : 'none';

    // Generated artifact content
    const showGenerated = state === 'generated';
    this.generatedBlock.style.display = showGenerated ? 'block' : 'none';
    this.playPauseBtn.disabled = !showGenerated || !this.hasGenerated;
    this.playPauseBtn.textContent = this.isMotifPlaying ? 'Pause' : 'Play';

    // iOS banner only before generation
    if (showPreGen) {
      this.updateIOSAudioBanner();
    } else {
      this.iosAudioBanner.style.display = 'none';
    }
  }

  private async handlePlayPause(): Promise<void> {
    if (!this.hasGenerated) return;

    if (this.isMotifPlaying) {
      this.motifResumeProgress = this.motifEngine.getProgress();
      this.motifEngine.stop();
      this.isMotifPlaying = false;
      this.stopMotifProgressUpdates();
      this.stopPianoRollAnimation();
      this.playPauseBtn.textContent = 'Play';
      return;
    }

    try {
      // Audio exclusivity
      this.stopPreview();
      await unlockAudio();
      this.inspectedRollNote = null;
      this.pianoRoll.style.cursor = 'default';

      this.motifEngine.setVolume(0.8);
      await this.motifEngine.play();
      if (this.motifResumeProgress > 0) this.motifEngine.seek(this.motifResumeProgress);
      this.isMotifPlaying = true;
      this.playPauseBtn.textContent = 'Pause';
      this.startMotifProgressUpdates();
      this.startPianoRollAnimation();
    } catch {
      // ignore
    }
  }

  private updateEmbedSnippet(songTitle: string): void {
    if (!this.embedSection || !this.embedCodeEl) return;

    const notLive = this.embedSection.getAttribute('data-not-live') === 'true';
    const base = notLive ? 'https://YOUR_DOMAIN' : window.location.origin;
    const url = `${base}/embed?song=${encodeURIComponent(songTitle)}`;

    const snippet = `<iframe\n  src=\"${url}\"\n  width=\"420\"\n  height=\"260\"\n  style=\"border:0;border-radius:12px;overflow:hidden\"\n  allow=\"autoplay\"\n></iframe>`;

    this.embedCodeEl.textContent = snippet;
    this.embedSection.style.display = 'block';
    if (this.copyToast) this.copyToast.style.display = 'none';
  }

  private async copyEmbedSnippet(): Promise<void> {
    if (!this.embedCodeEl) return;
    if (this.embedSection?.getAttribute('data-not-live') === 'true') {
      this.updateStatus('Embed is coming soon.');
      return;
    }

    const text = this.embedCodeEl.textContent || '';
    if (!text.trim()) return;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }

      if (this.copyToast) {
        this.copyToast.style.display = 'inline';
        window.setTimeout(() => {
          if (this.copyToast) this.copyToast.style.display = 'none';
        }, 1200);
      }
    } catch {
      this.updateStatus('Copy failed. Select the snippet and copy manually.');
    }
  }
}

// Make app globally available for onclick handlers
try {
  const app = new MotifApp();
  (window as any).app = app;
  console.log('[MotifApp] Initialized successfully');
} catch (err) {
  console.error('[MotifApp] Failed to initialize:', err);
  // Show error in UI so users can report it
  const status = document.getElementById('status');
  if (status) {
    status.textContent = `App error: ${err instanceof Error ? err.message : 'Unknown error'}. Please refresh.`;
    status.style.color = '#ff6b6b';
  }
}
