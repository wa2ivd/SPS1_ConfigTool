// SPS-1 Configuration Tool — browser app
//
// All commands sent in broadcast format (//CMD,P1,P2<CR>). Responses arrive
// as /fftt:MSGTYPE,...:XX<CR>. The SPS-1 does not acknowledge commands; we
// confirm by re-querying CONFIG / STATE / LOGS.
//
// Requires a Chromium-based browser (Chrome / Edge / Brave / Opera) for the
// Web Serial API. Must be served over HTTPS or localhost — file:// URLs
// don't expose navigator.serial.

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);

const connectBtn = $('connect');
const disconnectBtn = $('disconnect');
const statusEl = $('status');
const mainEl = $('main');
const logEl = $('log');
const toggleLogBtn = $('btn-toggle-log');

const welcomeModal = $('welcome-modal');
const welcomeContinue = $('welcome-continue');
const unsupportedModal = $('unsupported-modal');

const powerWarning = $('power-warning');
const pwPower = $('pw-power');

const calsetModal = $('confirm-calset');
const calsetDiff = $('calset-diff');
const calsetCancel = $('calset-cancel');
const calsetConfirm = $('calset-confirm');

const rstlogsModal = $('confirm-rstlogs');
const rstlogsCancel = $('rstlogs-cancel');
const rstlogsConfirm = $('rstlogs-confirm');

const updateBtn = $('btn-update');
const revertBtn = $('btn-revert');
const refreshBtn = $('btn-refresh');
const updateStatus = $('update-status');
const refreshLogsBtn = $('btn-refresh-logs');
const resetLogsBtn = $('btn-reset-logs');

// State display
const stV = $('state-voltage');
const stA = $('state-current');
const stPwr = $('state-power');
const stSwitch = $('state-switch');
const stFault = $('state-fault');
const stRetries = $('state-retries');
const stWd = $('state-wd');
const stFwver = $('state-fwver');
const stAddrSw = $('state-addrsw');
const stSetSw = $('state-setsw');

// Logs display
const logOnTime = $('log-ontime');
const logUv = $('log-uv');
const logOv = $('log-ov');
const logOc = $('log-oc');

// Config inputs
const inputs = {
  uvset: $('cfg-uvset'),     // volts
  ovset: $('cfg-ovset'),     // volts
  ocset: $('cfg-ocset'),     // amps
  ocauto: $('cfg-ocauto'),   // 0/1
  ocdelay: $('cfg-ocdelay'), // seconds
  moben: $('cfg-moben'),     // 0/1
  moboff: $('cfg-moboff'),   // volts
  mobon: $('cfg-mobon'),     // volts
  mobto: $('cfg-mobto'),     // minutes
  swmode: $('cfg-swmode'),   // 0/1
  addr: $('cfg-addr'),       // hex string
  cal: $('cfg-cal'),         // float
  ofst: $('cfg-ofst'),       // integer mA
};

// ---------- Browser support check ----------
if (!('serial' in navigator)) {
  welcomeModal.setAttribute('hidden', '');
  unsupportedModal.removeAttribute('hidden');
}

// ---------- Serial state ----------
let port = null;
let reader = null;
let writer = null;
let readableStreamClosed = null;
let lineBuffer = '';
let pollTimer = null;
let connected = false;
// Set while a multi-step command sequence is running so the STATE
// poll doesn't interleave between e.g. OCSET and the follow-up CONFIG.
let suppressPoll = false;

let original = null;

// ---------- Logging ----------
const setStatus = (text) => { statusEl.textContent = text; };
const appendLog = (line) => {
  const div = document.createElement('div');
  div.textContent = line;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  while (logEl.childElementCount > 500) logEl.removeChild(logEl.firstChild);
};

toggleLogBtn.addEventListener('click', () => {
  const hidden = logEl.hasAttribute('hidden');
  if (hidden) { logEl.removeAttribute('hidden'); toggleLogBtn.textContent = 'hide'; }
  else { logEl.setAttribute('hidden', ''); toggleLogBtn.textContent = 'show'; }
});

// ---------- Welcome flow ----------
welcomeContinue.addEventListener('click', () => {
  welcomeModal.setAttribute('hidden', '');
  connectBtn.disabled = false;
  setStatus('Ready — click Connect to choose serial port.');
});

// ---------- Serial open / close ----------
async function openPort() {
  setStatus('Selecting port…');
  // Browser shows its built-in port picker. Returns a SerialPort or throws
  // if the user dismisses the picker.
  const selected = await navigator.serial.requestPort();
  setStatus('Opening port at 9600 baud…');
  await selected.open({ baudRate: 9600 });
  port = selected;
  writer = port.writable.getWriter();
  connected = true;
  connectBtn.disabled = true;
  disconnectBtn.disabled = false;
  setStatus('Connected. Querying SPS-1…');
  readLoop();
  await initialQueries();
  startPolling();
}

async function closePort() {
  stopPolling();
  connected = false;
  try {
    if (reader) { await reader.cancel().catch(() => {}); reader = null; }
    if (readableStreamClosed) { await readableStreamClosed; readableStreamClosed = null; }
    if (writer) { try { writer.releaseLock(); } catch { /* */ } writer = null; }
    if (port) { await port.close(); port = null; }
  } catch (err) {
    appendLog(`! close error: ${err.message}`);
  }
  setStatus('Disconnected');
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  mainEl.setAttribute('hidden', '');
  powerWarning.setAttribute('hidden', '');
}

connectBtn.addEventListener('click', async () => {
  try { await openPort(); }
  catch (err) {
    setStatus(`Error: ${err.message}`);
    connected = false;
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
  }
});
disconnectBtn.addEventListener('click', closePort);

// ---------- Read loop & line parsing ----------
async function readLoop() {
  const decoder = new TextDecoderStream();
  readableStreamClosed = port.readable.pipeTo(decoder.writable).catch(() => {});
  reader = decoder.readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      lineBuffer += value;
      // Device terminates with CR; tolerate either CR or LF or CRLF.
      let m;
      while ((m = lineBuffer.search(/[\r\n]/)) !== -1) {
        const line = lineBuffer.slice(0, m);
        let drop = 1;
        if ((lineBuffer[m] === '\r' && lineBuffer[m + 1] === '\n') ||
            (lineBuffer[m] === '\n' && lineBuffer[m + 1] === '\r')) drop = 2;
        lineBuffer = lineBuffer.slice(m + drop);
        if (line.length) handleLine(line);
      }
    }
  } catch (err) {
    appendLog(`! read error: ${err.message}`);
    if (connected) {
      setStatus(`Connection lost: ${err.message}. Cleaning up — click Connect to retry.`);
      stopPolling();
      connected = false;
      try { writer && writer.releaseLock(); } catch { /* */ }
      writer = null;
      try { port && await port.close(); } catch { /* */ }
      port = null;
      reader = null;
      readableStreamClosed = null;
      mainEl.setAttribute('hidden', '');
      powerWarning.setAttribute('hidden', '');
      connectBtn.disabled = false;
      disconnectBtn.disabled = true;
    }
  }
}

async function send(cmd) {
  if (!writer || !connected) return;
  const text = `//${cmd}\r`;
  appendLog(`> ${text.replace(/\r/g, '<CR>')}`);
  try {
    await writer.write(new TextEncoder().encode(text));
  } catch (err) {
    appendLog(`! write error: ${err.message}`);
  }
}

// ---------- Protocol parser ----------
function handleLine(line) {
  appendLog(`< ${line}`);
  const m = line.match(/^\/[0-9A-Fa-f]{2,4}:(.+):[^:]*$/);
  if (!m) return;
  const fields = m[1].split(',');
  const type = fields[0];
  switch (type) {
    case 'UPDATE':   handleUpdate(fields); break;
    case 'SETTINGS': handleSettings(fields); break;
    case 'HISTORY':  handleHistory(fields); break;
    case 'FWVER':    handleVersion(fields); break;
  }
}

// UPDATE,SPS1,R,P,FS,r,V,A,WD
// R = combined Power Request (1 if Local OR DCN request is on)
// P = output power switch state. Can differ from R during fault conditions
//     (e.g. R=1 but P=0 if a UV/OV/OC fault is preventing output).
// SET commands are only processed when R=0 (idle).
function handleUpdate(f) {
  const R  = f[2];
  const P  = f[3];
  const FS = (f[4] || '').trim();
  const r  = f[5];
  const V  = f[6];
  const A  = f[7];
  const WD = f[8];
  const idle = R === '0';

  stV.textContent = `${V} V`;
  stA.textContent = `${A} A`;
  stPwr.textContent = R === '1' ? 'ON' : 'OFF';
  stPwr.className = `value ${R === '1' ? 'bad' : 'good'}`;
  stSwitch.textContent = P === '1' ? 'ON' : 'OFF';
  stSwitch.className = `value ${P === '1' ? 'bad' : 'good'}`;
  stFault.textContent = FS === '' ? 'None' :
                        FS === 'UV' ? 'Undervoltage' :
                        FS === 'OV' ? 'Overvoltage' :
                        FS === 'OC' ? 'Overcurrent' : FS;
  stFault.className = `value ${FS === '' ? 'good' : 'bad'}`;
  stRetries.textContent = r ?? '—';
  stWd.textContent = WD === 'WD' ? 'WATCHDOG RESET' : 'OK';
  stWd.className = `value ${WD === 'WD' ? 'bad' : 'good'}`;

  pwPower.textContent = R === '1' ? 'ON' : 'OFF';
  if (!idle) powerWarning.removeAttribute('hidden');
  else powerWarning.setAttribute('hidden', '');
}

// SETTINGS,SPS1,xx,uuuuu,ooooo,ccccc,a,t,m,moff,mon,mto,cal,ofst,s,y,z
// y = physical DCN ADDR switch position at power-up (hex)
// z = physical SET switch position at power-up
function handleSettings(f) {
  const cfg = {
    addr: (f[2] || '').toUpperCase().padStart(2, '0'),
    uvset_mv: parseInt(f[3], 10),
    ovset_mv: parseInt(f[4], 10),
    ocset_ma: parseInt(f[5], 10),
    ocauto: f[6],
    ocdelay: parseInt(f[7], 10),
    moben: f[8],
    moboff_mv: parseInt(f[9], 10),
    mobon_mv: parseInt(f[10], 10),
    mobto: parseInt(f[11], 10),
    cal: parseFloat(f[12]),
    ofst: parseInt(f[13], 10),
    swmode: f[14],
    addrSw: (f[15] || '').trim(),
    setSw:  (f[16] || '').trim(),
  };
  original = cfg;
  populateInputs(cfg);
  stAddrSw.textContent = cfg.addrSw ? cfg.addrSw.toUpperCase().padStart(2, '0') : '—';
  stSetSw.textContent  = cfg.setSw || '—';
  mainEl.removeAttribute('hidden');
  setStatus(`Connected — DCN address ${cfg.addr}`);
  refreshDirty();
}

// FWVER,SPS1,<ver>  (V1.1+; older firmware won't respond and the field
// stays as the default "—".)
function handleVersion(f) {
  const ver = (f[2] || '').trim();
  stFwver.textContent = ver || '—';
}

// HISTORY,SPS1,tot,uv,ov,oc
function handleHistory(f) {
  const tot = parseInt(f[2], 10);
  const uv  = f[3];
  const ov  = f[4];
  const oc  = f[5];
  logOnTime.textContent = formatOnTime(tot);
  logUv.textContent = uv;
  logOv.textContent = ov;
  logOc.textContent = oc;
}

function formatOnTime(tenths) {
  if (!Number.isFinite(tenths)) return '—';
  const totalSec = tenths / 10;
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = (totalSec % 60).toFixed(1);
  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

// ---------- Populate inputs from config ----------
function populateInputs(cfg) {
  inputs.uvset.value = (cfg.uvset_mv / 1000).toFixed(3);
  inputs.ovset.value = (cfg.ovset_mv / 1000).toFixed(3);
  inputs.ocset.value = (cfg.ocset_ma / 1000).toFixed(3);
  inputs.ocauto.value = cfg.ocauto;
  inputs.ocdelay.value = String(cfg.ocdelay);
  inputs.moben.value = cfg.moben;
  inputs.moboff.value = (cfg.moboff_mv / 1000).toFixed(3);
  inputs.mobon.value = (cfg.mobon_mv / 1000).toFixed(3);
  inputs.mobto.value = String(cfg.mobto);
  inputs.swmode.value = cfg.swmode;
  inputs.addr.value = cfg.addr;
  inputs.cal.value = String(cfg.cal);
  inputs.ofst.value = String(cfg.ofst);
}

// ---------- Dirty tracking ----------
const dirtyMap = () => {
  if (!original) return {};
  return {
    uvset:   parseVoltsMv(inputs.uvset.value)   !== original.uvset_mv,
    ovset:   parseVoltsMv(inputs.ovset.value)   !== original.ovset_mv,
    ocset:   parseAmpsMa(inputs.ocset.value)    !== original.ocset_ma,
    ocauto:  inputs.ocauto.value                !== original.ocauto,
    ocdelay: parseIntSafe(inputs.ocdelay.value) !== original.ocdelay,
    moben:   inputs.moben.value                 !== original.moben,
    moboff:  parseVoltsMv(inputs.moboff.value)  !== original.moboff_mv,
    mobon:   parseVoltsMv(inputs.mobon.value)   !== original.mobon_mv,
    mobto:   parseIntSafe(inputs.mobto.value)   !== original.mobto,
    swmode:  inputs.swmode.value                !== original.swmode,
    addr:    (inputs.addr.value || '').toUpperCase().padStart(2, '0') !== original.addr,
    cal:     parseFloat(inputs.cal.value)       !== original.cal,
    ofst:    parseIntSafe(inputs.ofst.value)    !== original.ofst,
  };
};

function refreshDirty() {
  const d = dirtyMap();
  for (const k of Object.keys(inputs)) {
    if (d[k]) inputs[k].classList.add('dirty');
    else inputs[k].classList.remove('dirty');
  }
}

for (const el of Object.values(inputs)) {
  el.addEventListener('input', refreshDirty);
  el.addEventListener('change', refreshDirty);
}

// ---------- Helpers ----------
const parseVoltsMv = (s) => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? Math.round(v * 1000) : NaN;
};
const parseAmpsMa = (s) => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? Math.round(v * 1000) : NaN;
};
const parseIntSafe = (s) => {
  const v = parseInt(s, 10);
  return Number.isFinite(v) ? v : NaN;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Initial queries / polling ----------
async function initialQueries() {
  suppressPoll = true;
  try {
    await send('CONFIG');
    await sleep(150);
    await send('STATE');
    await sleep(150);
    await send('LOGS');
    await sleep(150);
    await send('VERSION');

    // If we don't get a SETTINGS reply within 3 s, surface an error.
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (original) return;
      await sleep(100);
    }
    if (!original) {
      setStatus('No response from SPS-1 — verify wiring, power, and that only one unit is connected.');
    }
  } finally {
    suppressPoll = false;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (connected && !suppressPoll) send('STATE');
  }, 1500);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ---------- Refresh / revert buttons ----------
refreshBtn.addEventListener('click', async () => {
  setStatus('Refreshing configuration…');
  await send('CONFIG');
  await sleep(120);
  await send('STATE');
});

revertBtn.addEventListener('click', () => {
  if (!original) return;
  populateInputs(original);
  refreshDirty();
  updateStatus.textContent = 'Reverted to last values read from device.';
  setTimeout(() => { updateStatus.textContent = ''; }, 3000);
});

refreshLogsBtn.addEventListener('click', () => send('LOGS'));

// ---------- UPDATE flow ----------
function validateInputs(d) {
  const errors = [];
  if (d.uvset) {
    const mv = parseVoltsMv(inputs.uvset.value);
    if (!(mv >= 6000 && mv <= 18000)) errors.push('Undervoltage limit must be 6.000–18.000 V.');
  }
  if (d.ovset) {
    const mv = parseVoltsMv(inputs.ovset.value);
    if (!(mv >= 6000 && mv <= 18000)) errors.push('Overvoltage limit must be 6.000–18.000 V.');
  }
  if (d.ocset) {
    const ma = parseAmpsMa(inputs.ocset.value);
    if (!(ma >= 5000 && ma <= 35000)) errors.push('Overcurrent limit must be 5.000–35.000 A.');
  }
  if (d.ocdelay) {
    const t = parseIntSafe(inputs.ocdelay.value);
    if (!(Number.isInteger(t) && t >= 0)) errors.push('OC reset delay must be a non-negative whole number of seconds.');
  }
  if (d.moboff) {
    const moff = parseVoltsMv(inputs.moboff.value);
    const uv = parseVoltsMv(inputs.uvset.value);
    if (Number.isFinite(moff) && Number.isFinite(uv) && moff < uv + 1000) {
      errors.push('Mobile-mode Off threshold must be at least 1.000 V above the undervoltage limit.');
    }
  }
  if (d.mobon) {
    const mon = parseVoltsMv(inputs.mobon.value);
    const ov = parseVoltsMv(inputs.ovset.value);
    if (Number.isFinite(mon) && Number.isFinite(ov) && mon > ov - 1000) {
      errors.push('Mobile-mode On threshold must be at least 1.000 V below the overvoltage limit.');
    }
  }
  if (d.mobto) {
    const t = parseIntSafe(inputs.mobto.value);
    if (!(Number.isInteger(t) && t >= 1 && t <= 100)) errors.push('Mobile-mode timeout must be 1–100 minutes.');
  }
  if (d.addr) {
    const a = (inputs.addr.value || '').toUpperCase();
    if (!/^[0-9A-F]{1,2}$/.test(a) || parseInt(a, 16) === 0) {
      errors.push('DCN address must be 1–2 hex digits (01–FF). 00 is not allowed.');
    }
  }
  if (d.cal) {
    const c = parseFloat(inputs.cal.value);
    if (!(Number.isFinite(c) && c > 0)) errors.push('Calibration scale must be a positive number.');
  }
  if (d.ofst) {
    const o = parseIntSafe(inputs.ofst.value);
    if (!Number.isInteger(o)) errors.push('Calibration offset must be an integer (mA).');
  }
  return errors;
}

updateBtn.addEventListener('click', async () => {
  if (!original) return;
  const d = dirtyMap();
  const anyDirty = Object.values(d).some(Boolean);
  if (!anyDirty) {
    updateStatus.textContent = 'No changes to send.';
    setTimeout(() => { updateStatus.textContent = ''; }, 2500);
    return;
  }
  const errors = validateInputs(d);
  if (errors.length) {
    updateStatus.textContent = errors.join(' ');
    return;
  }

  if (d.cal || d.ofst) {
    const lines = [];
    if (d.cal)  lines.push(`Scale:  ${original.cal}  →  ${parseFloat(inputs.cal.value)}`);
    if (d.ofst) lines.push(`Offset: ${original.ofst} mA  →  ${parseIntSafe(inputs.ofst.value)} mA`);
    calsetDiff.textContent = lines.join('\n');
    calsetModal.removeAttribute('hidden');
    return;
  }

  await sendUpdates(d);
});

calsetCancel.addEventListener('click', () => {
  calsetModal.setAttribute('hidden', '');
  if (original) {
    inputs.cal.value = String(original.cal);
    inputs.ofst.value = String(original.ofst);
  }
  refreshDirty();
  updateStatus.textContent = 'Update cancelled — calibration values restored.';
  setTimeout(() => { updateStatus.textContent = ''; }, 4000);
});

calsetConfirm.addEventListener('click', async () => {
  calsetModal.setAttribute('hidden', '');
  await sendUpdates(dirtyMap());
});

async function sendUpdates(d) {
  updateBtn.disabled = true;
  updateStatus.textContent = 'Sending updates…';
  suppressPoll = true;
  try {
    if (d.uvset)  await send(`UVSET,${parseVoltsMv(inputs.uvset.value)}`);
    await sleep(80);
    if (d.ovset)  await send(`OVSET,${parseVoltsMv(inputs.ovset.value)}`);
    await sleep(80);

    if (d.ocset || d.ocauto || d.ocdelay) {
      const ma = parseAmpsMa(inputs.ocset.value);
      const a = inputs.ocauto.value;
      const t = parseIntSafe(inputs.ocdelay.value);
      await send(`OCSET,${ma},${a},${t}`);
      await sleep(80);
    }

    if (d.moben || d.moboff || d.mobon || d.mobto) {
      const e = inputs.moben.value;
      const off = parseVoltsMv(inputs.moboff.value);
      const on = parseVoltsMv(inputs.mobon.value);
      const to = parseIntSafe(inputs.mobto.value);
      await send(`MOBSET,${e},${off},${on},${to}`);
      await sleep(80);
    }

    if (d.swmode) await send(`SWMODE,${inputs.swmode.value}`);
    await sleep(80);
    if (d.addr) {
      const a = (inputs.addr.value || '').toUpperCase().padStart(2, '0');
      await send(`SETADDR,${a}`);
      await sleep(80);
    }

    if (d.cal || d.ofst) {
      const scale = parseFloat(inputs.cal.value).toFixed(3);
      const ofst = parseIntSafe(inputs.ofst.value);
      await send(`CALSET,${scale},${ofst}`);
      await sleep(80);
    }

    // Re-query so the on-screen values reflect what the device accepted.
    // Commands silently fail if the switch isn't idle, so this is how
    // the user sees what stuck. Longer initial pause gives the SPS-1
    // time to commit EEPROM writes.
    await sleep(400);
    await send('CONFIG');
    await sleep(150);
    await send('STATE');
  } finally {
    suppressPoll = false;
    updateBtn.disabled = false;
  }
  updateStatus.textContent = 'Update sent. Re-reading from device…';
  setTimeout(() => {
    updateStatus.textContent = original ? 'Values shown below reflect device state.' : '';
    setTimeout(() => { updateStatus.textContent = ''; }, 3000);
  }, 600);
}

// ---------- RESET LOGS flow ----------
resetLogsBtn.addEventListener('click', () => {
  rstlogsModal.removeAttribute('hidden');
});
rstlogsCancel.addEventListener('click', () => {
  rstlogsModal.setAttribute('hidden', '');
});
rstlogsConfirm.addEventListener('click', async () => {
  rstlogsModal.setAttribute('hidden', '');
  await send('RSTLOGS');
  await sleep(150);
  await send('LOGS');
});
