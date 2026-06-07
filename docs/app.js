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
// Mutex for user-triggered command bursts (UPDATE, Refresh, Reset Logs,
// CALSET, etc.). When set, additional button clicks that would send to
// the port are dropped so two bursts can't interleave on the wire.
let cmdBusy = false;

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
  // During a bootloader firmware update we hand every incoming line to
  // the bootloader exchange's pending promise instead of running it
  // through the application-protocol switch below. Bootloader responses
  // use space-separated payload fields and a different keyword set
  // (BLACK/BLNAK), which wouldn't survive the comma-split anyway.
  if (bootloaderMode) {
    if (bootloaderResolver) {
      try { bootloaderResolver(line); } catch (err) { /* swallow */ }
    }
    return;
  }
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

// Run a command burst exclusively. If another burst is already running,
// the click is dropped (silent no-op). Suppresses the STATE poll for the
// duration so the burst's CONFIG/STATE replies aren't interleaved with
// polled UPDATE responses on the wire.
async function runExclusive(fn) {
  if (cmdBusy) return false;
  cmdBusy = true;
  suppressPoll = true;
  try {
    await fn();
    return true;
  } finally {
    cmdBusy = false;
    suppressPoll = false;
  }
}

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
  await runExclusive(async () => {
    setStatus('Refreshing configuration…');
    await send('CONFIG');
    await sleep(120);
    await send('STATE');
  });
});

revertBtn.addEventListener('click', () => {
  if (!original) return;
  populateInputs(original);
  refreshDirty();
  updateStatus.textContent = 'Reverted to last values read from device.';
  setTimeout(() => { updateStatus.textContent = ''; }, 3000);
});

refreshLogsBtn.addEventListener('click', () => {
  runExclusive(() => send('LOGS'));
});

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
    const aVal = parseInt(a, 16);
    if (!/^[0-9A-F]{1,2}$/.test(a) || aVal === 0x00 || aVal === 0xBB) {
      errors.push('DCN address must be 1–2 hex digits (01–FF). 00 and BB are reserved and not allowed.');
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

  await runExclusive(() => sendUpdates(d));
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
  await runExclusive(() => sendUpdates(dirtyMap()));
});

async function sendUpdates(d) {
  updateBtn.disabled = true;
  updateStatus.textContent = 'Sending updates…';
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
      if (e === '0') {
        // Firmware quirk: with Mobile Mode disabled the SPS-1 expects a
        // single-parameter form. Sending the trailing thresholds/timeout
        // makes it silently reject the entire command.
        await send('MOBSET,0');
      } else {
        const off = parseVoltsMv(inputs.moboff.value);
        const on = parseVoltsMv(inputs.mobon.value);
        const to = parseIntSafe(inputs.mobto.value);
        await send(`MOBSET,${e},${off},${on},${to}`);
      }
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
  await runExclusive(async () => {
    await send('RSTLOGS');
    await sleep(150);
    await send('LOGS');
  });
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

// ============================================================
// Firmware update via bootloader
// ============================================================
//
// The DCN-AVR-EA-Bootloader speaks a different DCN subset than the
// application: addressed frames (/00BB:body:XX\r), space-separated
// payload fields, and a distinct keyword set (BLINFO / BLERASE /
// BLDATA / BLVERIFY / BLRESET, with BLACK / BLNAK responses). See the
// bootloader repo's docs/PROTOCOL.md for the wire-level reference.
//
// We piggy-back on the existing serial connection: the readLoop keeps
// feeding lines into handleLine(), which routes them to bootloaderResolver
// while bootloaderMode is true. STATE polling is suspended for the
// duration of the update.

const BL_TARGET_ADDR = 0xBB;  // SPS-1 bootloader's fixed DCN address
const BL_HOST_ADDR   = 0x00;  // Conventional host address

let bootloaderMode = false;
let bootloaderResolver = null;  // function(line) called for each rx line
let pickedHexText = null;

// ---- CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflect/xorout) ----
function crc16ccittFalse(bytes, crc = 0xFFFF) {
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc;
}

// ---- Intel HEX parser ----
// Returns a Map<absoluteByteAddress, byteValue>. Handles record types
// 0x00 (data) and 0x04 (extended linear address). EOF (0x01) terminates.
// Other types are ignored. Throws on bad checksum or malformed lines.
function parseIntelHex(text) {
  const data = new Map();
  let ext = 0;
  const lines = text.split(/\r?\n/);
  for (let lineno = 0; lineno < lines.length; lineno++) {
    const line = lines[lineno].trim();
    if (!line.startsWith(':')) continue;
    if (line.length < 11 || (line.length - 1) % 2 !== 0) {
      throw new Error(`hex line ${lineno + 1}: malformed`);
    }
    const bytes = [];
    for (let i = 1; i < line.length; i += 2) {
      const b = parseInt(line.substr(i, 2), 16);
      if (!Number.isFinite(b)) throw new Error(`hex line ${lineno + 1}: bad hex digit`);
      bytes.push(b);
    }
    const count = bytes[0];
    const addr16 = (bytes[1] << 8) | bytes[2];
    const rtype = bytes[3];
    if (bytes.length !== 5 + count) {
      throw new Error(`hex line ${lineno + 1}: length mismatch`);
    }
    let sum = 0;
    for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]) & 0xFF;
    if (sum !== 0) throw new Error(`hex line ${lineno + 1}: bad checksum`);
    if (rtype === 0x00) {
      const base = ext + addr16;
      for (let i = 0; i < count; i++) data.set(base + i, bytes[4 + i]);
    } else if (rtype === 0x01) {
      break;
    } else if (rtype === 0x04) {
      ext = ((bytes[4] << 8) | bytes[5]) << 16;
    }
  }
  return data;
}

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');

// Send a bootloader frame on the wire. No response handling — the caller
// is responsible for setting bootloaderResolver if it wants the answer.
async function blSend(body) {
  const frame = `/${hex2(BL_HOST_ADDR)}${hex2(BL_TARGET_ADDR)}:${body}:XX\r`;
  // Long BLDATA frames are noisy in the log — truncate the hex middle.
  const logFrame = body.length > 80
    ? `/${hex2(BL_HOST_ADDR)}${hex2(BL_TARGET_ADDR)}:${body.slice(0, 25)}…[${body.length - 50}B]…${body.slice(-25)}:XX<CR>`
    : frame.replace(/\r/g, '<CR>');
  appendLog(`> ${logFrame}`);
  await writer.write(new TextEncoder().encode(frame));
}

// Send a frame and resolve with the first line matching the device→host
// response prefix. Echoes of our own outbound frame and any other noise
// are silently dropped.
async function blExchange(body, timeoutMs = 5000) {
  if (bootloaderResolver) {
    throw new Error('Concurrent bootloader exchange — protocol bug.');
  }
  const expectedPrefix = `/${hex2(BL_TARGET_ADDR)}${hex2(BL_HOST_ADDR)}:`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bootloaderResolver = null;
      reject(new Error(`Timeout waiting for response to "${body.split(' ')[0]}".`));
    }, timeoutMs);
    bootloaderResolver = (line) => {
      // Ignore the host's own outbound echo and any cross-talk that
      // doesn't look like the device's reply to us.
      if (!line.startsWith(expectedPrefix)) return;
      clearTimeout(timer);
      bootloaderResolver = null;
      resolve(line);
    };
    blSend(body).catch((err) => {
      clearTimeout(timer);
      bootloaderResolver = null;
      reject(err);
    });
  });
}

// Parse "/<from><to>:KEYWORD field1 field2 ...:XX" into {kw, toks}.
// toks does NOT include the keyword itself.
function parseBlResponse(line) {
  const m = line.match(/^\/[0-9A-F]{4}:(.+):[^:]*$/i);
  if (!m) throw new Error(`Malformed bootloader response: ${line}`);
  const tokens = m[1].split(' ');
  return { kw: tokens[0], toks: tokens.slice(1) };
}

async function blInfo() {
  const line = await blExchange('BLINFO', 3000);
  const { kw, toks } = parseBlResponse(line);
  if (kw === 'BLNAK') throw new Error(`BLINFO rejected: ${toks.join(' ')}`);
  if (kw !== 'BLACK' || toks[0] !== 'BLINFO') {
    throw new Error(`Unexpected BLINFO response: ${line}`);
  }
  // Fields per docs/PROTOCOL.md: BLINFO DDDDDD PPPP SSSS EEEE TTTT VVVV C
  return {
    deviceId:  toks[1],
    pageSize:  parseInt(toks[2], 16),
    appStart:  parseInt(toks[3], 16),
    flashEnd:  parseInt(toks[4], 16),
    crcAddr:   parseInt(toks[5], 16),
    blVersion: parseInt(toks[6], 16),
    appValid:  toks[7] === '1',
  };
}

async function blErase(start, end) {
  const line = await blExchange(`BLERASE ${hex4(start)} ${hex4(end)}`, 15000);
  const { kw, toks } = parseBlResponse(line);
  if (kw === 'BLNAK') {
    throw new Error(`BLERASE rejected (${toks[0]} ${toks[1] || ''}). The bootloader will not erase that range — confirm the hex targets the application region.`);
  }
  if (kw !== 'BLACK' || toks[0] !== 'BLERASE') {
    throw new Error(`BLERASE failed: ${line}`);
  }
}

async function blWritePage(addr, seq, pageBytes) {
  let hexStr = '';
  for (let i = 0; i < pageBytes.length; i++) hexStr += hex2(pageBytes[i]);
  const crc = crc16ccittFalse(pageBytes);
  const body = `BLDATA ${hex4(addr)} ${hex2(seq & 0xFF)} ${hexStr} ${hex4(crc)}`;
  const line = await blExchange(body, 5000);
  const { kw, toks } = parseBlResponse(line);
  if (kw === 'BLNAK') {
    throw new Error(`BLDATA rejected at 0x${hex4(addr)} (${toks[0]} ${toks[1] || ''}). The bootloader refused the page.`);
  }
  if (kw !== 'BLACK' || toks[0] !== 'BLDATA' || toks.length < 3) {
    throw new Error(`BLDATA failed at 0x${hex4(addr)}: ${line}`);
  }
  if (parseInt(toks[1], 16) !== addr || parseInt(toks[2], 16) !== (seq & 0xFF)) {
    throw new Error(`BLDATA ack mismatch at 0x${hex4(addr)}: ${line}`);
  }
}

async function blVerify(crc) {
  const line = await blExchange(`BLVERIFY ${hex4(crc)}`, 15000);
  const { kw, toks } = parseBlResponse(line);
  if (kw === 'BLNAK') {
    throw new Error(`BLVERIFY rejected (${toks[0]} ${toks[1] || ''}). The bootloader's recomputed CRC does not match the value we sent — the flash content does not match the source hex.`);
  }
  if (kw !== 'BLACK' || toks[0] !== 'BLVERIFY') {
    throw new Error(`BLVERIFY failed: ${line}`);
  }
}

async function blReset() {
  // Send the reset and don't wait long for the ACK — the bootloader
  // acknowledges then reboots, so even a missed ACK is fine.
  await blSend('BLRESET');
  // Brief settle so the device has time to actually reset before we
  // resume STATE polling.
  await sleep(500);
}

// ---- Orchestrator ----
async function runFirmwareUpdate(hexText) {
  if (!writer || !connected || simulating) {
    throw new Error('Not connected to a real serial port.');
  }

  // Parse the hex first so a malformed file fails before touching the device.
  const sparse = parseIntelHex(hexText);

  // Suspend STATE polling so the bootloader has the wire to itself.
  stopPolling();
  bootloaderMode = true;

  try {
    // 1. Probe the bootloader. This also catches "device isn't actually
    //    in bootloader mode" (switch not at F, or no power-cycle yet).
    updateFwStatus('Probing bootloader (BLINFO)…', 1);
    const info = await blInfo();
    appendLog(
      `! bootloader online: device=${info.deviceId} page=${info.pageSize} ` +
      `app=0x${hex4(info.appStart)}..0x${hex4(info.flashEnd)} ` +
      `crc-addr=0x${hex4(info.crcAddr)} bl=0x${hex4(info.blVersion)} ` +
      `current-app-valid=${info.appValid}`
    );
    updateFwDetail(`Device ID ${info.deviceId}, bootloader v${(info.blVersion >> 8)}.${(info.blVersion & 0xFF).toString().padStart(2, '0')}`);

    // 2. Compute the page-aligned erase range covering the hex content
    //    inside the application region.
    const appAddrs = [...sparse.keys()].filter(
      (a) => a >= info.appStart && a <= info.crcAddr + 1
    );
    if (appAddrs.length === 0) {
      throw new Error(`Hex file contains no bytes in the application region (0x${hex4(info.appStart)}..0x${hex4(info.crcAddr + 1)}). Did you pick the right file?`);
    }
    const page = info.pageSize;
    let eraseStart = Math.floor(Math.min(...appAddrs) / page) * page;
    let eraseEnd = (Math.floor(Math.max(...appAddrs) / page) + 1) * page - 1;
    if (eraseStart < info.appStart) eraseStart = info.appStart;
    if (eraseEnd > info.flashEnd) eraseEnd = info.flashEnd;

    // 3. Compute the expected verify CRC (covers [appStart, crcAddr)).
    //    Bytes outside the hex default to 0xFF, matching what the
    //    bootloader sees in erased flash.
    const bodyLen = info.crcAddr - info.appStart;
    const bodyBytes = new Uint8Array(bodyLen);
    for (let i = 0; i < bodyLen; i++) {
      bodyBytes[i] = sparse.has(info.appStart + i) ? sparse.get(info.appStart + i) : 0xFF;
    }
    const expectedCrc = crc16ccittFalse(bodyBytes);
    const bakedLo = sparse.has(info.crcAddr)     ? sparse.get(info.crcAddr)     : 0xFF;
    const bakedHi = sparse.has(info.crcAddr + 1) ? sparse.get(info.crcAddr + 1) : 0xFF;
    const bakedCrc = bakedLo | (bakedHi << 8);
    if (bakedCrc !== expectedCrc) {
      appendLog(`! note: hex trailer 0x${hex4(bakedCrc)} ≠ recomputed CRC 0x${hex4(expectedCrc)} — using recomputed value (host).`);
    }

    // 4. Erase the application region.
    updateFwStatus(`Erasing 0x${hex4(eraseStart)}..0x${hex4(eraseEnd)}…`, 3);
    await blErase(eraseStart, eraseEnd);

    // 5. Walk the page list and write any page that contains non-FF data.
    const pagePlan = [];
    for (let paddr = eraseStart; paddr <= eraseEnd; paddr += page) {
      const pageBytes = new Uint8Array(page);
      let any = false;
      for (let i = 0; i < page; i++) {
        const b = sparse.get(paddr + i);
        if (b !== undefined) { pageBytes[i] = b; if (b !== 0xFF) any = true; }
        else pageBytes[i] = 0xFF;
      }
      if (any) pagePlan.push({ addr: paddr, bytes: pageBytes });
    }
    const pagesToWrite = pagePlan.length;
    let pagesWritten = 0;
    let seq = 0;
    for (const { addr, bytes } of pagePlan) {
      const pct = 5 + Math.round(85 * pagesWritten / Math.max(1, pagesToWrite));
      updateFwStatus(`Writing page ${pagesWritten + 1} of ${pagesToWrite}…`, pct);
      updateFwDetail(`Page address 0x${hex4(addr)}`);
      await blWritePage(addr, seq, bytes);
      seq = (seq + 1) & 0xFF;
      pagesWritten++;
    }

    // 6. Verify the whole image CRC. The bootloader commits the trailer
    //    on success, which is what lets it boot the new app on the next
    //    reset.
    updateFwStatus('Verifying (BLVERIFY)…', 92);
    updateFwDetail(`Expected CRC 0x${hex4(expectedCrc)}`);
    await blVerify(expectedCrc);

    // 7. Reset. The device reboots; if the operator has returned the
    //    switch to its normal position the new application boots, else
    //    the bootloader stays resident.
    updateFwStatus('Resetting device (BLRESET)…', 98);
    await blReset();
    updateFwStatus('Update complete.', 100);

    return { pagesWritten, expectedCrc, info };
  } finally {
    bootloaderMode = false;
    bootloaderResolver = null;
    // Resume STATE polling shortly. If the operator moved the switch
    // back to the device's normal address, the SPS-1 will start
    // answering UPDATE polls again and the UI will reflect that.
    setTimeout(() => { if (connected) startPolling(); }, 2000);
  }
}

// ---- UI wiring ----
const fwupdateBtn         = $('btn-fwupdate');
const fwupdateModal       = $('fwupdate-modal');
const fwupdateFile        = $('fwupdate-file');
const fwupdateFileinfo    = $('fwupdate-fileinfo');
const fwupdateStart       = $('fwupdate-start');
const fwupdateCancel      = $('fwupdate-cancel');
const fwupdateCloseBtn    = $('fwupdate-close');
const fwupdatePhasePick   = $('fwupdate-phase-pick');
const fwupdatePhaseProg   = $('fwupdate-phase-progress');
const fwupdatePhaseDone   = $('fwupdate-phase-done');
const fwupdateStatus      = $('fwupdate-status');
const fwupdateProgress    = $('fwupdate-progress');
const fwupdateDetail      = $('fwupdate-detail');
const fwupdateResult      = $('fwupdate-result');

function updateFwStatus(msg, pct) {
  if (fwupdateStatus) fwupdateStatus.textContent = msg;
  if (fwupdateProgress && Number.isFinite(pct)) fwupdateProgress.value = pct;
}
function updateFwDetail(msg) {
  if (fwupdateDetail) fwupdateDetail.textContent = msg || '';
}

function resetFwModalState() {
  pickedHexText = null;
  if (fwupdateFile) fwupdateFile.value = '';
  if (fwupdateFileinfo) fwupdateFileinfo.textContent = '';
  if (fwupdateStart) fwupdateStart.disabled = true;
  fwupdatePhasePick.removeAttribute('hidden');
  fwupdatePhaseProg.setAttribute('hidden', '');
  fwupdatePhaseDone.setAttribute('hidden', '');
  updateFwStatus('', 0);
  updateFwDetail('');
}

fwupdateBtn.addEventListener('click', () => {
  if (!connected) {
    updateStatus.textContent = 'Connect to the SPS-1 first.';
    setTimeout(() => { updateStatus.textContent = ''; }, 3000);
    return;
  }
  if (simulating) {
    updateStatus.textContent = 'Firmware update is not available in Simulate mode.';
    setTimeout(() => { updateStatus.textContent = ''; }, 3000);
    return;
  }
  resetFwModalState();
  fwupdateModal.removeAttribute('hidden');
});

fwupdateFile.addEventListener('change', async () => {
  const file = fwupdateFile.files[0];
  if (!file) { pickedHexText = null; fwupdateStart.disabled = true; return; }
  try {
    pickedHexText = await file.text();
    const sparse = parseIntelHex(pickedHexText);
    const addrs = [...sparse.keys()];
    // App-region heuristic — we don't have BLINFO yet so guess 0x1000..0xFFFD.
    // The real bounds get re-checked from BLINFO at update time.
    const inApp = addrs.filter((a) => a >= 0x1000 && a <= 0xFFFD).length;
    const trailerPresent = sparse.has(0xFFFE) || sparse.has(0xFFFF);
    fwupdateFileinfo.innerHTML =
      `<strong>${file.name}</strong> — ${(file.size / 1024).toFixed(1)} KB<br>` +
      `${inApp} bytes in application region (0x1000–0xFFFD)` +
      `${trailerPresent ? ', CRC trailer present at 0xFFFE.' : ', <em>no CRC trailer detected at 0xFFFE — host will compute one</em>.'}`;
    fwupdateStart.disabled = inApp === 0;
    if (inApp === 0) {
      fwupdateFileinfo.innerHTML +=
        `<br><span style="color:var(--danger)">This file has no bytes in the application region. ` +
        `Did you pick the wrong hex?</span>`;
    }
  } catch (err) {
    fwupdateFileinfo.textContent = `Error reading hex: ${err.message}`;
    pickedHexText = null;
    fwupdateStart.disabled = true;
  }
});

fwupdateCancel.addEventListener('click', () => {
  fwupdateModal.setAttribute('hidden', '');
  resetFwModalState();
});

fwupdateCloseBtn.addEventListener('click', () => {
  fwupdateModal.setAttribute('hidden', '');
  resetFwModalState();
});

fwupdateStart.addEventListener('click', async () => {
  if (!pickedHexText) return;
  if (cmdBusy) return;
  cmdBusy = true;
  suppressPoll = true;
  // Disable Cancel during the update — closing mid-flash would corrupt
  // the device. The Close button on the result phase replaces it.
  fwupdateCancel.disabled = true;
  fwupdatePhasePick.setAttribute('hidden', '');
  fwupdatePhaseProg.removeAttribute('hidden');
  updateFwStatus('Starting…', 0);
  try {
    const result = await runFirmwareUpdate(pickedHexText);
    fwupdateResult.innerHTML =
      `<strong style="color:var(--good)">Update succeeded.</strong><br><br>` +
      `Wrote <strong>${result.pagesWritten}</strong> pages. ` +
      `Verify CRC <code>0x${hex4(result.expectedCrc)}</code>. ` +
      `Bootloader v${(result.info.blVersion >> 8)}.${(result.info.blVersion & 0xFF).toString().padStart(2, '0')} ` +
      `committed the trailer and reset the device.<br><br>` +
      `<em>Return the BCD ADDR switch to its normal operating position.</em> ` +
      `The device should resume responding to live state polls within a few ` +
      `seconds. If it does not, power-cycle once more with the switch in the ` +
      `correct position.`;
  } catch (err) {
    fwupdateResult.innerHTML =
      `<strong style="color:var(--danger)">Update failed.</strong><br><br>` +
      `<code>${escapeHtml(err.message)}</code><br><br>` +
      `If the bootloader never answered (timeout on BLINFO), verify:<br>` +
      `&nbsp;&nbsp;1. SPS-1 BCD ADDR switch is at position <strong>F</strong> ` +
      `(15, all four switches on).<br>` +
      `&nbsp;&nbsp;2. The SPS-1 has been power-cycled <em>since</em> the switch ` +
      `was moved.<br>` +
      `&nbsp;&nbsp;3. Exactly one SPS-1 is on the bus.<br><br>` +
      `If the failure happened mid-way (after some pages wrote), the device ` +
      `is in recovery mode: the application CRC will fail, so the bootloader ` +
      `will stay resident on every reset and accept retries. You can simply ` +
      `Close this dialog and start the update again.`;
  } finally {
    fwupdateCancel.disabled = false;
    fwupdatePhaseProg.setAttribute('hidden', '');
    fwupdatePhaseDone.removeAttribute('hidden');
    cmdBusy = false;
    suppressPoll = false;
  }
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
