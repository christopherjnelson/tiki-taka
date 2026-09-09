import { app, BrowserWindow, Menu, net, protocol, session } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "tiki",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
app.enableSandbox();
app.setName("tiki-taka");
const userDataPath =
  process.env.TIKI_TAKA_USER_DATA ||
  path.join(app.getPath("appData"), "tiki-taka");
mkdirSync(userDataPath, { recursive: true });
app.setPath("userData", userDataPath);

const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const desktopRoot = app.isPackaged
  ? path.join(process.resourcesPath, "desktop")
  : path.join(sourceRoot, "dist", "desktop");

function resolveDesktopAsset(requestUrl) {
  try {
    const url = new URL(requestUrl);
    if (url.protocol !== "tiki:" || url.host !== "app") return null;
    const pathname = decodeURIComponent(
      url.pathname === "/" ? "/index.html" : url.pathname,
    );
    const file = path.resolve(desktopRoot, `.${pathname}`);
    if (file !== desktopRoot && !file.startsWith(`${desktopRoot}${path.sep}`))
      return null;
    return existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // A game, not a browser window: the shell opens fullscreen and F11 leaves.
    fullscreen: true,
    backgroundColor: "#100b25",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
      // Chromium will not resume an AudioContext without a user activation
      // gesture, and gamepad input does not grant one: a player who navigates
      // the menu with a controller never produces the gesture, so the game
      // stayed silent until they happened to click something. This is a local
      // app serving its own content over tiki://, not a web page that could
      // surprise a visitor with sound, so the policy has nothing to protect
      // here. The web build cannot do this and shows a hint instead.
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("render-process-gone", (_event, details) =>
    console.error("Renderer process ended unexpectedly", details),
  );
  win.on("unresponsive", () =>
    console.error("Game window became unresponsive"),
  );
  win.webContents.on("will-navigate", (event, destination) => {
    const url = new URL(destination);
    if (url.protocol !== "tiki:" || url.host !== "app") event.preventDefault();
  });
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F11") {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    } else if (
      (input.control || input.meta) &&
      input.key.toLowerCase() === "q"
    ) {
      event.preventDefault();
      app.quit();
    }
  });
  win.once("ready-to-show", () => {
    win.setFullScreen(true);
    win.show();
  });
  await win.loadURL("tiki://app/index.html");
  return win;
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const isOwnPage = (webContents) => {
    try {
      const url = new URL(webContents.getURL());
      return url.protocol === "tiki:" && url.host === "app";
    } catch {
      return false;
    }
  };
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission) =>
      permission === "fullscreen" &&
      Boolean(webContents) &&
      isOwnPage(webContents),
  );
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) =>
      callback(permission === "fullscreen" && isOwnPage(webContents)),
  );
  protocol.handle("tiki", async (request) => {
    const file = resolveDesktopAsset(request.url);
    if (!file) return new Response("Not found", { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("child-process-gone", (_event, details) =>
  console.error("Electron child process ended unexpectedly", details),
);
