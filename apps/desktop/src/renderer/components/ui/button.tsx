import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export function Button({
  variant = 'default',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'default' | 'ghost' }) {
  return (
    <button
      type="button"
      data-variant={variant}
      {...props}
      className={cn(
        'btn no-drag inline-flex min-h-7 min-w-7 items-center justify-center gap-1.5 rounded-md border px-3 text-[12px] font-medium transition-colors disabled:opacity-50',
        variant === 'primary' && 'border-accent bg-accent text-white hover:brightness-110',
        variant === 'default' && 'border-border-strong bg-surface-2 text-text hover:bg-surface-3',
        variant === 'ghost' && 'border-transparent text-muted hover:bg-surface-2 hover:text-text',
        className,
      )}
    />
  );
}
