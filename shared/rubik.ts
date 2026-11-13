/**
 * Pure 2×2 corner model matching sysprog21/minirubik at commit
 * 231796cc48868f4ea276f652139b6bebbad0cd02:
 * solver.c:27–40, 50–74, 87–144, 269–289; README.md:94–191, 203–220.
 * No repository program is executed by this module.
 *
 * Arrays use physical positions 0…7, and permutation[position] is a cubie ID.
 * Corner 0 is anchored with orientation 0. The C program omits that corner and
 * subtracts 1 from cubie IDs: C p[i] = permutation[i + 1] - 1.
 * Coordinates form a right-handed frame: +x RIGHT, +y UP, +z FRONT.
 */

export type CornerId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type CubeFace = "R" | "B" | "D";
export type CubeMove = `${CubeFace}${"" | "2" | "'"}`;
export type StickerFace = "U" | "D" | "F" | "B" | "R" | "L";
export type Vector3 = readonly [number, number, number];

export interface CubeState {
  readonly permutation: readonly number[];
  readonly orientations: readonly number[];
}

export interface MoveRotation {
  readonly axis: "x" | "y" | "z";
  readonly layer: 1 | -1;
  /** Right-hand-rule angle in degrees about the positive coordinate axis. */
  readonly angle: number;
}

export interface CubeSticker {
  /** The solved face/color attached to this physical cubie. */
  readonly homeFace: StickerFace;
  /** The face currently carrying that sticker. */
  readonly currentFace: StickerFace;
  readonly normal: Vector3;
}

export const MINIRUBIK_COMMIT = "231796cc48868f4ea276f652139b6bebbad0cd02";
export const CUBE_STATE_COUNT = 3_674_160;
export const CUBE_MOVES: readonly CubeMove[] = Object.freeze([
  "R", "R2", "R'", "B", "B2", "B'", "D", "D2", "D'",
]);

export const CORNER_POSITIONS: readonly Vector3[] = Object.freeze([
  Object.freeze([-1, 1, 1] as const),  // 0: front upper left, anchored
  Object.freeze([1, 1, 1] as const),   // 1: front upper right
  Object.freeze([1, -1, 1] as const),  // 2: front down right
  Object.freeze([-1, -1, 1] as const), // 3: front down left
  Object.freeze([1, 1, -1] as const),  // 4: back upper right
  Object.freeze([1, -1, -1] as const), // 5: back down right
  Object.freeze([-1, -1, -1] as const),// 6: back down left
  Object.freeze([-1, 1, -1] as const), // 7: back upper left
]);

export const FACE_NORMALS: Readonly<Record<StickerFace, Vector3>> = Object.freeze({
  U: Object.freeze([0, 1, 0] as const),
  D: Object.freeze([0, -1, 0] as const),
  F: Object.freeze([0, 0, 1] as const),
  B: Object.freeze([0, 0, -1] as const),
  R: Object.freeze([1, 0, 0] as const),
  L: Object.freeze([-1, 0, 0] as const),
});

/**
 * Each triple has positive determinant and starts with its UP/DOWN face.
 * At orientation o, home sticker i occupies destination slot (i + o) mod 3.
 * This precise convention produces minirubik's alternating R/B twist deltas.
 * A twist is local to a corner, not a global rotation about an x/y/z axis.
 */
export const CORNER_FACE_ORDER: readonly (readonly StickerFace[])[] = Object.freeze([
  Object.freeze(["U", "L", "F"] as const),
  Object.freeze(["U", "F", "R"] as const),
  Object.freeze(["D", "R", "F"] as const),
  Object.freeze(["D", "F", "L"] as const),
  Object.freeze(["U", "R", "B"] as const),
  Object.freeze(["D", "B", "R"] as const),
  Object.freeze(["D", "L", "B"] as const),
  Object.freeze(["U", "B", "L"] as const),
]);

/** Each destination pulls its cubie from this source position. */
export const QUARTER_TURN_SOURCE: Readonly<Record<CubeFace, readonly number[]>> = Object.freeze({
  R: Object.freeze([0, 2, 5, 3, 1, 4, 6, 7]),
  B: Object.freeze([0, 1, 2, 3, 5, 6, 7, 4]),
  D: Object.freeze([0, 1, 3, 6, 4, 2, 5, 7]),
});

export const QUARTER_TURN_TWIST: Readonly<Record<CubeFace, readonly number[]>> = Object.freeze({
  R: Object.freeze([0, 1, 2, 0, 2, 1, 0, 0]),
  B: Object.freeze([0, 0, 0, 0, 1, 2, 1, 2]),
  D: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0]),
});

export const SOLVED_STATE: CubeState = Object.freeze({
  permutation: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7]),
  orientations: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0]),
});

export function solvedCube(): CubeState {
  return { permutation: [...SOLVED_STATE.permutation], orientations: [...SOLVED_STATE.orientations] };
}

export function isValidCubeState(value: unknown): value is CubeState {
  if (!value || typeof value !== "object") return false;
  const { permutation: p, orientations: o } = value as Partial<CubeState>;
  return Array.isArray(p) && Array.isArray(o) && p.length === 8 && o.length === 8
    && Array.from(p).every(n => Number.isInteger(n) && n >= 0 && n <= 7) && new Set(p).size === 8
    && Array.from(o).every(n => Number.isInteger(n) && n >= 0 && n <= 2)
    && p[0] === 0 && o[0] === 0 && o.reduce((sum, n) => sum + n, 0) % 3 === 0;
}

function assertState(state: CubeState): void {
  if (!isValidCubeState(state)) throw new RangeError("Invalid anchored 2×2 cube state.");
}

function assertCorner(position: number): asserts position is CornerId {
  if (!Number.isInteger(position) || position < 0 || position > 7) throw new RangeError("Corner position must be an integer from 0 to 7.");
}

function moveParts(move: CubeMove): { face: CubeFace; turns: 1 | 2 | 3 } {
  if (typeof move !== "string" || !/^[RBD](?:2|')?$/.test(move)) throw new RangeError("Only R, B, D and their half/inverse turns are supported.");
  return { face: move[0] as CubeFace, turns: move.endsWith("2") ? 2 : move.endsWith("'") ? 3 : 1 };
}

export function inverseMove(move: CubeMove): CubeMove {
  const { face, turns } = moveParts(move);
  return turns === 2 ? `${face}2` : turns === 3 ? face : `${face}'`;
}

export function applyMove(state: CubeState, move: CubeMove): CubeState {
  assertState(state);
  const { face, turns } = moveParts(move);
  let next = state;
  for (let turn = 0; turn < turns; turn++) {
    next = {
      permutation: QUARTER_TURN_SOURCE[face].map(from => next.permutation[from]),
      orientations: QUARTER_TURN_SOURCE[face].map((from, to) => (next.orientations[from] + QUARTER_TURN_TWIST[face][to]) % 3),
    };
  }
  return next;
}

export function applyMoves(state: CubeState, moves: readonly CubeMove[]): CubeState {
  assertState(state);
  return moves.reduce((next, move) => applyMove(next, move), state);
}

export function moveRotation(move: CubeMove): MoveRotation {
  const { face, turns } = moveParts(move);
  const signedTurns = turns === 3 ? -1 : turns;
  // Clockwise is viewed from outside the selected face, not from the camera.
  if (face === "R") return { axis: "x", layer: 1, angle: -90 * signedTurns };
  if (face === "B") return { axis: "z", layer: -1, angle: 90 * signedTurns };
  return { axis: "y", layer: -1, angle: 90 * signedTurns };
}

export function isCornerAffected(position: number, move: CubeMove): boolean {
  assertCorner(position);
  const { axis, layer } = moveRotation(move);
  return CORNER_POSITIONS[position][axis === "x" ? 0 : axis === "y" ? 1 : 2] === layer;
}

/** Rotate a position OR sticker normal; the caller selects the moving layer. */
export function rotateVector(vector: Vector3, move: CubeMove, progress = 1): Vector3 {
  if (!Number.isFinite(progress)) throw new RangeError("Rotation progress must be finite.");
  const { axis, angle } = moveRotation(move);
  const radians = angle * progress * Math.PI / 180;
  const c = Math.cos(radians), s = Math.sin(radians);
  const [x, y, z] = vector;
  const rotated = axis === "x" ? [x, y * c - z * s, y * s + z * c]
    : axis === "y" ? [x * c + z * s, y, -x * s + z * c]
      : [x * c - y * s, x * s + y * c, z];
  return rotated.map(n => Math.abs(n) < 1e-12 ? 0 : n) as unknown as Vector3;
}

/** Home face labels remain attached to their cubie as it moves and twists. */
export function stickersAt(state: CubeState, position: number): readonly CubeSticker[] {
  assertState(state); assertCorner(position);
  const cubie = state.permutation[position];
  return CORNER_FACE_ORDER[cubie].map((homeFace, i) => {
    const currentFace = CORNER_FACE_ORDER[position][(i + state.orientations[position]) % 3];
    return { homeFace, currentFace, normal: FACE_NORMALS[currentFace] };
  });
}

export function parseCubeInput(input: string): CubeState {
  if (typeof input !== "string" || !/^[1-7]{7}[1-3]{7}$/.test(input)) throw new RangeError("Cube input must contain seven cubie digits followed by seven twist digits.");
  const state: CubeState = {
    permutation: [0, ...[...input.slice(0, 7)].map(Number)],
    orientations: [0, ...[...input.slice(7)].map(digit => Number(digit) - 1)],
  };
  assertState(state);
  return state;
}

export function serializeCubeInput(state: CubeState): string {
  assertState(state);
  return state.permutation.slice(1).join("") + state.orientations.slice(1).map(n => n + 1).join("");
}

export function rankCubeState(state: CubeState): number {
  assertState(state);
  let permutationRank = 0, orientationRank = 0;
  for (let position = 1; position <= 7; position++) {
    let smaller = 0;
    for (let later = position + 1; later <= 7; later++) if (state.permutation[later] < state.permutation[position]) smaller++;
    permutationRank = permutationRank * (8 - position) + smaller;
  }
  for (let position = 1; position <= 6; position++) orientationRank = orientationRank * 3 + state.orientations[position];
  return permutationRank * 729 + orientationRank;
}

export function unrankCubeState(rank: number): CubeState {
  if (!Number.isInteger(rank) || rank < 0 || rank >= CUBE_STATE_COUNT) throw new RangeError("Cube rank must be an integer from 0 to 3674159.");
  const available = [1, 2, 3, 4, 5, 6, 7];
  const permutation = [0], orientations = Array<number>(8).fill(0);
  let p = Math.floor(rank / 729), o = rank % 729, sum = 0;
  for (const factorial of [720, 120, 24, 6, 2, 1, 1]) {
    const digit = Math.floor(p / factorial); p %= factorial;
    permutation.push(available.splice(digit, 1)[0]);
  }
  for (let position = 6; position >= 1; position--) {
    orientations[position] = o % 3; sum += orientations[position]; o = Math.floor(o / 3);
  }
  orientations[7] = (3 - sum % 3) % 3;
  return { permutation, orientations };
}
