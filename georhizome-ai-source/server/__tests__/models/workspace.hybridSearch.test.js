const { Workspace } = require("../../models/workspace");

describe("Workspace.hybridSearch", () => {
  const v = Workspace.validations.hybridSearch;
  test("true values", () => {
    expect(v(true)).toBe(true);
    expect(v("true")).toBe(true);
  });
  test("false values", () => {
    expect(v(false)).toBe(false);
    expect(v("false")).toBe(false);
  });
  test("invalid -> null", () => {
    for (const x of [null, undefined, "", "x", 1]) expect(v(x)).toBeNull();
  });
  test("writable", () => {
    expect(Workspace.writable).toContain("hybridSearch");
  });
});
