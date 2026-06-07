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
- **Firmware update via bootloader** (SPS-1 v2.0 and later): flash a new
  application image over the same serial port using the
  [DCN-AVR-EA-Bootloader](https://github.com/wa2ivd/DCN-AVR-EA-Bootloader)
  protocol. See the "Firmware Update" section below.

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

## Firmware Update

SPS-1 firmware **2.0 and later** runs under the
[DCN-AVR-EA-Bootloader](https://github.com/wa2ivd/DCN-AVR-EA-Bootloader).
This tool can drive a firmware update over the existing serial connection,
no separate utility needed.

### What you need

- An `SPS-1.X.production_BL.hex` file from the firmware build (the
  bootloader-compatible image with a CRC trailer at `0xFFFE` — **not** the
  raw `.hex`).
- The SPS-1 connected to the serial port and powered.
- Physical access to the SPS-1's BCD ADDR switch.

### Procedure

1. **Put the SPS-1 in bootloader mode.** Set the BCD ADDR switch to
   position **F** (15, all four switches ON), then power-cycle the SPS-1.
   The bootloader catches the reset and waits for commands instead of
   running the application.
2. **Open this tool**, click **Connect**, and pick the serial port.
   (The live state and config sections will be empty because the
   application isn't running — that's expected.)
3. **Scroll to the "Firmware Update" section** and click
   **Update Firmware…**.
4. In the modal that opens, click the file picker and choose the
   `SPS-1.X.production_BL.hex` file.
5. Click **Begin Update**. The tool will:
   - Probe the bootloader (BLINFO) to confirm it's responding.
   - Erase the application region.
   - Write the new image page by page (about 2½ minutes for a full
     ~60 KB image at 9600 baud — a progress bar tracks each page).
   - Verify the whole-image CRC (BLVERIFY).
   - Reset the device (BLRESET).
6. **Return the BCD ADDR switch to its normal operating position**, then
   close the dialog. The new application boots on the next reset.

### Safety notes

- Do not close the page, disconnect the cable, or power off the SPS-1
  during the update. A partial flash leaves the device with no valid
  application; the bootloader will stay resident on every reset, so
  recovery is "set switch to F, power-cycle, run the update again" —
  but only if you can get back to a known starting point.
- The bootloader will only commit the new CRC trailer on a successful
  BLVERIFY. If verification fails, the previous CRC trailer stays in
  place and the device boots as before — but the application region's
  flash is whatever the partial write left behind, which may not match
  the previous image either. Always re-flash a known-good image after
  any failure.
- Firmware update is **not available in Simulate mode** — the bootloader
  protocol requires a real serial connection to a real device.

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
