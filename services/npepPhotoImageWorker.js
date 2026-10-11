import {parentPort, workerData} from 'node:worker_threads';
import jpeg from 'jpeg-js';
try {
  const raw = jpeg.decode(Buffer.from(workerData), {tolerantDecoding: false, maxResolutionInMP: 2, maxMemoryUsageInMB: 64});
  if (raw.width < 1 || raw.height < 1 || Math.max(raw.width, raw.height) > 1280) throw new Error('dimensions');
  let bytes;
  for (const quality of [80, 60, 40]) {
    // Re-encode pixels, never preserve EXIF, comments or opaque uploaded metadata.
    bytes = jpeg.encode({width: raw.width, height: raw.height, data: raw.data}, quality).data;
    if (bytes.length <= 262144) break;
  }
  if (bytes.length > 262144) throw new Error('size');
  parentPort.postMessage({bytes, width: raw.width, height: raw.height});
} catch { parentPort.postMessage({error: true}); }
