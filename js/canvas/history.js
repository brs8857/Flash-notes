// Undo/redo command stack. A command records which items left the array and which arrived, each with
// its index, so applying it never needs a full snapshot. Items are immutable, so commands just hold
// references. Valid because history is linear and no operation reorders surviving items.

import { HISTORY_LIMIT } from './constants.js';

/** @returns {{removed:[number,object][], added:[number,object][]}} */
export function diffItems(before, after) {
  if (before === after) return { removed: [], added: [] };
  const a = new Set(before), b = new Set(after);
  const removed = [], added = [];
  before.forEach((it, i) => { if (!b.has(it)) removed.push([i, it]); });
  after.forEach((it, i) => { if (!a.has(it)) added.push([i, it]); });
  return { removed, added };
}

function apply(items, take, put) {
  const gone = new Set(take.map(([, it]) => it));
  const out = gone.size ? items.filter((it) => !gone.has(it)) : items.slice();
  for (const [i, it] of put) out.splice(Math.min(i, out.length), 0, it); // ascending indices
  return out;
}

export class History {
  constructor() { this.undoStack = []; this.redoStack = []; }
  clear() { this.undoStack.length = 0; this.redoStack.length = 0; }
  push(cmd) {
    this.undoStack.push(cmd);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }
  /** @returns new items array, or null when there is nothing to undo */
  undo(items) {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    this.redoStack.push(cmd);
    return apply(items, cmd.added, cmd.removed);
  }
  redo(items) {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    this.undoStack.push(cmd);
    return apply(items, cmd.removed, cmd.added);
  }
}
