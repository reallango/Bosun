'use strict';

/**
 * How Ollama is installed on a host, from the `@@INSTALL` block the `ollama` probe prints after the API
 * answers (key=value lines). Plain CommonJS so the poller's collectors and the web app share it. Pure.
 *
 * kind:
 *  - 'docker'    Ollama runs (or ran) as a Docker container          { container, image, state, restartPolicy }
 *  - 'service'   a service manager runs it                          { manager: 'nssm'|'windows'|'systemd', name, state, startMode, exe? }
 *  - 'standard'  installed, but not as a service (tray app, manual) { path? }
 *  - 'none'      not installed (or not found)
 * `dockerAvailable` (Linux) says whether Docker can be used to install it.
 */

const SERVICE_NAME_RE = /^[A-Za-z0-9_.@-]{1,64}$/;
const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

function keyValues(text) {
  const kv = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) kv[m[1]] = m[2].trim();
  }
  return kv;
}

/** Windows service start types: Auto and delayed auto are told apart by SVC_DELAYED. */
function windowsStartMode(kv) {
  const s = String(kv.SVC_START || '').toLowerCase();
  if (s === 'auto' && String(kv.SVC_DELAYED || '').toLowerCase() === 'true') return 'delayed';
  if (s === 'auto') return 'auto';
  if (s === 'disabled') return 'disabled';
  return 'manual';
}

/**
 * @param {string} text the lines after `@@INSTALL`
 * @param {boolean} apiUp whether the Ollama API answered
 */
function parseInstall(text, apiUp) {
  const kv = keyValues(text);
  const dockerAvailable = kv.DOCKER_AVAILABLE === '1';
  const base = { dockerAvailable };

  if (kv.DOCKER_NAME && CONTAINER_RE.test(kv.DOCKER_NAME) && !(kv.UNIT && kv.UNIT_ACTIVE === 'active' && kv.DOCKER_STATE !== 'running')) {
    return {
      ...base, kind: 'docker', container: kv.DOCKER_NAME, image: kv.DOCKER_IMAGE || '', state: kv.DOCKER_STATE || 'unknown',
      restartPolicy: kv.DOCKER_RESTART || 'no',
    };
  }
  if (kv.UNIT && SERVICE_NAME_RE.test(kv.UNIT)) {
    const enabled = kv.UNIT_ENABLED || '';
    return {
      ...base, kind: 'service', manager: 'systemd', name: kv.UNIT,
      state: kv.UNIT_ACTIVE === 'active' ? 'running' : kv.UNIT_ACTIVE === 'failed' ? 'failed' : 'stopped',
      startMode: enabled === 'enabled' ? 'enabled' : enabled === 'disabled' ? 'disabled' : enabled || 'unknown',
    };
  }
  if (kv.SVC_NAME && SERVICE_NAME_RE.test(kv.SVC_NAME)) {
    return {
      ...base, kind: 'service', manager: kv.SVC_WRAPPER === 'nssm' ? 'nssm' : 'windows', name: kv.SVC_NAME,
      state: /^running$/i.test(kv.SVC_STATE || '') ? 'running' : 'stopped', startMode: windowsStartMode(kv), exe: kv.SVC_EXE || '',
    };
  }
  if (kv.HOST_BIN || kv.STANDARD_PATH || apiUp) {
    return { ...base, kind: 'standard', path: kv.HOST_BIN || kv.STANDARD_PATH || '' };
  }
  return { ...base, kind: 'none' };
}

module.exports = { parseInstall, keyValues, SERVICE_NAME_RE, CONTAINER_RE };
