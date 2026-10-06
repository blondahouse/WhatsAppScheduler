import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('waScheduler', {
  call: (action: string, payload?: unknown) => ipcRenderer.invoke('scheduler', action, payload),
  subscribe: (callback: (state: unknown) => void) => {
    const listener = (_: unknown, state: unknown) => callback(state);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  }
});
