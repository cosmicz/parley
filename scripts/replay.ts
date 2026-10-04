/**
 * Local, repeatable G2 audio-path rehearsal. Uses macOS system voices and
 * tools; no recording or generated audio is stored in the repository.
 * Optional SONIOX_API_KEY exercises live STT from this local CLI only.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PauseDetector, pcmBytesToInt16 } from '../src/vad.ts';
import { SonioxStream } from '../src/stt-soniox.ts';

const RATE = 16_000;
const CHUNK_MS = 20;
const BYTES_PER_CHUNK = RATE * CHUNK_MS / 1000 * 2;

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'pipe' });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr}`)));
  });
}

function pcmFromWav(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (Buffer.from(bytes.subarray(0, 4)).toString() !== 'RIFF' ||
      Buffer.from(bytes.subarray(8, 12)).toString() !== 'WAVE') throw new Error('afconvert did not make RIFF WAV');
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const tag = Buffer.from(bytes.subarray(offset, offset + 4)).toString();
    const length = view.getUint32(offset + 4, true);
    if (tag === 'data') return bytes.slice(offset + 8, offset + 8 + length);
    offset += 8 + length + (length % 2);
  }
  throw new Error('WAV data chunk missing');
}

async function voicePcm(directory: string, name: string, phrase: string): Promise<Uint8Array> {
  const aiff = join(directory, `${name}.aiff`);
  const wav = join(directory, `${name}.wav`);
  await run('say', ['-v', 'Thomas', '-o', aiff, phrase]);
  await run('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', aiff, wav]);
  return pcmFromWav(await readFile(wav));
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'parley-replay-'));
  try {
    const first = await voicePcm(directory, 'first', 'Bonjour, je voudrais');
    const second = await voicePcm(directory, 'second', 'a coffee, s’il vous plaît');
    const silence = (ms: number) => new Uint8Array(RATE * ms / 1000 * 2);
    const audio = Buffer.concat([silence(1200), first, silence(1400), second, silence(1200)]);
    const detector = new PauseDetector();
    const key = process.env.SONIOX_API_KEY;
    const stream = key ? new SonioxStream(
      { getTempKey: async () => key, languageHints: ['fr', 'en'] },
      {
        onTranscript: text => process.stdout.write(`transcript ${text}\n`),
        onError: error => process.stderr.write(`Soniox ${error.type}: ${error.message}\n`),
        onState: state => process.stdout.write(`STT ${state}\n`),
      },
    ) : null;
    if (stream) await stream.start();
    else process.stdout.write('STT skipped: SONIOX_API_KEY unset\n');
    for (let offset = 0; offset < audio.byteLength; offset += BYTES_PER_CHUNK) {
      const chunk = audio.subarray(offset, offset + BYTES_PER_CHUNK);
      for (const event of detector.push(pcmBytesToInt16(chunk))) {
        process.stdout.write(`VAD ${event.kind} at ${event.atMs}ms\n`);
      }
      stream?.sendPcm(chunk);
      await sleep(CHUNK_MS);
    }
    await stream?.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
