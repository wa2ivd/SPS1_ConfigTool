const connectBtn = document.getElementById('connect');
const disconnectBtn = document.getElementById('disconnect');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const chooser = document.getElementById('port-chooser');
const chooserList = document.getElementById('port-chooser-list');
const chooserCancel = document.getElementById('port-chooser-cancel');

let port = null;
let reader = null;
let writer = null;
let readableStreamClosed = null;

const setStatus = (text) => {
  statusEl.textContent = text;
};

const appendLog = (line) => {
  const div = document.createElement('div');
  div.textContent = line;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
};

const formatPort = (p) => {
  const name = p.portName;
  const label = p.displayName;
  const isComPort = name && /^COM\d+/i.test(name);
  if (isComPort && label) return `${name} — ${label}`;
  if (isComPort) return name;
  return label || name || p.portId || '(unknown)';
};

let scanning = false;

const showChooser = () => {
  chooser.hidden = false;
};

const renderPorts = (ports) => {
  chooserList.innerHTML = '';
  if (!ports.length) {
    const li = document.createElement('li');
    li.textContent = scanning ? 'Scanning for ports…' : 'No serial ports detected.';
    chooserList.appendChild(li);
    return;
  }
  scanning = false;
  for (const p of ports) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.textContent = formatPort(p);
    btn.addEventListener('click', () => {
      chooser.hidden = true;
      window.api.selectPort(p.portId);
    });
    li.appendChild(btn);
    chooserList.appendChild(li);
  }
};

window.api.onPortList((ports) => {
  renderPorts(ports);
  showChooser();
});

chooserCancel.addEventListener('click', () => {
  chooser.hidden = true;
  window.api.selectPort('');
});

async function readLoop() {
  const decoder = new TextDecoderStream();
  readableStreamClosed = port.readable.pipeTo(decoder.writable).catch(() => {});
  reader = decoder.readable.getReader();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.length) appendLog(`< ${line}`);
      }
    }
  } catch (err) {
    appendLog(`! read error: ${err.message}`);
  }
}

connectBtn.addEventListener('click', async () => {
  try {
    setStatus('Selecting port…');
    scanning = true;
    renderPorts([]);
    showChooser();
    const selected = await navigator.serial.requestPort();
    setStatus('Opening…');
    await selected.open({ baudRate: 9600 });
    port = selected;
    writer = port.writable.getWriter();
    const info = port.getInfo();
    const idStr = info.usbVendorId !== undefined
      ? ` VID=${info.usbVendorId.toString(16).padStart(4, '0')} PID=${info.usbProductId.toString(16).padStart(4, '0')}`
      : '';
    setStatus(`Connected${idStr}`);
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    readLoop();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
});

disconnectBtn.addEventListener('click', async () => {
  try {
    if (reader) {
      await reader.cancel().catch(() => {});
      reader = null;
    }
    if (readableStreamClosed) {
      await readableStreamClosed;
      readableStreamClosed = null;
    }
    if (writer) {
      try { writer.releaseLock(); } catch { /* already released */ }
      writer = null;
    }
    if (port) {
      await port.close();
      port = null;
    }
    setStatus('Disconnected');
  } catch (err) {
    setStatus(`Error on close: ${err.message}`);
  } finally {
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
  }
});
