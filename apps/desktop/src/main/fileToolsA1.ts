const MAX_A1_COL_LETTERS = 3;
const MAX_A1_ROW = 1_048_576;
const ASCII_UPPER = /[A-Z]/;
const ASCII_DIGITS_ONLY = /^[0-9]+$/;

interface A1Parts {
  letters: string;
  digits: string;
}

function splitA1Parts(cell: string): A1Parts | null {
  let letterEnd = 0;
  while (letterEnd < cell.length && ASCII_UPPER.test(cell[letterEnd] as string)) {
    letterEnd += 1;
  }
  const letters = cell.slice(0, letterEnd);
  const digits = cell.slice(letterEnd);
  if (letters === "" || digits === "" || !ASCII_DIGITS_ONLY.test(digits)) return null;
  return { letters, digits };
}

function a1Column(letters: string): number | null {
  if (letters.length > MAX_A1_COL_LETTERS) return null;
  let column = 0;
  for (const letter of letters) {
    column = column * 26 + (letter.charCodeAt(0) - "A".charCodeAt(0) + 1);
  }
  return column - 1;
}

function a1Row(digits: string): number | null {
  const row = Number(digits);
  if (!Number.isFinite(row) || row === 0 || row > MAX_A1_ROW) return null;
  return row - 1;
}

/** Convert an A1 cell such as `B7` to a zero-based row and column. */
export function parseA1(cellRaw: string): [number, number] | null {
  const parts = splitA1Parts(cellRaw.trim().toUpperCase());
  if (parts === null) return null;
  const column = a1Column(parts.letters);
  if (column === null) return null;
  const row = a1Row(parts.digits);
  return row === null ? null : [row, column];
}

/** Accept one A1 cell or a two-ended A1 range. */
export function isA1Range(range: string): boolean {
  const index = range.indexOf(":");
  if (index === -1) return parseA1(range) !== null;
  return parseA1(range.slice(0, index)) !== null
    && parseA1(range.slice(index + 1)) !== null;
}
