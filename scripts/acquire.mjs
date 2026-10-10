import { createWriteStream } from 'node:fs';
import { link, mkdir, open, stat, unlink, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import versions from '../versions.json' with { type: 'json' };
import { ROOT, fail, sha256File } from './lib.mjs';
import { inspectArchive } from './archive.mjs';

const require = createRequire(import.meta.url);
const sevenZip = require('7zip-bin');
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function responseEvidence(headers) {
  const evidence = {};
  for (const name of [
    'content-type',
    'content-length',
    'digest',
    'content-digest',
    'x-amz-checksum-sha256',
    'x-goog-hash',
    'etag',
    'last-modified',
  ]) {
    const value = headers.get(name);
    if (value) evidence[name] = value;
  }
  return evidence;
}

function parseSha256Evidence(headers) {
  const direct = headers.get('x-amz-checksum-sha256');
  if (direct) return Buffer.from(direct, 'base64').toString('hex');
  const values = [headers.get('content-digest'), headers.get('digest'), headers.get('x-goog-hash')]
    .filter(Boolean)
    .join(',');
  const encoded = values.match(/(?:sha-256|sha256)=:?(?:\"?)([A-Za-z0-9+/=_-]+):?(?:\"?)/i)?.[1];
  if (!encoded) return null;
  if (/^[a-f0-9]{64}$/i.test(encoded)) return encoded.toLowerCase();
  try {
    const decoded = Buffer.from(encoded, 'base64');
    return decoded.length === 32 ? decoded.toString('hex') : null;
  } catch {
    return null;
  }
}

async function downloadHttps(url, outputPath) {
  const redirects = [];
  let current = new URL(url);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (current.protocol !== 'https:' || current.username || current.password) {
      fail(`Refusing non-HTTPS or credentialed download URL: ${current.origin}`);
    }
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
    if (REDIRECT_CODES.has(response.status)) {
      const location = response.headers.get('location');
      if (!location) fail(`HTTPS redirect from ${current.origin} had no Location header.`);
      const next = new URL(location, current);
      if (next.protocol !== 'https:' || next.username || next.password) {
        fail(`Refusing unsafe download redirect: ${next.origin}`);
      }
      redirects.push({
        status: response.status,
        from: current.origin,
        to: next.origin,
      });
      await response.body?.cancel();
      current = next;
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      fail(`Download returned HTTP ${response.status} from ${current.origin}; expected HTTP 200.`);
    }
    const evidence = responseEvidence(response.headers);
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      await response.body.cancel();
      fail(`Download returned an HTML content type (${contentType}); refusing to save an error page.`);
    }
    const announcedLength = Number(response.headers.get('content-length') ?? 0);
    if (announcedLength > MAX_DOWNLOAD_BYTES) {
      await response.body.cancel();
      fail(`Download exceeds the maximum permitted size (${MAX_DOWNLOAD_BYTES} bytes).`);
    }
    let downloadedBytes = 0;
    const limitedBody = async function* () {
      for await (const chunk of response.body) {
        downloadedBytes += chunk.length;
        if (downloadedBytes > MAX_DOWNLOAD_BYTES) {
          throw new Error(`Download exceeds the maximum permitted size (${MAX_DOWNLOAD_BYTES} bytes).`);
        }
        yield chunk;
      }
    };
    try {
      await pipeline(Readable.from(limitedBody()), createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }));
    } catch (error) {
      throw new Error(`Download stream failed: ${error.message}`);
    }
    if (announcedLength && downloadedBytes !== announcedLength) {
      fail(`Download length mismatch: server announced ${announcedLength} bytes, received ${downloadedBytes}.`);
    }
    return {
      finalUrl: current.toString(),
      status: response.status,
      headers: evidence,
      redirects,
      serverSha256: parseSha256Evidence(response.headers),
      size: downloadedBytes,
    };
  }
  fail('Download exceeded the redirect limit.');
}

async function checkAuthenticode(filePath) {
  const executable = process.env.OSSLSIGNCODE_BIN || 'osslsigncode';
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(executable, ['verify', '-in', filePath], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error?.code === 'ENOENT') {
    return {
      status: 'unavailable',
      detail: 'osslsigncode was not installed; the installer publisher signature was not verified.',
    };
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(0, 4000);
  return {
    status: result.status === 0 ? 'valid-signature-unverified-publisher' : 'failed',
    detail: output.replaceAll(filePath, path.basename(filePath)).trim(),
  };
}

async function main() {
  const inspection = path.join(ROOT, 'inspection');
  const filename = versions.installer.filename;
  const target = path.join(inspection, filename);
  const provenancePath = `${target}.provenance.json`;
  await mkdir(inspection, { recursive: true, mode: 0o700 });
  if (await stat(target).catch(() => null)) fail(`Refusing to overwrite existing installer input: ${target}`);
  if (await stat(provenancePath).catch(() => null)) fail(`Refusing to overwrite existing provenance record: ${provenancePath}`);

  const temporaryPath = path.join(inspection, `.${filename}.${randomUUID()}.partial`);
  const temporaryProvenance = `${temporaryPath}.provenance`;
  try {
    const transfer = await downloadHttps(versions.installer.url, temporaryPath);
    const actualStat = await stat(temporaryPath);
    if (actualStat.size < 1024 * 1024) fail(`Downloaded installer is unexpectedly small (${actualStat.size} bytes).`);
    if (!/^(?:application\/(?:octet-stream|x-msdownload)|binary\/octet-stream)/i.test(transfer.headers['content-type'] ?? '')) {
      fail(`Unexpected installer content type: ${transfer.headers['content-type'] ?? '<missing>'}.`);
    }
    const handle = await open(temporaryPath, 'r');
    let header;
    try {
      header = Buffer.alloc(2);
      const { bytesRead } = await handle.read(header, 0, 2, 0);
      if (bytesRead !== 2) fail('Downloaded input is truncated before the Windows PE header.');
    } finally {
      await handle.close();
    }
    if (header.toString('ascii') !== 'MZ') fail('Downloaded input does not begin with a Windows PE MZ header.');
    const sha256 = await sha256File(temporaryPath);
    if (transfer.serverSha256 && transfer.serverSha256 !== sha256) {
      fail(`Server-published SHA-256 mismatch: expected ${transfer.serverSha256}, got ${sha256}.`);
    }
    const { entries } = await inspectArchive(temporaryPath);
    const signature = await checkAuthenticode(temporaryPath);
    if (signature.status === 'failed') fail(`Installer Authenticode verification failed: ${signature.detail}`);
    const provenance = {
      acquisitionUrl: versions.installer.url,
      requestedVersion: versions.factory,
      filename,
      downloadedAt: new Date().toISOString(),
      status: transfer.status,
      finalUrl: transfer.finalUrl,
      redirects: transfer.redirects,
      responseHeaders: transfer.headers,
      size: actualStat.size,
      sha256,
      serverSha256: transfer.serverSha256,
      archiveEntryCount: entries.length,
      publisherSignature: signature,
      note: 'A locally computed SHA-256 does not establish publisher authenticity. Treat missing publisher verification as unresolved.',
    };
    await writeFile(temporaryProvenance, `${JSON.stringify(provenance, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await link(temporaryPath, target);
    try {
      await link(temporaryProvenance, provenancePath);
    } catch (error) {
      const published = await stat(target).catch(() => null);
      const temporary = await stat(temporaryPath).catch(() => null);
      if (published && temporary && published.ino === temporary.ino && published.dev === temporary.dev) {
        await unlink(target);
      }
      throw error;
    }
    await unlink(temporaryPath);
    await unlink(temporaryProvenance);
    console.log(`Acquired ${filename} (${actualStat.size} bytes, SHA-256 ${sha256}).`);
    console.log(`HTTP ${transfer.status}; content type ${transfer.headers['content-type']}; redirects ${transfer.redirects.length}.`);
    console.log(`Publisher signature evidence: ${signature.status}.`);
    console.log(`Provenance: ${path.relative(ROOT, provenancePath)}.`);
  } finally {
    await unlink(temporaryPath).catch(() => {});
    await unlink(temporaryProvenance).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`acquire: ${error.message}`);
  process.exitCode = 1;
});
