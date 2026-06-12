interface MIDISearchResult {
  id: string;
  title: string;
  source: string;
  pageUrl: string;
  midiUrl: string;
  confidence: number;
  parsed?: ParsedMIDIInfo;
}

interface ParsedMIDIInfo {
  durationSec: number;
  tempoBpm: number;
  timeSig?: { num: number; den: number };
  tracks: TrackInfo[];
  noteCount: number;
  issues: string[];
}

interface TrackInfo {
  id: number;
  name?: string;
  program?: number;
  noteCount: number;
  channel?: number;
  register: 'low' | 'mid' | 'high';
}

interface MIDISearchResponse {
  results: MIDISearchResult[];
  count: number;
}

export interface AudioTranscriptionResult {
  midi: ArrayBuffer;
  title?: string;
  arrangement?: string;
  bpm?: number;
  bpmSource?: string;
  sections?: number[];
  analysis?: {
    chord_source?: string;
    key?: string;
    summary?: Record<string, number>;
    events?: Array<{
      time: number;
      duration: number;
      pitch: number;
      original_pitch: number;
      confidence: number;
      status: 'corrected' | 'removed' | 'conflict';
      reason?: string;
      chord?: string | null;
    }>;
    chords?: Array<{
      start: number;
      end: number;
      label: string;
    }>;
  };
}

export interface AudioTranscriptionProgress {
  status: 'running' | 'done';
  percent: number;
  label: string;
}

export class MIDIService {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    // Production (Vercel): prefer same-origin API (no env var needed)
    // Dev: default to local backend on :3001
    const envUrl = (import.meta as any).env?.VITE_API_URL as string | undefined;
    const isDev = Boolean((import.meta as any).env?.DEV);

    if (baseUrl) {
      this.baseUrl = baseUrl;
    } else if (envUrl) {
      this.baseUrl = envUrl;
    } else if (isDev) {
      this.baseUrl = 'http://localhost:3001';
    } else {
      this.baseUrl = '';
    }
  }

  private async fetchWithRetry(url: string, init?: RequestInit, timeoutMs = 20000): Promise<Response> {
    const attempt = async (): Promise<Response> => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        // iOS Safari can behave oddly with cached API responses; force no-store.
        return await fetch(url, {
          ...init,
          cache: 'no-store',
          signal: controller.signal,
        });
      } finally {
        window.clearTimeout(timeout);
      }
    };

    try {
      return await attempt();
    } catch (e) {
      // One fast retry for transient iOS/network hiccups.
      await new Promise(r => window.setTimeout(r, 200));
      return await attempt();
    }
  }

  async search(query: string): Promise<MIDISearchResult[]> {
    const response = await this.fetchWithRetry(`${this.baseUrl}/api/midi/search?q=${encodeURIComponent(query)}`);
    if (!response.ok) {
      let message = `Search failed: ${response.status}`;
      try {
        const body = await response.json() as { error?: string };
        if (body?.error) message = body.error;
      } catch {
        // ignore JSON parse errors and keep generic message
      }
      throw new Error(message);
    }
    const data: MIDISearchResponse = await response.json();
    return data.results;
  }

  async fetchMIDI(url: string): Promise<ArrayBuffer | null> {
    try {
      const response = await this.fetchWithRetry(`${this.baseUrl}/api/midi/fetch?u=${encodeURIComponent(url)}`);
      
      if (!response.ok) {
        throw new Error(`Fetch failed: ${response.status}`);
      }

      return await response.arrayBuffer();
    } catch (error) {
      console.error('MIDI fetch error:', error);
      return null;
    }
  }

  async parseMIDI(url: string): Promise<ParsedMIDIInfo | null> {
    try {
      const response = await this.fetchWithRetry(`${this.baseUrl}/api/midi/parse?u=${encodeURIComponent(url)}`);
      
      if (!response.ok) {
        throw new Error(`Parse failed: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('MIDI parse error:', error);
      return null;
    }
  }

  async transcribeYouTube(
    url: string,
    mode: 'piano' | 'general',
    arrangement: 'off' | 'composer' | 'expanded',
    bpm: number | undefined,
    separate: boolean,
    onProgress?: (progress: AudioTranscriptionProgress) => void
  ): Promise<AudioTranscriptionResult> {
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/api/audio/transcribe-url`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, mode, arrangement, bpm, separate }),
      },
      30000
    );
    return this.waitForTranscription(response, onProgress);
  }

  async transcribeAudioFile(
    file: File,
    mode: 'piano' | 'general',
    arrangement: 'off' | 'composer' | 'expanded',
    bpm: number | undefined,
    separate: boolean,
    onProgress?: (progress: AudioTranscriptionProgress) => void
  ): Promise<AudioTranscriptionResult> {
    const query = `filename=${encodeURIComponent(file.name)}&mode=${mode}&arrangement=${arrangement}`
      + `${separate ? '&separate=true' : ''}`
      + `${bpm === undefined ? '' : `&bpm=${encodeURIComponent(String(bpm))}`}`;
    const response = await this.fetchWithRetry(
      `${this.baseUrl}/api/audio/transcribe-upload?${query}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      },
      5 * 60 * 1000
    );
    return this.waitForTranscription(response, onProgress);
  }

  private async waitForTranscription(
    startResponse: Response,
    onProgress?: (progress: AudioTranscriptionProgress) => void
  ): Promise<AudioTranscriptionResult> {
    if (!startResponse.ok) {
      throw new Error(await this.readErrorMessage(startResponse, `Transcription failed: ${startResponse.status}`));
    }

    const started = await startResponse.json() as { jobId?: unknown };
    if (typeof started.jobId !== 'string' || !started.jobId) {
      throw new Error('The transcription server did not return a job ID.');
    }

    const deadline = Date.now() + 31 * 60 * 1000;
    while (Date.now() < deadline) {
      const progressResponse = await this.fetchWithRetry(
        `${this.baseUrl}/api/audio/transcription/${encodeURIComponent(started.jobId)}`,
        undefined,
        20000
      );
      if (!progressResponse.ok) {
        throw new Error(await this.readErrorMessage(
          progressResponse,
          `Could not check transcription progress: ${progressResponse.status}`
        ));
      }

      const progress = await progressResponse.json() as {
        status?: unknown;
        percent?: unknown;
        label?: unknown;
        error?: unknown;
      };
      const percent = typeof progress.percent === 'number'
        ? Math.max(0, Math.min(100, Math.round(progress.percent)))
        : 0;
      const label = typeof progress.label === 'string' ? progress.label : 'Working';

      if (progress.status === 'error') {
        throw new Error(typeof progress.error === 'string' ? progress.error : 'Transcription failed.');
      }
      if (progress.status !== 'running' && progress.status !== 'done') {
        throw new Error('The transcription server returned an unknown job status.');
      }

      onProgress?.({ status: progress.status, percent, label });
      if (progress.status === 'done') {
        const jobPath = `${this.baseUrl}/api/audio/transcription/${encodeURIComponent(started.jobId)}`;
        const [resultResponse, analysisResponse] = await Promise.all([
          this.fetchWithRetry(`${jobPath}/result`, undefined, 60000),
          this.fetchWithRetry(`${jobPath}/analysis`, undefined, 60000),
        ]);
        const result = await this.readTranscription(resultResponse);
        if (analysisResponse.ok) {
          result.analysis = await analysisResponse.json();
        }
        return result;
      }

      await new Promise<void>(resolve => window.setTimeout(resolve, 600));
    }

    throw new Error('Transcription timed out after 31 minutes.');
  }

  private async readTranscription(response: Response): Promise<AudioTranscriptionResult> {
    if (!response.ok) {
      throw new Error(await this.readErrorMessage(response, `Transcription failed: ${response.status}`));
    }
    const encodedTitle = response.headers.get('X-Motif-Title');
    let title: string | undefined;
    if (encodedTitle) {
      try {
        title = decodeURIComponent(encodedTitle);
      } catch {
        title = encodedTitle;
      }
    }
    const arrangement = response.headers.get('X-Motif-Arrangement') || undefined;
    const bpmHeader = response.headers.get('X-Motif-Bpm');
    const parsedBpm = bpmHeader === null ? Number.NaN : Number(bpmHeader);
    const bpm = Number.isFinite(parsedBpm) ? parsedBpm : undefined;
    const bpmSource = response.headers.get('X-Motif-Bpm-Source') || undefined;
    let sections: number[] | undefined;
    try {
      const sectionsHeader = response.headers.get('X-Motif-Sections');
      if (sectionsHeader) {
        const parsed = JSON.parse(sectionsHeader) as unknown;
        if (Array.isArray(parsed)) {
          sections = parsed.filter((value): value is number => typeof value === 'number');
        }
      }
    } catch {
      // Sections are a bonus; ignore malformed headers.
    }
    return { midi: await response.arrayBuffer(), title, arrangement, bpm, bpmSource, sections };
  }

  private async readErrorMessage(response: Response, fallback: string): Promise<string> {
    try {
      const body = await response.json() as { error?: unknown };
      return typeof body.error === 'string' && body.error ? body.error : fallback;
    } catch {
      return fallback;
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
