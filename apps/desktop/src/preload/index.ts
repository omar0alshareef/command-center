import { contextBridge } from 'electron';

// Minimal bridge for M0. Typed IPC methods arrive in M2 (ROADMAP D2).
contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
});
