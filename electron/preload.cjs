// Sandboxed preload: the only bridge between the game page and the shell. It exposes a small,
// fixed updater API on window.littlewar; no Node, no ipcRenderer, no arbitrary channels.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('littlewar', Object.freeze({
  /** Current updater status (see electron/updater.cjs publicStatus). */
  status: () => ipcRenderer.invoke('updater:status'),
  /** Subscribe to status changes; returns an unsubscribe function. */
  onStatus: (cb) => {
    if (typeof cb !== 'function') return () => undefined;
    const listener = (_e, s) => cb(s);
    ipcRenderer.on('updater:status-changed', listener);
    return () => ipcRenderer.removeListener('updater:status-changed', listener);
  },
  /** Run the release check once (the title screen calls it when "check for updates" is on). */
  check: () => ipcRenderer.send('updater:check'),
  /** The game reached its title screen: the served bundle is good. */
  ready: () => ipcRenderer.send('updater:ready'),
  restartToUpdate: () => ipcRenderer.send('updater:restart'),
  openDownloads: () => ipcRenderer.send('updater:open-downloads'),
  setAutoDownload: (on) => ipcRenderer.invoke('updater:set-auto', on === true),
}));
