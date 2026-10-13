// M13.1: an agent is an executor of stages (D17 revised). `agent` = a text runner does the work,
// `external` = a named tool outside the app, `human` = the operator in person. `tool` names the tool.
export const sql006 = `
ALTER TABLE agents ADD COLUMN executor TEXT NOT NULL DEFAULT 'agent'
  CHECK(executor IN ('agent','external','human'));
ALTER TABLE agents ADD COLUMN tool TEXT;

UPDATE agents SET executor = 'human' WHERE id = 'operator';
UPDATE agents SET executor = 'external' WHERE id = 'system';
`;
