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
const simulateBtn = $('simulate');
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

// Mobile Mode bar graph
const mvbarUv = $('mvbar-uv');
const mvbarOff = $('mvbar-off');
const mvbarOk = $('mvbar-ok');
const mvbarOn = $('mvbar-on');
const mvbarOv = $('mvbar-ov');
const VGRAPH_MIN = 6;   // volts at the left edge of the graph
const VGRAPH_MAX = 18;  // volts at the right edge of the graph

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
// True when the UI is driven by the built-in simulator instead of a real
// serial port. `connected` is also true in this mode so the rest of the
// app (send / poll / handleLine) works unchanged.
let simulating = false;
// Set while a multi-step command sequence is running so the STATE
// poll doesn't interleave between e.g. OCSET and the follow-up CONFIG.
let suppressPoll = false;

let original = null;
// Address of the SPS-1 we're currently talking to, taken from the "from"
// field of received messages. Authoritative — may differ from both the
// physical DCN ADDR switch and the EEPROM-stored address.
let connectedAddr = null;

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
  simulateBtn.disabled = false;
  setStatus('Ready — click Connect to choose serial port, or Simulate to try the UI without one.');
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
  simulateBtn.disabled = true;
  disconnectBtn.disabled = false;
  setStatus('Connected. Querying SPS-1…');
  readLoop();
  await initialQueries();
  startPolling();
}

async function closePort() {
  stopPolling();
  if (simulating) {
    simulating = false;
    connected = false;
    connectedAddr = null;
    original = null;
    appendLog('! simulation ended');
    setStatus('Simulation ended');
    connectBtn.disabled = false;
    simulateBtn.disabled = false;
    disconnectBtn.disabled = true;
    mainEl.setAttribute('hidden', '');
    powerWarning.setAttribute('hidden', '');
    return;
  }
  connected = false;
  connectedAddr = null;
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
  simulateBtn.disabled = false;
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
      simulateBtn.disabled = false;
      disconnectBtn.disabled = true;
    }
  }
}

async function send(cmd) {
  if (simulating) { simulateSend(cmd); return; }
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
  const m = line.match(/^\/([0-9A-Fa-f]{2,4}):(.+):[^:]*$/);
  if (!m) return;
  // First 2 hex digits of the prefix are the "from" address — the actual
  // address of the SPS that sent this reply. The remaining digits (if any)
  // are the "to" address echoed from the command we sent.
  const fromAddr = m[1].slice(0, 2).toUpperCase();
  if (fromAddr !== connectedAddr) {
    connectedAddr = fromAddr;
    if (connected) setStatus(`${simulating ? 'Simulating' : 'Connected'} — DCN address ${connectedAddr}`);
  }
  const fields = m[2].split(',');
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
  setStatus(`${simulating ? 'Simulating' : 'Connected'} — DCN address ${connectedAddr || cfg.addr}`);
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
  updateMobileGraph();
}

// ---------- Mobile Mode bar graph ----------
// The graph spans a fixed 6–18 V range. pctOf() maps a voltage to its
// horizontal position (0–100%) on that span.
const VGRAPH_SPAN = VGRAPH_MAX - VGRAPH_MIN;
const clampV = (v) => Math.min(Math.max(v, VGRAPH_MIN), VGRAPH_MAX);
const pctOf = (v) => ((v - VGRAPH_MIN) / VGRAPH_SPAN) * 100;

// Mobile Mode: red up to the UV limit, yellow from UV to the Off
// threshold, green from Off to On, light blue from On to the OV limit,
// red from the OV limit to the right edge.
function updateMobileGraph() {
  let uv = parseFloat(inputs.uvset.value);
  let ov = parseFloat(inputs.ovset.value);
  let off = parseFloat(inputs.moboff.value);
  let on = parseFloat(inputs.mobon.value);
  uv = clampV(Number.isFinite(uv) ? uv : VGRAPH_MIN);
  ov = clampV(Number.isFinite(ov) ? ov : VGRAPH_MAX);
  off = clampV(Number.isFinite(off) ? off : uv);
  on = clampV(Number.isFinite(on) ? on : ov);
  // Enforce left-to-right ordering: uv ≤ off ≤ on ≤ ov.
  if (off < uv) off = uv;
  if (on < off) on = off;
  if (ov < on) ov = on;
  const uvPct = pctOf(uv);
  const offPct = pctOf(off) - uvPct;
  const onPct = pctOf(on) - pctOf(off);
  const ovPct = 100 - pctOf(ov);
  mvbarUv.style.width = `${uvPct}%`;
  mvbarOff.style.width = `${offPct}%`;
  mvbarOn.style.width = `${onPct}%`;
  mvbarOv.style.width = `${ovPct}%`;
  mvbarOk.style.width = `${100 - uvPct - offPct - onPct - ovPct}%`;
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

// Keep the bar graph in sync as the setpoints it depends on are edited.
for (const key of ['uvset', 'ovset', 'moboff', 'mobon']) {
  inputs[key].addEventListener('input', updateMobileGraph);
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
  if (simulating) {
    updateStatus.textContent = 'Simulate mode — Refresh has no effect.';
    setTimeout(() => { updateStatus.textContent = ''; }, 3000);
    return;
  }
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
  if (simulating) {
    updateStatus.textContent = 'Simulate mode — UPDATE has no effect.';
    setTimeout(() => { updateStatus.textContent = ''; }, 3000);
    return;
  }
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

// ---------- Simulate mode ----------
// Drives the UI from an in-memory fake device so the tool can be exercised
// without an SPS-1 attached. simulateSend() intercepts outbound commands,
// mutates simState, and schedules synthesized replies through handleLine()
// — so polling, refresh, UPDATE, and RSTLOGS all flow through the same
// code paths as a real connection.
const simState = {};

function resetSimState() {
  Object.assign(simState, {
    addr: 'FF',
    uvset_mv: 10700,
    ovset_mv: 15000,
    ocset_ma: 12000,
    ocauto: '0',
    ocdelay: 30,
    moben: '0',
    moboff_mv: 12500,
    mobon_mv: 13500,
    mobto: 10,
    cal: 26.5,
    ofst: 0,
    swmode: '1',
    addrSw: 'FF',
    setSw: '0',
    // Live state. SET commands are only honored when R='0' (idle),
    // matching real-device behavior.
    R: '0', P: '0', FS: '', r: '0', V: '13.200', A: '0.000', WD: '',
    // History counters
    histTot: 12345,
    histUv: '2',
    histOv: '0',
    histOc: '1',
  });
}

function simRespond(payload) {
  // Real device replies are /<from><to>:PAYLOAD:<cksum>. handleLine
  // ignores anything after the final colon, so a fixed "00" is fine.
  const line = `/${simState.addr}:${payload}:00`;
  // Small async hop so the "> //CMD" log appears before "< /..".
  setTimeout(() => handleLine(line), 10);
}

function simulateSend(cmd) {
  appendLog(`> //${cmd}<CR>`);
  const parts = cmd.split(',');
  const verb = parts[0];
  const idle = simState.R === '0';

  switch (verb) {
    case 'CONFIG':
      simRespond(
        `SETTINGS,SPS1,${simState.addr},${simState.uvset_mv},${simState.ovset_mv},` +
        `${simState.ocset_ma},${simState.ocauto},${simState.ocdelay},` +
        `${simState.moben},${simState.moboff_mv},${simState.mobon_mv},${simState.mobto},` +
        `${simState.cal.toFixed(3)},${simState.ofst},${simState.swmode},` +
        `${simState.addrSw},${simState.setSw}`
      );
      return;
    case 'STATE':
      // Tiny jitter on voltage so the display looks live.
      simState.V = (13.20 + (Math.random() - 0.5) * 0.04).toFixed(3);
      simRespond(
        `UPDATE,SPS1,${simState.R},${simState.P},${simState.FS},${simState.r},` +
        `${simState.V},${simState.A},${simState.WD}`
      );
      return;
    case 'LOGS':
      simRespond(`HISTORY,SPS1,${simState.histTot},${simState.histUv},${simState.histOv},${simState.histOc}`);
      return;
    case 'VERSION':
      simRespond('FWVER,SPS1,V1.2 (SIM)');
      return;
    case 'UVSET':
      if (idle) simState.uvset_mv = parseInt(parts[1], 10);
      return;
    case 'OVSET':
      if (idle) simState.ovset_mv = parseInt(parts[1], 10);
      return;
    case 'OCSET':
      if (idle) {
        simState.ocset_ma = parseInt(parts[1], 10);
        simState.ocauto = parts[2];
        simState.ocdelay = parseInt(parts[3], 10);
      }
      return;
    case 'MOBSET':
      if (idle) {
        simState.moben = parts[1];
        simState.moboff_mv = parseInt(parts[2], 10);
        simState.mobon_mv = parseInt(parts[3], 10);
        simState.mobto = parseInt(parts[4], 10);
      }
      return;
    case 'SWMODE':
      if (idle) simState.swmode = parts[1];
      return;
    case 'SETADDR':
      if (idle) simState.addr = (parts[1] || '').toUpperCase().padStart(2, '0');
      return;
    case 'CALSET':
      if (idle) {
        simState.cal = parseFloat(parts[1]);
        simState.ofst = parseInt(parts[2], 10);
      }
      return;
    case 'RSTLOGS':
      simState.histUv = '0';
      simState.histOv = '0';
      simState.histOc = '0';
      return;
  }
}

simulateBtn.addEventListener('click', async () => {
  resetSimState();
  simulating = true;
  connected = true;
  connectedAddr = null;
  original = null;
  connectBtn.disabled = true;
  simulateBtn.disabled = true;
  disconnectBtn.disabled = false;
  setStatus('Simulating SPS-1 — no device connected');
  appendLog('! simulate mode started');
  await initialQueries();
  startPolling();
});
