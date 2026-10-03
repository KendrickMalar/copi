import assert from "node:assert/strict";
import test from "node:test";
import { foldCaseUnicode17 } from "../src/unicode-case-folding.ts";

test("uses default full folding, including supplementary Unicode 17 letters, without Turkic/simple mappings", () => {
  assert.equal(foldCaseUnicode17("Straße Σς Iİı ﬃ"), "strasse σσ ii\u0307ı ffi");
  assert.equal(foldCaseUnicode17("\u{10400}\u{1E900}\u{10D50}"), "\u{10428}\u{1E922}\u{10D70}");
  assert.equal(foldCaseUnicode17("漢字 é\u200b\ud800"), "漢字 é\u200b\ud800");
  assert.equal(foldCaseUnicode17("ᾈ"), "ἀι");
});
