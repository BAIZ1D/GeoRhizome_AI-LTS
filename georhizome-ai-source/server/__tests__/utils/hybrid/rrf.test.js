const { fuse } = require("../../../utils/hybrid/rrf");

describe("fuse", () => {
  const dense = { name: "dense", ids: ["a", "b"] };
  const sparse = { name: "sparse", ids: ["b", "c"] };

  test("shared id ranks first with ranks", () => {
    const out = fuse([dense, sparse], 60);
    expect(out.map((e) => e.id)).toEqual(["b", "a", "c"]);
    expect(out[0].rrf).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(out[0].ranks).toEqual({ dense: 2, sparse: 1 });
  });
  test("stable across list order", () => {
    const a = fuse([dense, sparse], 60);
    const b = fuse([sparse, dense], 60);
    expect(b).toEqual(a);
    expect(fuse([dense, sparse], 60)).toEqual(a);
  });
  test("tie-break prefers dense rank then id", () => {
    const out = fuse(
      [
        { name: "dense", ids: ["x"] },
        { name: "sparse", ids: ["y"] },
      ],
      60
    );
    expect(out.map((e) => e.id)).toEqual(["x", "y"]);
    const out2 = fuse(
      [
        { name: "sparse", ids: ["b"] },
        { name: "sparse2", ids: ["a"] },
      ],
      60
    );
    expect(out2.map((e) => e.id)).toEqual(["a", "b"]);
  });
  test("invalid k -> 60, empty -> []", () => {
    expect(fuse([dense], "bad")[0].rrf).toBeCloseTo(1 / 61, 12);
    expect(fuse([], 60)).toEqual([]);
  });
  test("duplicate id in one list counted once", () => {
    const out = fuse([{ name: "dense", ids: ["a", "a", "b"] }], 60);
    expect(out[0].rrf).toBeCloseTo(1 / 61, 12);
    expect(out.find((e) => e.id === "b").ranks.dense).toBe(3);
  });
});
