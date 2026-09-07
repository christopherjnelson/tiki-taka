# Test the Linux desktop build through Steam

This is a local test workflow. Adding the build as a non-Steam game costs nothing, does not publish it, and does not require a Steamworks account or App ID.

## Add the packaged game

1. Close any running desktop game, then build the Electron package with `npm run electron:pack`.
2. From the repository root, confirm that this file exists and is executable:

   `release/electron/tiki-taka-1.0.0-x86_64.AppImage`

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

## Scope of this test

The non-Steam shortcut provides local launching and lets you configure Steam Input. Overlay and controller behavior depend on Steam, the display session, and the device; they need a hands-on test. It does not publish the game, provide downloads or updates, or prove Steam ownership.
