import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kv } from '@vercel/kv';
import { createClient } from 'redis';
import { MIDISearchService } from './services/MIDISearchService.js';
import { MIDIFetchService } from './services/MIDIFetchService.js';
import { MIDIParseService } from './services/MIDIParseService.js';

const app = express();
const port = process.env.PORT || 3001;

app.use(cors({ exposedHeaders: ['X-Motif-Title', 'X-Motif-Arrangement'] }));
app.use(express.json());

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const audioScript = path.resolve(serverDir, '../python/audio_to_midi.py');
const localPython = process.platform === 'win32'
  ? path.resolve(serverDir, '../.venv/Scripts/python.exe')
  : path.resolve(serverDir, '../.venv/bin/python');
const pythonCommand = process.env.PYTHON_PATH
  || (existsSync(localPython) ? localPython : (process.platform === 'win32' ? 'python' : 'python3'));

type AudioTranscriptionResult = {
  midi: Buffer;
  title?: string;
  arrangement?: string;
};

async function runAudioTranscription(args: string[]): Promise<AudioTranscriptionResult> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motif-transcribe-'));
  const midiPath = path.join(workDir, 'transcription.mid');
  const metadataPath = path.join(workDir, 'metadata.json');

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        pythonCommand,
        [audioScript, ...args, '--output', midiPath, '--metadata-output', metadataPath],
        { env: process.env, windowsHide: true }
      );
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Transcription timed out after 15 minutes.'));
      }, 15 * 60 * 1000);

      child.stderr.on('data', chunk => {
        stderr += String(chunk);
      });
      child.on('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on('close', code => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `Transcription exited with code ${code}.`));
      });
    });
    const midi = await fs.readFile(midiPath);
    let title: string | undefined;
    let arrangement: string | undefined;
    try {
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as {
        title?: unknown;
        arrangement?: unknown;
      };
      if (typeof metadata.title === 'string') title = metadata.title.slice(0, 300);
      if (typeof metadata.arrangement === 'string') arrangement = metadata.arrangement.slice(0, 50);
    } catch {
      // Metadata is helpful but not required for playback.
    }
    return { midi, title, arrangement };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

function sendTranscriptionError(res: express.Response, error: unknown): void {
  console.error('Audio transcription error:', error);
  const detail = error instanceof Error ? error.message : 'Audio transcription failed.';
  const missingDependency = /No module named|not recognized|ENOENT|FFmpeg was not found/i.test(detail);
  res.status(missingDependency ? 503 : 500).json({
    error: missingDependency
      ? 'Audio transcription is not installed. Run pip install -r server/requirements-audio.txt and configure FFmpeg.'
      : detail,
  });
}

const searchService = new MIDISearchService();
const fetchService = new MIDIFetchService();
const parseService = new MIDIParseService();

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getOrigin(req: express.Request): string {
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = xfProto || (req.secure ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();
  if (!host) return '';
  return `${proto}://${host}`;
}

type SharePayload =
  | {
      kind: 'bitmidi';
      id: string;
      title?: string;
      createdAt: string;
      v: number;
    }
  | {
      kind: 'url';
      u: string;
      title?: string;
      createdAt: string;
      v: number;
    };

const localShareStore = new Map<string, SharePayload>();
const isVercel = Boolean(process.env.VERCEL);
const hasKvEnv = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
const redisUrl = process.env.REDIS_URL;
const hasRedisEnv = Boolean(redisUrl);

let redisClient: ReturnType<typeof createClient> | null = null;
let redisConnectPromise: Promise<void> | null = null;

async function getRedis(): Promise<ReturnType<typeof createClient>> {
  if (!redisUrl) throw new Error('REDIS_URL is not configured for this project.');
  if (!redisClient) {
    redisClient = createClient({ url: redisUrl });
    redisClient.on('error', (err) => console.error('Redis error:', err));
  }
  if (!redisClient.isOpen) {
    if (!redisConnectPromise) {
      redisConnectPromise = redisClient.connect().then(() => {}).finally(() => {
        redisConnectPromise = null;
      });
    }
    await redisConnectPromise;
  }
  return redisClient;
}

function base62(bytes: Uint8Array): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function newCode(): string {
  // 8 chars base62-ish from random bytes (sufficient for our scale)
  return base62(crypto.randomBytes(8));
}

async function shareSet(code: string, payload: SharePayload): Promise<void> {
  const key = `share:${code}`;
  // 30 days TTL
  const exSec = 60 * 60 * 24 * 30;
  if (isVercel && !hasRedisEnv && !hasKvEnv) {
    throw new Error('No storage configured (need REDIS_URL or Vercel KV env vars).');
  }

  // Prefer Redis integration if present (your project has REDIS_URL).
  if (hasRedisEnv) {
    const r = await getRedis();
    await r.set(key, JSON.stringify(payload), { EX: exSec });
    return;
  }

  // Fallback: Vercel KV REST (Upstash)
  if (hasKvEnv) {
    await kv.set(key, payload, { ex: exSec });
    return;
  }

  // Local dev only: best-effort in-memory store.
  localShareStore.set(code, payload);
}

async function shareGet(code: string): Promise<SharePayload | null> {
  const key = `share:${code}`;
  if (isVercel && !hasRedisEnv && !hasKvEnv) {
    throw new Error('No storage configured (need REDIS_URL or Vercel KV env vars).');
  }

  if (hasRedisEnv) {
    const r = await getRedis();
    const val = await r.get(key);
    if (!val) return null;
    return JSON.parse(val) as SharePayload;
  }

  if (hasKvEnv) {
    const val = await kv.get<SharePayload>(key);
    return val ?? null;
  }

  return localShareStore.get(code) ?? null;
}

// Search for MIDI files
app.get('/api/midi/search', async (req, res) => {
  try {
    const query = req.query.q as string;
    if (!query) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    console.log(`Searching for: ${query}`);
    const results = await searchService.search(query);
    res.json({ results, count: results.length });
  } catch (error) {
    console.error('Search error:', error);
    if (error instanceof Error && error.message === 'MIDI_SOURCE_UNAVAILABLE') {
      return res.status(503).json({ error: 'BitMidi is temporarily unavailable. Please try again in a minute.' });
    }
    res.status(500).json({ error: 'Search failed' });
  }
});

// Use only for media the user owns or has permission to download.
app.post('/api/audio/transcribe-url', async (req, res) => {
  try {
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const mode = req.body?.mode === 'general' ? 'general' : 'piano';
    if (!url) return res.status(400).json({ error: 'A YouTube URL is required.' });

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: 'Enter a valid YouTube URL.' });
    }
    const allowedHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
    if (!allowedHosts.has(parsed.hostname.toLowerCase())) {
      return res.status(400).json({ error: 'Only YouTube URLs are supported.' });
    }

    const result = await runAudioTranscription(['--url', url, '--mode', mode]);
    res.setHeader('Content-Type', 'audio/midi');
    res.setHeader('Content-Disposition', 'attachment; filename="transcription.mid"');
    if (result.title) res.setHeader('X-Motif-Title', encodeURIComponent(result.title));
    if (result.arrangement) res.setHeader('X-Motif-Arrangement', result.arrangement);
    res.send(result.midi);
  } catch (error) {
    sendTranscriptionError(res, error);
  }
});

app.post(
  '/api/audio/transcribe-upload',
  express.raw({ type: 'application/octet-stream', limit: '150mb' }),
  async (req, res) => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'motif-upload-'));
    try {
      const requestedName = String(req.query.filename || 'upload.wav');
      const mode = req.query.mode === 'general' ? 'general' : 'piano';
      const extension = path.extname(requestedName).toLowerCase();
      const allowedExtensions = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.webm', '.mp4']);
      if (!allowedExtensions.has(extension)) {
        return res.status(400).json({ error: 'Unsupported audio format.' });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'The uploaded audio file is empty.' });
      }

      const inputPath = path.join(workDir, `upload${extension}`);
      await fs.writeFile(inputPath, req.body);
      const result = await runAudioTranscription(['--input', inputPath, '--mode', mode]);
      res.setHeader('Content-Type', 'audio/midi');
      res.setHeader('Content-Disposition', 'attachment; filename="transcription.mid"');
      const uploadTitle = path.parse(requestedName).name.slice(0, 300);
      res.setHeader('X-Motif-Title', encodeURIComponent(uploadTitle));
      if (result.arrangement) res.setHeader('X-Motif-Arrangement', result.arrangement);
      res.send(result.midi);
    } catch (error) {
      sendTranscriptionError(res, error);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }
);

// Create a short share link
app.post('/api/share', async (req, res) => {
  try {
    const body = (req.body || {}) as any;
    const now = new Date().toISOString();
    const title = typeof body.title === 'string' ? body.title.slice(0, 200) : undefined;

    let payload: SharePayload | null = null;
    if (body.src === 'bitmidi' && typeof body.id === 'string' && /^\d+$/.test(body.id)) {
      payload = { kind: 'bitmidi', id: body.id, title, createdAt: now, v: 1 };
    } else if (typeof body.u === 'string' && body.u.startsWith('http')) {
      payload = { kind: 'url', u: body.u, title, createdAt: now, v: 1 };
    }

    if (!payload) {
      return res.status(400).json({ error: 'Invalid payload. Expected {src:\"bitmidi\",id:\"123\"} or {u:\"https://...\"}.' });
    }

    // Avoid collisions (extremely unlikely, but cheap to check a few times)
    let code = newCode();
    for (let i = 0; i < 3; i++) {
      const existing = await shareGet(code);
      if (!existing) break;
      code = newCode();
    }

    await shareSet(code, payload);
    res.json({
      code,
      url: `/s/${code}`,
    });
  } catch (error) {
    console.error('Share create error:', error);
    const msg = error instanceof Error ? error.message : 'Share create failed';
    res.status(msg.includes('KV') ? 503 : 500).json({ error: msg });
  }
});

// Resolve a short share link and redirect to /play
app.get('/s/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!code) return res.status(400).send('Missing code');

    const payload = await shareGet(code);
    if (!payload) return res.status(404).send('Not found');

    let dest = '/play';
    if (payload.kind === 'bitmidi') {
      const sp = new URLSearchParams();
      sp.set('src', 'bitmidi');
      sp.set('id', payload.id);
      if (payload.title) sp.set('title', payload.title);
      dest = `/play?${sp.toString()}`;
    } else if (payload.kind === 'url') {
      const sp = new URLSearchParams();
      sp.set('u', payload.u);
      if (payload.title) sp.set('title', payload.title);
      dest = `/play?${sp.toString()}`;
    }

    // Social crawlers (Telegram, X, etc.) need HTML with OG/Twitter tags.
    // Serve a tiny landing document that redirects humans to /play.
    const origin = getOrigin(req);
    const shortUrl = origin ? `${origin}/s/${encodeURIComponent(code)}` : `/s/${encodeURIComponent(code)}`;
    const playUrl = origin ? `${origin}${dest}` : dest;
    const imageUrl = origin ? `${origin}/warioX.png` : '/warioX.png';

    const sharedTitle = (payload.title || '').trim();
    const ogTitle = sharedTitle ? `${sharedTitle} - Wario Synth` : 'Wario Synth 8-Bit Midi';
    const ogDescription = sharedTitle
      ? `I made ${sharedTitle} Game Boy version. Click to listen or generate your own.`
      : 'Turn any song into a Game Boy version';

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(ogTitle)}</title>
    <meta name="description" content="${escapeHtml(ogDescription)}" />

    <meta property="og:title" content="${escapeHtml(ogTitle)}" />
    <meta property="og:description" content="${escapeHtml(ogDescription)}" />
    <meta property="og:image" content="${escapeHtml(imageUrl)}" />
    <meta property="og:image:width" content="1472" />
    <meta property="og:image:height" content="704" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${escapeHtml(shortUrl)}" />

    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(ogTitle)}" />
    <meta name="twitter:description" content="${escapeHtml(ogDescription)}" />
    <meta name="twitter:image" content="${escapeHtml(imageUrl)}" />

    <meta http-equiv="refresh" content="0;url=${escapeHtml(playUrl)}" />
    <link rel="canonical" href="${escapeHtml(playUrl)}" />
    <style>
      body { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; background:#0a0a0a; color:#e8e8e8; margin:0; padding:24px; }
      a { color:#00ff88; }
    </style>
  </head>
  <body>
    Redirecting to the player… <a href="${escapeHtml(playUrl)}">Tap here</a>
    <script>location.replace(${JSON.stringify(playUrl)});</script>
  </body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  } catch (error) {
    console.error('Share resolve error:', error);
    const msg = error instanceof Error ? error.message : 'Resolve failed';
    res.status(msg.includes('KV') ? 503 : 500).send(msg);
  }
});

// Fetch and proxy MIDI file
app.get('/api/midi/fetch', async (req, res) => {
  try {
    const url = req.query.u as string;
    if (!url) {
      return res.status(400).json({ error: 'URL parameter "u" is required' });
    }

    console.log(`Fetching: ${url}`);
    const result = await fetchService.fetch(url);
    
    if (result.success) {
      res.setHeader('Content-Type', 'audio/midi');
      res.setHeader('Content-Length', result.data!.byteLength);
      res.send(Buffer.from(result.data!));
    } else {
      const error = String(result.error || 'Fetch failed');
      const blocked = /blocked|not allowed/i.test(error);
      res.status(blocked ? 403 : 404).json({ error });
    }
  } catch (error) {
    console.error('Fetch error:', error);
    res.status(500).json({ error: 'Fetch failed' });
  }
});

// Parse MIDI metadata
app.get('/api/midi/parse', async (req, res) => {
  try {
    const url = req.query.u as string;
    if (!url) {
      return res.status(400).json({ error: 'URL parameter "u" is required' });
    }

    console.log(`Parsing MIDI metadata: ${url}`);
    const result = await fetchService.fetch(url);
    
    if (result.success && result.data) {
      const metadata = parseService.parseMIDI(result.data);
      res.json(metadata);
    } else {
      const error = String(result.error || 'Failed to fetch MIDI');
      const blocked = /blocked|not allowed/i.test(error);
      res.status(blocked ? 403 : 404).json({ error });
    }
  } catch (error) {
    console.error('Parse error:', error);
    res.status(500).json({ error: 'Parse failed' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Vercel serverless runtime expects an exported handler (Express apps are handlers).
// Locally, we still want to run a dev server with `app.listen`.
export default app;

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`🎵 Motif backend running on port ${port}`);
  });
}
