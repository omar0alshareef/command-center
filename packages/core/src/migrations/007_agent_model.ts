// M14 Slice 1: the Claude Code model an agent runs on. NULL means "use the CLI default" (no --model flag).
export const sql007 = `
ALTER TABLE agents ADD COLUMN model TEXT;
`;
