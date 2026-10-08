import { useEffect, useRef } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

/**
 * Right-click menu at a screen position. Arrow keys move, Enter selects, Esc / outside click close.
 * Focus returns to whatever had it before the menu opened.
 */
export function ContextMenu({
  x,
  y,
  label,
  items,
  onClose,
}: {
  x: number;
  y: number;
  label: string;
  items: MenuItem[];
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && onClose();
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      previous?.focus?.();
    };
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const buttons = [
        ...(root.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []),
      ];
      const i = buttons.indexOf(document.activeElement as HTMLElement);
      buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
  };

  return (
    <div
      ref={root}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="fixed z-[70] min-w-44 rounded-lg border border-border-strong bg-surface-2 p-1 shadow-pop"
      style={{
        left: Math.min(x, window.innerWidth - 190),
        top: Math.min(y, window.innerHeight - items.length * 32 - 16),
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
          className="block w-full rounded px-2 py-1.5 text-left hover:bg-surface-3 focus-visible:bg-surface-3 disabled:opacity-40"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
