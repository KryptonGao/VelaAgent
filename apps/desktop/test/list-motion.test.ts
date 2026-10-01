import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileMotionItems, type MotionEntry } from "../src/renderer/components/list-motion.ts";

const keyOf = (item: { id: string }) => item.id;
const seed = (ids: string[]): MotionEntry<{ id: string }>[] => ids.map((id) => ({ key: id, item: { id }, present: true, entering: false }));

test("simultaneous removal and reorder keeps exits at their old position and live rows in new order", () => {
  const rows = reconcileMotionItems(seed(["a", "b", "c", "d"]), [{ id: "d" }, { id: "c" }, { id: "new" }], keyOf);
  assert.deepEqual(rows.filter((row) => row.present).map((row) => row.key), ["d", "c", "new"]);
  assert.deepEqual(rows.filter((row) => !row.present).map((row) => row.key), ["a", "b"]);
  assert.equal(rows.find((row) => row.key === "new")?.entering, true);
});

test("rapid re-add cancels an exit without duplicating the retained key", () => {
  const exiting = reconcileMotionItems(seed(["a", "b"]), [{ id: "b" }], keyOf);
  const reopened = reconcileMotionItems(exiting, [{ id: "a" }, { id: "b" }], keyOf);
  assert.equal(reopened.length, 2);
  assert.equal(reopened[0].present, true);
  assert.equal(reopened[0].entering, false);
});

test("updates refresh live item data and preserve the payload needed by an outgoing row", () => {
  const original = [{ id: "a", title: "old" }, { id: "b", title: "archive" }];
  const previous = original.map((item) => ({ key: item.id, item, present: true, entering: false }));
  const rows = reconcileMotionItems(previous, [{ id: "a", title: "updated" }], keyOf);
  assert.equal(rows[0].item.title, "updated");
  assert.equal(rows[1].item, original[1]);
});
