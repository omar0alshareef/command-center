import { create } from 'zustand';

export interface ToastItem {
  id: number;
  kind: 'info' | 'error';
  message: string;
}

interface ToastState {
  toasts: ToastItem[];
  push: (message: string, kind?: ToastItem['kind']) => void;
  dismiss: (id: number) => void;
}

const MAX_TOASTS = 3;
const AUTO_DISMISS_MS = 4000;
let nextId = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (message, kind = 'info') => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }].slice(-MAX_TOASTS) }));
    // Errors persist until dismissed (UI/UX §5).
    if (kind === 'info') setTimeout(() => get().dismiss(id), AUTO_DISMISS_MS);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  info: (message: string) => useToasts.getState().push(message, 'info'),
  error: (message: string) => useToasts.getState().push(message, 'error'),
};
