# Test the Linux desktop build through Steam

This is a local test workflow. Adding the build as a non-Steam game costs nothing, does not publish it, and does not require a Steamworks account or App ID.

## Add the packaged game

1. Close any running desktop game, then build the Electron package with `npm run electron:pack`.
2. From the repository root, confirm that this file exists and is executable:

   `release/electron/tiki-taka-1.1.1-x86_64.AppImage`

3. Launch Steam normally in the same desktop session as the controller.
4. Choose **Games → Add a Non-Steam Game to My Library**.
5. Choose **Browse**, select the AppImage above, then choose **Add Selected Programs**.
6. Open the shortcut's **Properties** and set its name to **Tiki Taka**. Keep the target as the absolute AppImage path and the start-in directory as:

   `<repository>/release/electron`

7. Do not force a Proton compatibility tool. This is a native Linux x64 build.

For a stable shortcut target across package versions, select `scripts/launch-desktop.sh` using its absolute path in your clone. Choose **All Files** if Steam hides shell scripts. The launcher resolves its own package path and inherits Steam's environment.

The versioned filename changes when the package version changes. Update the Steam shortcut target after building a different version. The unpacked executable at `release/electron/linux-unpacked/tiki-taka` is also runnable, but it depends on every adjacent file in `linux-unpacked`; do not copy that executable by itself.

## Use a generic controller

1. Connect the controller before starting the game and confirm Steam detects it under **Steam → Settings → Controller**.
2. Open the Tiki Taka library shortcut's controller settings and enable Steam Input for the shortcut if it is not already enabled.
3. Start with Steam's **Gamepad** template. Steam Input legacy mode presents the remapped device to the game as a conventional gamepad; Tiki Taka does not need the Steam Input API for this local test.
4. Launch Tiki Taka from its Steam library entry. Steam Input configuration is associated with that shortcut, so launching the AppImage directly can produce different controller behavior.
5. Verify the left stick and D-pad navigate, **A** selects or passes, **B** goes back, **X** makes a wall pass during play, the left trigger holds Focus, and **Start** pauses.

If the overlay or input behaves poorly under native Wayland, add `--ozone-platform=x11` to the shortcut's launch options and retest through XWayland. Leave the default launch options empty when native Wayland works. Do not add `--no-sandbox`; Electron documents that flag for testing only, and this host supports the Chromium namespace sandbox.

## Troubleshoot a launch that produces no window

If the shortcut starts and no window ever appears, open the Steam console output and look for this line:

`FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:213] Zygote process exited prematurely with exit code -1`

The matching symptom is a game that never draws a window, a process that ignores `SIGTERM`, and a Steam library entry stuck reporting that the game is still running. Steam itself then has to be force-killed.

The cause is the Chromium sandbox helper. `electron-builder` writes `release/electron/linux-unpacked/chrome-sandbox` owned by the building user with mode `0755` and no setuid bit. Launched directly, Electron uses the Chromium namespace sandbox and the helper is never needed. Launched through Steam, Electron falls back to the setuid sandbox helper, the helper is not setuid-root, and the zygote process dies before any window is created.

Fix it from the repository root:

```sh
sudo chown root:root release/electron/linux-unpacked/chrome-sandbox
sudo chmod 4755 release/electron/linux-unpacked/chrome-sandbox
```

`scripts/launch-desktop.sh` prints a warning to stderr when the helper is not setuid-root, and still launches the game. The warning is the reminder to run the two commands above; it does not change how the game starts.

Three things to keep in mind:

- `npm run electron:pack` recreates `chrome-sandbox` with the default ownership and mode. Reapply both commands after every repackage.
- The AppImage extracts itself to a temporary directory at runtime, so a setuid bit cannot persist inside it. Point Steam shortcuts at `scripts/launch-desktop.sh`, which runs the unpacked build, rather than at the AppImage.
- `--no-sandbox` is a diagnostic only. Adding it to the launch options confirms that the sandbox is the cause, because the window then appears. This does not change the guidance above to leave `--no-sandbox` out of the shortcut: remove it as soon as it has confirmed the diagnosis, and fix the helper's ownership and mode instead.

## Scope of this test

The non-Steam shortcut provides local launching and lets you configure Steam Input. Overlay and controller behavior depend on Steam, the display session, and the device; they need a hands-on test. It does not publish the game, provide downloads or updates, or prove Steam ownership.
