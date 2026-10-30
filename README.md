# SPS-1 Configuration Tool

A browser-based configuration tool for the **A2Z Tech SPS-1 Smart Power Switch**.
Runs entirely in your browser — no install, no driver, no native helper.

The tool talks to the SPS-1 over a USB serial connection using the
[Web Serial API](https://developer.mozilla.org/docs/Web/API/Web_Serial_API)
and the SPS-1's broadcast DCN command set
(see [DCN_Commands.pdf](DCN_Commands.pdf) for the protocol).

## Features

When a live SPS-1 is found, the tool asks whether you want to **Configure** or
**Test** the device; you can switch between the two views at any time with the
header toggle button.

### Configure mode

- View and edit all configurable parameters:
  - Undervoltage / Overvoltage trip limits
  - Overcurrent limit, auto-reset, reset delay
  - Mobile Mode enable, on/off thresholds, timeout
  - Switch mode (Toggle / Pushbutton)
  - DCN address (hex)
  - Calibration (CALSET) scale and offset, with confirmation gating
- View the power-up switch positions (DCN ADDR and SET switches).
- View fault history (UV / OV / OC trip counts and total ON-time) and reset logs.
- Edits are buffered locally and only sent to the SPS-1 when **UPDATE** is clicked.
- Power-on guard: while the SPS-1 output is enabled, configuration is blocked
  by an overlay that automatically clears when the switch returns to idle.
- All values are shown in user-friendly units (decimal volts, decimal amps,
  ON / OFF, Enabled / Disabled, Pushbutton / Toggle, hex address).

### Test mode

- Live analog-style gauges for input voltage and switch current.
- Status indicators for the power switch and the live power request, plus
  individual Undervoltage / Overvoltage / Overcurrent fault indicators.
- **Toggle Power Request** button that sends a DCN `PWR` command, alternating
  between 0 and 1 on each press (requires Switch Mode = Pushbutton to take
  effect). The switch may be left powered ON while in Test mode.

### Firmware update

- **Firmware update via bootloader** (SPS-1 v2.0 and later): flash a new
  application image over the same serial port using the
  [DCN-AVR-EA-Bootloader](https://github.com/wa2ivd/DCN-AVR-EA-Bootloader)
  protocol. The tool ships with a set of approved firmware images you pick from
  a dropdown, and you can still point it at a custom local `.hex` file instead.
  See the "Firmware Update" section below.

### Simulate

- A **Simulate** button runs the full UI (Configure and Test, including the
  mode prompt) against a simulated device so you can explore the tool without
  hardware. Firmware update is not available in Simulate mode.

## Browser requirements

The Web Serial API is only available in Chromium-based browsers:

- **Supported:** Google Chrome 89+, Microsoft Edge 89+, Brave, Opera, Vivaldi
- **Not supported:** Firefox, Safari (no plans from those vendors)

The page works from an **HTTPS** origin, from **localhost**, or straight from a
local **`file://`** path — Chromium treats `file://` as a secure context, so
`navigator.serial` is available either way. See [Running locally](#running-locally).

## Usage

1. Open the page in Chrome or Edge (hosted, or straight from a local file).
2. Connect a single SPS-1 to a USB serial port and apply input power. When using
   the USB-C port the controller is powered over USB, so a 12 V supply is not
   required just to configure it; the DCN port needs a USB-to-RS-485 adapter and
   a 12 V supply on the SPS-1 input.
3. Click **Connect** and pick the COM port from the browser's port picker.
   The tool checks for an SPS-1 on connect:
   - A **running device** prompts you to choose **Configure** or **Test**.
   - A device in **bootloader mode** shows a "Bootloader Detected" pop-up and
     takes you to the firmware update.
   - If nothing answers, a **"No SPS-1 Found"** pop-up appears — click
     **Disconnect** and try again.
4. (Configure) Edit any parameters; modified fields are highlighted.
5. Click **UPDATE** to send your changes. The tool re-reads the device
   afterwards so you can confirm what was accepted.

Use the header toggle button to switch between the Configure and Test views
once a device is connected.

The SPS-1 only accepts SET commands while the switch is **idle** (DCN Enable
and Local Enable both OFF). If the switch is enabled while the page is open,
a warning overlay appears and clears automatically when it returns to idle.

## Firmware Update

SPS-1 firmware **2.0 and later** runs under the
[DCN-AVR-EA-Bootloader](https://github.com/wa2ivd/DCN-AVR-EA-Bootloader).
This tool can drive a firmware update over the existing serial connection,
no separate utility needed.

### What you need

- The SPS-1 connected to the serial port and powered.
- Physical access to the SPS-1's DCN ADDR switch.
- A firmware image. The tool ships with a set of approved images you can pick
  from a dropdown; if you have your own build, you can instead choose a custom
  `.hex` file from your computer.

### Procedure

1. **Put the SPS-1 in bootloader mode.** Set the DCN ADDR switch to
   position **F**, then power-cycle the SPS-1.
   The bootloader catches the reset and waits for commands instead of
   running the application.
2. **Open this tool**, click **Connect**, and pick the serial port.
   The tool queries the device on connect. When it finds the bootloader
   instead of the application, it shows a **"Bootloader Detected"** pop-up
   and takes you straight to the firmware update — there is no separate
   button to press.
3. Click **Continue** on the pop-up to open the firmware update dialog.
4. In the dialog, pick a firmware version from the **Firmware** dropdown. The
   dropdown lists the images bundled with the tool; choose **Custom file…** to
   reveal a file picker and select your own `.hex` file instead. The tool
   validates the image and shows a summary before enabling the Begin button.
5. Click **Begin Update**. The tool will:
   - Probe the bootloader (BLINFO) to confirm it's responding.
   - Erase the application region.
   - Write the new image page by page (about 2½ minutes for a full
     ~60 KB image at 9600 baud — a progress bar tracks each page).
   - Verify the whole-image CRC (BLVERIFY).
   - Reset the device (BLRESET).
6. **Return the DCN ADDR switch to its normal operating position**, then
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

The static site lives at the repository root, so GitHub Pages can serve it
directly from `main`:

1. Push this repository to GitHub.
2. **Settings → Pages**.
3. Under **Build and deployment**, set:
   - Source: **Deploy from a branch**
   - Branch: **main** / **/ (root)**
4. Save. The page will be live at
   `https://<your-github-username>.github.io/<repo-name>/` within a minute.

That's it — no build step.

## Running locally

You don't need a web server. Chromium treats `file://` as a secure context, so
you can **open `index.html` directly** in Chrome or Edge (double-click it,
or drag it into the browser) and the app runs fine — Connect, Configure, Test,
and custom-file firmware updates all work.

The one caveat is the **bundled** firmware list: those images are loaded with
`fetch()`, which the browser blocks over `file://`. When you open the page as a
file the firmware dropdown falls back to "— No bundled firmware —" and you pick
your `.hex` with **Custom file…**. To get the bundled list, serve the folder
over HTTP with any static server:

```sh
# from the repo root, using the script in package.json
npm run serve

# or with Python
python -m http.server 8000

# or with VS Code: install "Live Server" and click "Go Live"
```

Then visit `http://localhost:<port>/` in Chrome or Edge.

## Files

```
index.html         markup
index.css          styles
app.js             all application logic (Web Serial, protocol, UI)
firmware/
  manifest.json    list of bundled firmware images (file, version, label, …)
  *.hex            bundled bootloader-flashable firmware images
DCN_Commands.pdf   SPS-1 serial protocol reference
README.md
package.json       (only the `serve` script — no runtime dependencies)
```

## License

MIT — see [LICENSE.md](LICENSE.md).
