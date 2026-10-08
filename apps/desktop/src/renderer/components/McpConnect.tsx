import { Copy } from 'lucide-react';
import { buildMcpConfig } from '../lib/mcp-config';
import { useApp } from '../store';
import { toast } from '../toast';
import { Button } from './ui/button';
import { WebhookCard } from './WebhookCard';

export function CopyBlock({ label, text }: { label: string; text: string }) {
  const copy = () =>
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.info(`${label} copied`))
      .catch(() => toast.error('Could not copy to the clipboard'));
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
          {label}
        </span>
        <Button variant="ghost" onClick={copy} aria-label={`Copy ${label}`}>
          <Copy size={12} aria-hidden /> Copy
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-lg border border-border bg-surface-2 p-3 font-mono text-[12px] whitespace-pre-wrap break-all">
        {text}
      </pre>
    </div>
  );
}

/** How to connect an agent to this project (UI/UX §6.3 empty state; Settings reuses it in M12). */
export function McpConnect() {
  const project = useApp((s) => s.project);
  const chooseProject = useApp((s) => s.chooseProject);
  if (!project?.root) return null;
  const { json, cli } = buildMcpConfig(project.root, project.mcp);
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[12px] break-all">Project folder: {project.root}</span>
        <Button onClick={() => void chooseProject()}>Change project folder…</Button>
      </div>
      <CopyBlock label="Claude Code command" text={cli} />
      <CopyBlock label="MCP config" text={json} />
      <WebhookCard />
      {!project.mcp.bundled ? (
        <p className="text-warning">
          The MCP server bundle was not found next to the app. Build it with{' '}
          <code className="font-mono">npm run build -w packages/mcp-server</code>, or install the{' '}
          <code className="font-mono">command-center-mcp</code> command globally.
        </p>
      ) : null}
    </div>
  );
}
