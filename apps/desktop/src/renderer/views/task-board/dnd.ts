import {
  pointerWithin,
  rectIntersection,
  type Announcements,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import { STATUS_NAME } from '../../lib/status';
import type { TaskStatus } from '@command-center/core';

/** Pointer: the column under the cursor. Keyboard (no pointer): the column the card overlaps most. */
export const collisionDetection: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args);

/**
 * Keyboard drag moves between COLUMNS: Left/Right jump to the neighbouring column at the same height.
 * (dnd-kit's default moves 25px per keypress, which is useless for a kanban board.)
 */
export const columnKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { context: { droppableRects, droppableContainers, collisionRect }, currentCoordinates },
) => {
  if (!collisionRect || (event.code !== 'ArrowLeft' && event.code !== 'ArrowRight')) return;
  event.preventDefault();

  const columns = droppableContainers
    .getEnabled()
    .flatMap((c) => {
      const rect = droppableRects.get(c.id);
      return rect ? [{ rect }] : [];
    })
    .sort((a, b) => a.rect.left - b.rect.left);

  const centerX = collisionRect.left + collisionRect.width / 2;
  const current = columns.findIndex((c) => centerX >= c.rect.left && centerX <= c.rect.right);
  const from = columns[current === -1 ? 0 : current];
  const to = columns[(current === -1 ? 0 : current) + (event.code === 'ArrowRight' ? 1 : -1)];
  if (!from || !to) return;
  return { x: currentCoordinates.x + (to.rect.left - from.rect.left), y: currentCoordinates.y };
};

const name = (id: unknown) => STATUS_NAME[id as TaskStatus] ?? String(id);

/** Live-region text for screen readers (UI/UX §7.7). */
export const announcements: Announcements = {
  onDragStart: ({ active }) =>
    `Picked up ${active.id}. Use the left and right arrow keys to choose a column, space to drop, escape to cancel.`,
  onDragOver: ({ active, over }) =>
    over ? `${active.id} is over ${name(over.id)}.` : `${active.id} is not over a column.`,
  onDragEnd: ({ active, over }) =>
    over ? `Dropped ${active.id} on ${name(over.id)}.` : `Dropped ${active.id}. No change.`,
  onDragCancel: ({ active }) => `Move of ${active.id} cancelled.`,
};

export const screenReaderInstructions = {
  draggable:
    'Press space to pick up this task. Use left and right arrows to choose a column and space to drop. Press enter to open it.',
};
