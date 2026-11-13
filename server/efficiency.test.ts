import test from "node:test";
import assert from "node:assert/strict";
import { defaultPonytailMode } from "../shared/efficiency.js";
import { applyPonytail, withPonytail } from "./efficiency.js";
import { ProviderSettingsStore } from "./provider-settings.js";

test("Ponytail efficiency mode defaults to full in Explain and preserves complete teaching coverage", async () => {
  assert.equal(defaultPonytailMode, "full");
  const store = new ProviderSettingsStore(":memory:");
  try {
    assert.equal(store.get().ponytailMode, "full");
  } finally {
    store.close();
  }

  const full = applyPonytail("撰寫完整課程");
  assert.match(full, /mode=full/);
  assert.match(full, /NEVER shorten away source coverage, core concepts, primary-source specification details/);
  assert.equal(applyPonytail("撰寫完整課程", "off"), "撰寫完整課程");

  let captured = "";
  const wrapped = withPonytail(async (_role, instruction) => {
    captured = instruction;
    return { ok: true };
  });
  await wrapped("課程作者", "基礎提示", {}, new AbortController().signal);
  assert.match(captured, /mode=full/);
  assert.match(captured, /role=課程作者/);
});
