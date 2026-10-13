import type { ReactNode } from 'react';

// A small markdown renderer for planner drafts. It builds React elements only (no HTML injection, no
// links), so agent text stays text. Covers what plans use: headings, lists, code fences, quotes, paragraphs,
// **bold**, *italic* and `code`.

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index;
    if (i > last) out.push(text.slice(last, i));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={i}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`'))
      out.push(
        <code key={i} className="rounded bg-surface-3 px-1 font-mono text-[12px]">
          {tok.slice(1, -1)}
        </code>,
      );
    else out.push(<em key={i}>{tok.slice(1, -1)}</em>);
    last = i + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const H = [
  'text-[18px]',
  'text-[16px]',
  'text-[14px]',
  'text-[13px]',
  'text-[13px]',
  'text-[13px]',
];

export function Markdown({ source }: { source: string }) {
  const lines = source.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const key = blocks.length;
    if (line.startsWith('```')) {
      const body: string[] = [];
      for (i++; i < lines.length && !(lines[i] ?? '').startsWith('```'); i++)
        body.push(lines[i] ?? '');
      i++;
      blocks.push(
        <pre
          key={key}
          className="overflow-x-auto rounded-md bg-surface-3 p-3 font-mono text-[12px]"
        >
          {body.join('\n')}
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]?.length ?? 1;
      const Tag = `h${level}` as 'h1';
      blocks.push(
        <Tag key={key} className={`${H[level - 1]} mt-3 font-semibold first:mt-0`}>
          {inline(h[2] ?? '')}
        </Tag>,
      );
      i++;
      continue;
    }
    const listRe = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
    if (listRe.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      for (; i < lines.length && listRe.test(lines[i] ?? ''); i++)
        items.push(listRe.exec(lines[i] ?? '')?.[2] ?? '');
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={key} className={`${ordered ? 'list-decimal' : 'list-disc'} space-y-0.5 pl-5`}>
          {items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (line.startsWith('>')) {
      const quote: string[] = [];
      for (; i < lines.length && (lines[i] ?? '').startsWith('>'); i++)
        quote.push((lines[i] ?? '').replace(/^>\s?/, ''));
      blocks.push(
        <blockquote key={key} className="border-l-2 border-border-strong pl-3 text-muted">
          {inline(quote.join(' '))}
        </blockquote>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    for (
      ;
      i < lines.length &&
      (lines[i] ?? '').trim() &&
      !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s)/.test(lines[i] ?? '');
      i++
    )
      para.push(lines[i] ?? '');
    blocks.push(<p key={key}>{inline(para.join(' '))}</p>);
  }
  return <div className="space-y-2 text-[13px] leading-relaxed">{blocks}</div>;
}
