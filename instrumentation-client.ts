// Author: HyeonMo Gu
// Created: 2026-10-28

// Runs before React hydrates. Browser page translation and some extensions move text nodes React still owns;
// React then removes, or inserts next to, a node that is no longer there and the page crashes. Tolerate that
// instead (facebook/react#11538): the moved node is already gone, and an insert lands at the end of its parent.
const { removeChild, insertBefore } = Node.prototype;

Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
  return child.parentNode === this ? (removeChild.call(this, child) as T) : child;
};

Node.prototype.insertBefore = function <T extends Node>(this: Node, node: T, ref: Node | null): T {
  return insertBefore.call(this, node, ref && ref.parentNode !== this ? null : ref) as T;
};
