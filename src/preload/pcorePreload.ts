import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('pcoreHost', {
  job: () => ipcRenderer.invoke('pcore:job'),
  next: () => ipcRenderer.invoke('pcore:next'),
  frame: (pixels: Uint8Array) => ipcRenderer.invoke('pcore:frame', pixels),
  fail: (message: string) => ipcRenderer.send('pcore:fail', message),
});
