'use strict';

/**
 * Data collectors for database-defined ("custom") widgets.
 *
 * Dependency-free CommonJS so the Next.js widget route (TypeScript) and the
 * root poller.js can share one implementation, exactly like the built-in
 * `linux/collectors` and `windows/collectors` modules.
 *
 * A custom widget is a row in `custom_widgets`; this module owns the code that
 * knows how to collect data for each custom widget *type*. Types without an
 * entry here have no collector and are reported as unsupported by the caller.
 *
 *   getCustomWidgetData(type, { platform, run, runPS, cfg })
 *     run(cmd)      -> { stdout, stderr, exitCode }   (Linux)
 *     runPS(script) -> { stdout, stderr, exitCode }   (Windows; caller wraps
 *                       the script with powershellCommand)
 */

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

// Only the host/port/path subset is accepted, so a value from widget config can
// never smuggle shell metacharacters into the command line.
const URL_RE = /^https?:\/\/[A-Za-z0-9._-]+(?::\d+)?(?:\/[A-Za-z0-9._~/-]*)?$/;

function normalizeBaseUrl(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/\/+$/, '');
  return URL_RE.test(s) ? s : DEFAULT_OLLAMA_URL;
}

function parseJson(text) {
  let s = (text || '').trim();
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function bytesToGB(bytes) {
  return bytes > 0 ? Math.round((bytes / 1e9) * 100) / 100 : 0;
}

function summarizeAvailable(models) {
  return (Array.isArray(models) ? models : []).map((m) => {
    const details = m.details || {};
    return {
      name: m.name || m.model || 'unknown',
      sizeBytes: m.size || 0,
      sizeGB: bytesToGB(m.size || 0),
      family: details.family || '',
      parameterSize: details.parameter_size || '',
      quantization: details.quantization_level || '',
      modifiedAt: m.modified_at || null,
    };
  });
}

function summarizeLoaded(models) {
  return (Array.isArray(models) ? models : []).map((m) => {
    const total = m.size || 0;
    const vram = m.size_vram || 0;
    const cpu = Math.max(total - vram, 0);
    const details = m.details || {};
    return {
      name: m.name || m.model || 'unknown',
      sizeBytes: total,
      sizeGB: bytesToGB(total),
      vramBytes: vram,
      vramGB: bytesToGB(vram),
      cpuBytes: cpu,
      cpuGB: bytesToGB(cpu),
      expiresAt: m.expires_at || null,
      family: details.family || '',
      parameterSize: details.parameter_size || '',
      quantization: details.quantization_level || '',
    };
  });
}

function emptyOllama(status, baseUrl) {
  return {
    status,
    baseUrl,
    available: [],
    loaded: [],
    memory: { totalBytes: 0, totalGB: 0, gpuBytes: 0, gpuGB: 0, cpuBytes: 0, cpuGB: 0 },
    cpuGpuRatio: { cpuPercent: 0, gpuPercent: 0 },
    models: [],
  };
}

/**
 * Ollama reports each loaded model's total size and the portion resident in
 * VRAM (`size_vram`). The remainder is the CPU-resident portion, which is the
 * CPU/GPU split the widget surfaces.
 */
function buildOllamaResult(baseUrl, tagsJson, psJson) {
  const available = summarizeAvailable(tagsJson && tagsJson.models);
  const loaded = summarizeLoaded(psJson && psJson.models);

  const totalBytes = loaded.reduce((a, m) => a + m.sizeBytes, 0);
  const gpuBytes = loaded.reduce((a, m) => a + m.vramBytes, 0);
  const cpuBytes = loaded.reduce((a, m) => a + m.cpuBytes, 0);
  const cpuPercent = totalBytes > 0 ? Math.round((cpuBytes / totalBytes) * 1000) / 10 : 0;
  const gpuPercent = totalBytes > 0 ? Math.round((gpuBytes / totalBytes) * 1000) / 10 : 0;

  return {
    status: 'running',
    baseUrl,
    available,
    loaded,
    memory: {
      totalBytes,
      totalGB: bytesToGB(totalBytes),
      gpuBytes,
      gpuGB: bytesToGB(gpuBytes),
      cpuBytes,
      cpuGB: bytesToGB(cpuBytes),
    },
    cpuGpuRatio: { cpuPercent, gpuPercent },
    models: available,
  };
}

async function ollamaLinux(run, cfg) {
  const baseUrl = normalizeBaseUrl(cfg.baseUrl);
  const tagsR = await run(`curl -s --max-time 5 '${baseUrl}/api/tags' 2>/dev/null`);
  if (tagsR.exitCode !== 0 || !tagsR.stdout.trim()) return emptyOllama('stopped', baseUrl);
  const tags = parseJson(tagsR.stdout);
  if (!tags) return emptyOllama('error', baseUrl);

  const psR = await run(`curl -s --max-time 5 '${baseUrl}/api/ps' 2>/dev/null`);
  return buildOllamaResult(baseUrl, tags, parseJson(psR.stdout));
}

async function ollamaWindows(runPS, cfg) {
  const baseUrl = normalizeBaseUrl(cfg.baseUrl);
  const prefix = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ';
  const fetchJson = (path) =>
    runPS(`${prefix}try { Invoke-RestMethod -Uri '${baseUrl}${path}' -TimeoutSec 5 | ConvertTo-Json -Compress -Depth 8 } catch {}`);

  const tagsR = await fetchJson('/api/tags');
  const tags = parseJson(tagsR.stdout);
  if (!tags) return emptyOllama('stopped', baseUrl);

  const psR = await fetchJson('/api/ps');
  return buildOllamaResult(baseUrl, tags, parseJson(psR.stdout));
}

/** Custom widget types that have a collector here. */
const CUSTOM_WIDGET_DATA_TYPES = ['ollama_status'];

async function getCustomWidgetData(type, ctx) {
  const { platform, run, runPS, cfg = {} } = ctx;
  switch (type) {
    case 'ollama_status':
      return platform === 'windows' ? ollamaWindows(runPS, cfg) : ollamaLinux(run, cfg);
    default:
      return undefined;
  }
}

module.exports = {
  getCustomWidgetData,
  CUSTOM_WIDGET_DATA_TYPES,
  normalizeBaseUrl,
};
