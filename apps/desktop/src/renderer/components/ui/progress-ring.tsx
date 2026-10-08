export function ProgressRing({
  size = 40,
  value,
  color = 'var(--accent)',
  label,
  stroke = 3,
}: {
  size?: number;
  /** 0..1 */
  value: number;
  color?: string;
  label?: string;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.min(1, Math.max(0, value));
  return (
    <div className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--border)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
          style={{ transition: 'stroke-dashoffset 400ms' }}
        />
      </svg>
      {label ? (
        <span className="absolute inset-0 grid place-items-center font-mono text-[10px]">
          {label}
        </span>
      ) : null}
    </div>
  );
}
