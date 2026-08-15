import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { selectionIntersectsElement } from "../src/components/markdown/selection-stability";

const root = {} as Element;

function selection(input: {
  collapsed?: boolean;
  intersections: Array<boolean | Error>;
}) {
  return {
    isCollapsed: input.collapsed ?? false,
    rangeCount: input.intersections.length,
    getRangeAt(index: number) {
      const intersection = input.intersections[index];
      return {
        intersectsNode(node: Node) {
          expect(node).toBe(root);
          if (intersection instanceof Error) throw intersection;
          return intersection;
        },
      } as Range;
    },
  } as Pick<Selection, "getRangeAt" | "isCollapsed" | "rangeCount">;
}

describe("markdown selection stability", () => {
  test("recognizes a live range that intersects rendered markdown", () => {
    expect(selectionIntersectsElement(root, selection({ intersections: [false, true] }))).toBe(true);
  });

  test("does not defer updates for a collapsed caret or an empty selection", () => {
    expect(selectionIntersectsElement(root, selection({ collapsed: true, intersections: [true] }))).toBe(false);
    expect(selectionIntersectsElement(root, null)).toBe(false);
  });

  test("ignores a detached stale range and continues checking live ranges", () => {
    expect(selectionIntersectsElement(root, selection({ intersections: [new Error("detached"), true] }))).toBe(true);
  });

  test("keeps the innerHTML prop stable across unrelated completed-response renders", () => {
    const sources = [
      "../src/components/markdown/markdown.tsx",
      "../src/react-app/domains/session/surface/markdown.tsx",
    ].map((path) => readFileSync(join(import.meta.dir, path), "utf8"));

    for (const source of sources) {
      expect(source).toContain("const stableInnerHtml = useMemo(() => ({ __html: html }), [html]);");
      expect(source).toContain("dangerouslySetInnerHTML={stableInnerHtml}");
      expect(source).not.toContain("dangerouslySetInnerHTML={{ __html: html }}");
    }
  });
});
