# Easy Remote Keyboard

Low-bandwidth remote keyboard control for a focused Windows or macOS app.

This project has three parts:

- A relay. Both apps use it to find each other and forward tiny keyboard packets.
- A combined Windows/macOS app. At launch, choose **Host** or **Guest**.
- Host mode locks to one foreground target window/app and injects approved remote key events.
- Guest mode sends keyboard down/up events from a native low-level keyboard hook.
- Two-way mode lets both computers keep local keyboard input while also mirroring it to the other computer.
- Optional mouse sharing can be enabled with the **Share mouse** checkbox.

Video is intentionally out of scope; use Discord, Meet, OBS, or another stream for visuals.

## Download

Download the latest app from the GitHub releases page:

https://github.com/Adityaki37/easy-remote-keyboard/releases/latest

Use:

- `EasyRemoteKeyboard-Windows-GUI.exe` for Windows.
- `EasyRemoteKeyboard-macOS-AppleSilicon-GUI.zip` for Apple Silicon Macs.
- `EasyRemoteKeyboard-macOS-Intel-GUI.zip` for Intel Macs.

The app asks whether this computer should be **Host**, **Guest**, or **Two-way** when it starts.

Mouse sharing is off by default. Turn on **Share mouse** before starting a session if you want to send or accept mouse movement, buttons, and wheel input.

The sidebar shows **Relay ping** and **Input lag** while connected. Relay ping is the round trip to the relay server. Input lag is measured from a sent keyboard/mouse packet until the other computer acknowledges receiving and processing it.

## Run Locally

```powershell
npm install
npm start
```

In another terminal on the PC/Mac that will be host:

```powershell
$env:RELAY_URL="ws://localhost:8787/ws"
npm run app
```

Choose `Host`.
Open/focus the target app, then press Enter in the host. Share the room code printed by the host.

On your friend's PC/Mac:

```powershell
$env:RELAY_URL="ws://your-relay-host:8787/ws"
npm run app
```

Choose `Guest`. The guest enters the room code and their name. Once you approve them, their keyboard is captured and sent to your host app. `Ctrl+Alt+F12` toggles guest capture.

For two-way keyboard mirroring:

```powershell
$env:RELAY_URL="ws://your-relay-host:8787/ws"
npm run app
```

Both people choose `Two-way`. One chooses `create`, the other chooses `join`. Each person focuses their own local app/game when prompted. After approval, both physical keyboards continue working locally and are also sent to the other computer.

Windows and macOS apps can be mixed freely because the relay protocol is the same:

- Windows guest -> Windows host
- macOS guest -> Windows host
- Windows guest -> macOS host
- macOS guest -> macOS host

For testing on another network, deploy the server folder to a Node host that supports WebSockets and set:

```powershell
$env:PUBLIC_BASE_URL="https://your-domain.example"
$env:RELAY_URL="wss://your-domain.example/ws"
```

## Host Commands

- `p` then Enter: pause input and release held remote keys.
- `r` then Enter: resume input.
- `d` then Enter: disconnect the friend.
- `q` then Enter: release held keys and quit.

## Guest Controls

- `Ctrl+Alt+F12`: toggle capture.
- Closing the guest window stops capture and releases held keys on the host.
- While capture is active, allowed keys are suppressed locally on the guest PC.
- If **Share mouse** is enabled, mouse input is captured too; leave it off for keyboard-only sessions.

## Two-Way Controls

- `Ctrl+Alt+F12` or `c` then Enter: toggle sending your local keyboard to the other computer.
- `q` then Enter: quit and release remote-held keys.
- Two-way mode does not suppress local keys; your keyboard still controls your own focused app.
- If **Share mouse** is enabled, local mouse input also stays local and is mirrored to the other computer.

## macOS Permissions

macOS requires privacy permissions for native input tools:

- Guest app: grant **Input Monitoring** so it can capture the keyboard and optional mouse input.
- Host app: grant **Accessibility** so it can post keyboard/mouse events and check the frontmost app.

After changing permissions, restart the app.

## Safety Defaults

- Host approval is required for every friend session.
- Remote input only works while the selected target window remains foreground.
- Remote-held keys are released on pause, disconnect, focus loss, timeout, and quit.
- Dangerous/system combos are blocked by default, including Windows keys, Alt+Tab, Ctrl+Esc, Ctrl+Alt+Delete, and Ctrl+Shift+Esc.
- A conservative key allowlist is used. Override it with comma-separated browser `KeyboardEvent.code` values:

```powershell
$env:ALLOW_KEYS="KeyW,KeyA,KeyS,KeyD,Space,ShiftLeft,ControlLeft,Escape"
npm run host
```

## Build The Apps

```powershell
npm run build:desktop -- win
```

The Windows GUI output is a portable `.exe` in `release/`.

macOS GUI builds must be produced on macOS:

```bash
npm run build:desktop -- mac
```

The macOS GUI outputs are zip files in `release/`.

Legacy split-role debug builds are also available:

- `dist/easy-remote-keyboard-host.exe`
- `dist/easy-remote-keyboard-guest.exe`
- `dist/easy-remote-keyboard-host-macos-x64`
- `dist/easy-remote-keyboard-host-macos-arm64`
- `dist/easy-remote-keyboard-guest-macos-x64`
- `dist/easy-remote-keyboard-guest-macos-arm64`

These MVP executables are unsigned. Windows may warn on first run. macOS requires at least ad-hoc signing before launch:

```bash
tar -xzf easy-remote-keyboard-macos-arm64.tar.gz
cd EasyRemoteKeyboard-macos-arm64
./run.command
```

Use the `x64` files for Intel Macs and the `arm64` files for Apple Silicon Macs.

## Current Limitations

- Windows x64 and macOS x64/arm64 only.
- Keyboard support is always available; mouse sharing is optional and disabled by default.
- Uses WebSocket relay for the first implementation. The input layer is intentionally separate so a WebRTC transport can replace it later.
- `SendInput` cannot control secure desktop, UAC prompts, Ctrl+Alt+Del, or higher-integrity/elevated apps unless the host is also elevated.
- Release binaries are unsigned/not notarized. Windows SmartScreen and macOS Gatekeeper may warn on first launch.
- Do not use with competitive games or anti-cheat-protected games unless the game explicitly allows remote input tools.
