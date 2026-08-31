const { app, BrowserWindow, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const url = require('url');

const { createServiceContainer } = require('./service-container');
const { registerIpcHandlers } = require('../ipc/ipc-registry');

let mainWindow;
let services;
let creatingWindow = false;
let windowSizePersistTimer = null;
let shouldPersistNormalWindowSize = false;
const releaseIconPath = path.join(__dirname, '../../../../release-icon.ico');
const windowsIconPath = path.join(__dirname, '../../../../icon.ico');
const fallbackIconPath = path.join(__dirname, '../../../../small_icon.png');

const hasSingleInstanceLock = app.requestSingleInstanceLock();

function normalizeStartupMode(value) {
  return ['normal', 'maximized', 'fullscreen'].includes(value) ? value : 'normal';
}

function normalWindowStatePath() {
  return path.join(app.getPath('userData'), 'normal-window-state.json');
}

function loadNormalWindowSize() {
  try {
    const saved = JSON.parse(fs.readFileSync(normalWindowStatePath(), 'utf8'));
    const width = Number(saved?.width);
    const height = Number(saved?.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1024 || height < 680 || width > 10000 || height > 10000) return null;
    return { width, height };
  } catch (_) {
    return null;
  }
}

function persistNormalWindowSize() {
  if (!shouldPersistNormalWindowSize || !mainWindow || mainWindow.isDestroyed() || mainWindow.isMaximized() || mainWindow.isFullScreen()) return;
  const [width, height] = mainWindow.getSize();
  if (width < 1024 || height < 680) return;
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(normalWindowStatePath(), JSON.stringify({ width, height }), 'utf8');
  } catch (err) {
    console.warn('[window] Could not persist normal window size:', err.message);
  }
}

function queueNormalWindowSizePersist() {
  if (windowSizePersistTimer) clearTimeout(windowSizePersistTimer);
  windowSizePersistTimer = setTimeout(() => {
    windowSizePersistTimer = null;
    persistNormalWindowSize();
  }, 350);
}

async function createWindow() {
  if (mainWindow || creatingWindow) return;
  creatingWindow = true;
  try {
    const ui = await services.settingsService.getSettingsByCode('ui');
    const startupMode = normalizeStartupMode(ui.window_startup_mode);
    const normalWindowSize = startupMode === 'normal' ? loadNormalWindowSize() : null;
    shouldPersistNormalWindowSize = startupMode === 'normal';

    mainWindow = new BrowserWindow({
      width: normalWindowSize?.width || 1280,
      height: normalWindowSize?.height || 800,
      minWidth: 1024,
      minHeight: 680,
      backgroundColor: '#f6f7f9',
      autoHideMenuBar: true,
      icon: fs.existsSync(releaseIconPath)
        ? releaseIconPath
        : (fs.existsSync(windowsIconPath)
          ? windowsIconPath
          : (fs.existsSync(fallbackIconPath) ? fallbackIconPath : undefined)),
      fullscreen: startupMode === 'fullscreen',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, '../preload/preload.js')
      }
    });

    // Navigation is provided by the renderer, so Electron's default menu is not needed.
    mainWindow.setMenuBarVisibility(false);
    if (startupMode === 'maximized') {
      mainWindow.maximize();
    }

    mainWindow.loadURL(
      url.format({
        pathname: path.join(__dirname, '../../../../dist/pos-shell/index.html'),
        protocol: 'file:',
        slashes: true
      })
    );

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    mainWindow.on('resize', queueNormalWindowSizePersist);
    mainWindow.on('close', () => {
      if (windowSizePersistTimer) clearTimeout(windowSizePersistTimer);
      windowSizePersistTimer = null;
      persistNormalWindowSize();
    });
  } finally {
    creatingWindow = false;
  }
}

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
app.on('second-instance', focusMainWindow);

app.on('ready', async () => {
  try {
    Menu.setApplicationMenu(null);
    services = await createServiceContainer();
    registerIpcHandlers(services);

    await createWindow();
  } catch (err) {
    console.error('[boot] Fatal startup error:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow().catch((err) => {
      console.error('[boot] Failed to recreate window:', err);
    });
  }
});
}
