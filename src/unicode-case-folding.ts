import { unicode17CaseFolding } from "./unicode-case-folding-data.ts";

/** Unicode 17.0.0 DEFAULT FULL case folding, independent of locale. */
export function foldCaseUnicode17(value: string): string {
  let result = "";
  for (const character of value) {
    result += unicode17CaseFolding.get(character.codePointAt(0)!) ?? character;
  }
  return result;
}
