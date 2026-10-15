// An existing project that still carries the placeholder dates from 001 starts when its first milestone was created
// targets six months out, so the swim lane and the week numbers count from the project's own day 0.
export const sql010 = `
UPDATE project
SET start_date = (SELECT date(MIN(created_at)) FROM milestones),
    target_date = date((SELECT MIN(created_at) FROM milestones), '+6 months')
WHERE id = 1 AND EXISTS (SELECT 1 FROM milestones) AND start_date = '2026-01-01' AND target_date = '2026-06-30';
`;
