// main.js — Electron entry point.
//
// Strategy: pick a free port, hand it to the Express server via
// process.env.PORT, side-effect-import server.js (which calls app.listen
// during module init), wait for it to actually be listening, then open
// a BrowserWindow pointed at it.
//
// Why this approach: trebuchet was originally built as a web app —
// Express backend plus a static frontend that talks to it via
// fetch('/api/...'). Wrapping it like this means *zero* changes to the
// frontend code; every fetch call works identically to the standalone
// web build. The trade-off is that we're carrying Express around inside
// a desktop app, which is fine in practice — plenty of real Electron
// apps are built this way.

import { app, BrowserWindow, Menu, shell, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

import * as secretStore from './secretStore.js';

// __dirname equivalent in ESM. Used to resolve sibling files like README.md.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// External URLs that the menu links to.
// ---------------------------------------------------------------------------
const URLS = {
  raydiumClmm:     'https://docs.raydium.io/raydium/for-liquidity-providers/pool-types/clmm-concentrated',
  raydiumBurnEarn: 'https://docs.raydium.io/raydium/for-liquidity-providers/burn-and-earn',
  helius:          'https://www.helius.dev/',
  github:          'https://github.com/AnOversizedMooseWithSocks/trebuchet',
};

// ---------------------------------------------------------------------------
// Find a free local port. We avoid hardcoding 3000 because the user may
// already have something on it — especially likely if they also run the
// web build (npm run web) on the same machine for development.
// ---------------------------------------------------------------------------
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Poll the server until it answers. We can't loadURL immediately after
// importing server.js because Express's listen() is asynchronous — there's
// a small window where the port is bound but not yet accepting requests.
// ---------------------------------------------------------------------------
function waitForServer(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/`;

  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(url, (res) => {
        res.resume();           // discard body, we only care that it answered
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(`Server did not come up within ${timeoutMs}ms`));
        } else {
          setTimeout(tryOnce, 100);
        }
      });
    };
    tryOnce();
  });
}

// ---------------------------------------------------------------------------
// README viewer.
//
// Reads README.md, runs it through `marked` to get HTML, wraps the result
// in a self-contained HTML document with GitHub-ish styling, writes that
// to a temp file, and loads it in a new BrowserWindow.
//
// We use a temp file (rather than a giant data: URL or a custom protocol
// handler) because it's the simplest approach that "just works" with
// Electron's security model and lets the page resolve relative resources
// the way you'd expect.
//
// `readmeWindow` is module-scoped so a second click on "View README"
// re-focuses the existing window instead of opening duplicates.
// ---------------------------------------------------------------------------
let readmeWindow = null;

const README_CSS = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
                 "Helvetica Neue", Arial, sans-serif;
    font-size: 16px; line-height: 1.5;
    color: #1f2328; background: #fff;
    max-width: 980px; margin: 0 auto; padding: 32px 48px;
  }
  h1, h2, h3, h4, h5, h6 {
    margin-top: 24px; margin-bottom: 16px;
    font-weight: 600; line-height: 1.25;
  }
  h1 { font-size: 2em;    padding-bottom: 0.3em; border-bottom: 1px solid #d1d9e0; }
  h2 { font-size: 1.5em;  padding-bottom: 0.3em; border-bottom: 1px solid #d1d9e0; }
  h3 { font-size: 1.25em; }
  h4 { font-size: 1em; }
  h5 { font-size: 0.875em; }
  h6 { font-size: 0.85em;  color: #59636e; }
  p  { margin: 0 0 16px 0; }
  a  { color: #0969da; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code {
    padding: 0.2em 0.4em; margin: 0; font-size: 85%;
    background-color: rgba(175,184,193,0.2); border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, "SF Mono",
                 Menlo, Consolas, "Liberation Mono", monospace;
  }
  pre {
    padding: 16px; overflow: auto; font-size: 85%; line-height: 1.45;
    background-color: #f6f8fa; border-radius: 6px; margin-bottom: 16px;
  }
  pre code { padding: 0; background: transparent; font-size: 100%; }
  blockquote {
    padding: 0 1em; color: #59636e;
    border-left: 0.25em solid #d1d9e0; margin: 0 0 16px 0;
  }
  ul, ol { padding-left: 2em; margin-bottom: 16px; }
  li { margin: 0.25em 0; }
  table {
    border-collapse: collapse; margin-bottom: 16px;
    display: block; width: max-content; max-width: 100%; overflow: auto;
  }
  table th, table td { padding: 6px 13px; border: 1px solid #d1d9e0; }
  table th { font-weight: 600; background-color: #f6f8fa; }
  table tr:nth-child(2n) { background-color: #f6f8fa; }
  hr {
    height: 0.25em; padding: 0; margin: 24px 0;
    background-color: #d1d9e0; border: 0;
  }
  img { max-width: 100%; }
`;

async function openReadmeWindow() {
  // Re-focus an existing window rather than spawning another one.
  if (readmeWindow && !readmeWindow.isDestroyed()) {
    readmeWindow.focus();
    return;
  }

  try {
    const md = await fs.readFile(path.join(__dirname, 'README.md'), 'utf8');
    const body = marked.parse(md);

    const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Trebuchet — README</title>
<style>${README_CSS}</style>
</head>
<body>
${body}
</body>
</html>`;

    // Write to the OS temp dir. We don't bother cleaning up — the OS
    // handles temp dir lifecycle, and overwriting the same path each time
    // means we don't accumulate stale copies.
    const tempPath = path.join(app.getPath('temp'), 'trebuchet-readme.html');
    await fs.writeFile(tempPath, fullHtml, 'utf8');

    readmeWindow = new BrowserWindow({
      width: 900,
      height: 800,
      title: 'README',
      autoHideMenuBar: true,    // no menu bar in the README window itself
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Open any links inside the README in the user's default browser
    // rather than navigating the README window away from the README.
    readmeWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
    readmeWindow.webContents.on('will-navigate', (event, url) => {
      // Allow only the initial file:// load; redirect everything else.
      if (!url.startsWith('file://')) {
        event.preventDefault();
        shell.openExternal(url);
      }
    });

    readmeWindow.on('closed', () => { readmeWindow = null; });
    readmeWindow.loadFile(tempPath);
  } catch (err) {
    console.error('Failed to open README:', err);
  }
}

// ---------------------------------------------------------------------------
// Application menu.
//
// The default Electron menu is full of dev-tool noise (Reload, Toggle
// DevTools, Learn More -> electronjs.org, etc.) that has no business in
// a shipped product. We replace it with a minimal menu containing just
// the items that make sense: File/Quit, and a Help menu with links to
// relevant external docs and the in-app README.
//
// macOS gets the same Help menu, plus the standard Apple-required app
// menu (About / Hide / Quit) and a working Edit menu (which is what
// gives form fields their keyboard shortcuts on Mac).
// ---------------------------------------------------------------------------
function setAppMenu() {
  // The Help submenu is identical across platforms. Defining it once
  // keeps Windows/Linux and macOS in sync.
  const helpSubmenu = [
    {
      label: 'View README',
      click: () => openReadmeWindow(),
    },
    { type: 'separator' },
    {
      label: 'Raydium CLMM Pools (docs)',
      click: () => shell.openExternal(URLS.raydiumClmm),
    },
    {
      // && escapes the Alt-mnemonic underscore so users see "Burn & Earn"
      // rather than "Burn _Earn" with E underlined as an accelerator.
      label: 'Raydium Burn && Earn (docs)',
      click: () => shell.openExternal(URLS.raydiumBurnEarn),
    },
    {
      label: 'Helius RPC',
      click: () => shell.openExternal(URLS.helius),
    },
    { type: 'separator' },
    {
      label: 'GitHub Repository',
      click: () => shell.openExternal(URLS.github),
    },
  ];

  if (process.platform !== 'darwin') {
    // Windows / Linux: minimal File menu plus the Help menu.
    const template = [
      {
        label: 'File',
        submenu: [{ role: 'quit' }],
      },
      {
        label: 'Help',
        submenu: helpSubmenu,
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    return;
  }

  // macOS: app menu, Edit, Window, Help. The menu bar is system-level
  // and always visible at the top of the screen, so apps without one
  // look broken.
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
      ],
    },
    {
      label: 'Help',
      submenu: helpSubmenu,
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Boot sequence.
// ---------------------------------------------------------------------------
let serverPort;

async function startServer() {
  // Persisted state (rpcConfig.json) needs to live somewhere writable and
  // stable across reinstalls. userData is the right answer on every
  // platform: ~/Library/Application Support/Trebuchet on macOS,
  // %APPDATA%/Trebuchet on Windows, ~/.config/Trebuchet on Linux.
  //
  // rpcConfig.js honours TREBUCHET_CONFIG_DIR if set, else falls back to
  // its own __dirname (used in `npm run web` mode).
  process.env.TREBUCHET_CONFIG_DIR = app.getPath('userData');

  serverPort = await getFreePort();

  // IMPORTANT: PORT must be set before importing server.js, since server.js
  // reads process.env.PORT at module load time and immediately calls listen.
  process.env.PORT = String(serverPort);

  // Side-effect import: server.js calls app.listen() during module init.
  // We don't need its exports.
  await import('./server.js');

  await waitForServer(serverPort);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,                // avoid the white-flash; show after content loads
    webPreferences: {
      // We're loading our own bundled HTML/JS over a localhost loopback,
      // so renderer sandboxing is appropriate and we don't need a preload
      // script (no IPC — the renderer talks to Express via fetch, exactly
      // as it does in the standalone web build).
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadURL(`http://127.0.0.1:${serverPort}/`);
}

app.whenReady().then(async () => {
  setAppMenu();

  // Hand Electron's safeStorage API to our secret-store module so any
  // wallet keys persisted during this session are encrypted at rest
  // using the OS keychain. Has to happen before startServer(), since
  // server.js imports pendingWallets and any read from the recovery
  // cache should already be going through the encrypted path.
  secretStore.setSafeStorage(safeStorage);

  try {
    await startServer();
    createWindow();
  } catch (err) {
    // If the server failed to start there's nothing useful the user can do
    // from a blank window — log loudly and bail.
    console.error('Failed to start trebuchet server:', err);
    app.quit();
    return;
  }

  // Standard macOS behaviour: re-create a window when the dock icon is
  // clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Standard macOS behaviour: stay running until Cmd+Q; on every other
  // platform, quit when the last window closes.
  if (process.platform !== 'darwin') app.quit();
});
