# SPS-1 Configuration Tool

A browser-based configuration tool for the **A2Z Tech SPS-1 Smart Power Switch**.
Runs entirely in your browser — no install, no driver, no native helper.

The tool talks to the SPS-1 over a USB serial connection using the
[Web Serial API](https://developer.mozilla.org/docs/Web/API/Web_Serial_API)
and the SPS-1's broadcast DCN command set
(see [DCN_Commands.pdf](DCN_Commands.pdf) for the protocol).

## Features

- View live state: input voltage, switch current, enable inputs, fault status, watchdog.
- View and edit all configurable parameters:
  - Undervoltage / Overvoltage trip limits
  - Overcurrent limit, auto-reset, reset delay
  - Mobile Mode enable, on/off thresholds, timeout
  - Switch mode (Toggle / Pushbutton)
  - DCN address (hex)
  - Calibration (CALSET) scale and offset, with confirmation gating
- View fault history (UV / OV / OC trip counts and total ON-time) and reset logs.
- Edits are buffered locally and only sent to the SPS-1 when **UPDATE** is clicked.
- Power-on guard: while the SPS-1 output is enabled, configuration is blocked
  by an overlay that automatically clears when the switch returns to idle.
- All values are shown in user-friendly units (decimal volts, decimal amps,
  ON / OFF, Enabled / Disabled, Pushbutton / Toggle, hex address).

## Browser requirements

The Web Serial API is only available in Chromium-based browsers:

- **Supported:** Google Chrome 89+, Microsoft Edge 89+, Brave, Opera, Vivaldi
- **Not supported:** Firefox, Safari (no plans from those vendors)

The page must be served over **HTTPS** or **localhost** — `file://` URLs cannot
access serial ports.

## Usage

1. Open the hosted page in Chrome or Edge.
2. Connect a single SPS-1 to a USB serial port and apply input power.
3. Click **Connect** and pick the COM port from the browser's port picker.
4. Edit any parameters; modified fields are highlighted.
5. Click **UPDATE** to send your changes. The tool re-reads the device
   afterwards so you can confirm what was accepted.

The SPS-1 only accepts SET commands while the switch is **idle** (DCN Enable
and Local Enable both OFF). If the switch is enabled while the page is open,
a warning overlay appears and clears automatically when it returns to idle.

## Hosting on GitHub Pages

The static site lives in [`docs/`](docs/) so GitHub Pages can serve it
directly from `main`:

1. Push this repository to GitHub.
2. **Settings → Pages**.
3. Under **Build and deployment**, set:
   - Source: **Deploy from a branch**
   - Branch: **main** / **/docs**
4. Save. The page will be live at
   `https://<your-github-username>.github.io/<repo-name>/` within a minute.

That's it — no build step.

## Running locally

Web Serial requires a real HTTP origin, so opening `docs/index.html` directly
won't work. Pick any static server:

```sh
# from the repo root, using the script in package.json
npm run serve

# or with Python
cd docs && python -m http.server 8000

# or with VS Code: install "Live Server" and click "Go Live"
```

Then visit `http://localhost:<port>/` in Chrome or Edge.

## Files

```
docs/
  index.html   markup
  index.css    styles
  app.js       all application logic (Web Serial, protocol, UI)
DCN_Commands.pdf   SPS-1 serial protocol reference
README.md
package.json   (only the `serve` script — no runtime dependencies)
```

## License

MIT — see [package.json](package.json).
