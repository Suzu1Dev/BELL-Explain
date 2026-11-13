import test from "node:test";
import assert from "node:assert/strict";
import {
  CORNER_FACE_ORDER, CORNER_POSITIONS, CUBE_MOVES, CUBE_STATE_COUNT,
  FACE_NORMALS, SOLVED_STATE, applyMove, applyMoves, inverseMove,
  isCornerAffected, isValidCubeState, moveRotation, parseCubeInput,
  rankCubeState, rotateVector, serializeCubeInput, solvedCube, stickersAt,
  unrankCubeState, type CubeFace, type CubeMove, type Vector3,
} from "../shared/rubik.js";

test("quarter turns reproduce the pinned minirubik source tables and known dense ranks", () => {
  assert.equal(serializeCubeInput(SOLVED_STATE), "12345671111111");
  assert.equal(rankCubeState(SOLVED_STATE), 0);
  const right = applyMove(SOLVED_STATE, "R");
  assert.deepEqual(right.permutation, [0, 2, 5, 3, 1, 4, 6, 7]);
  assert.deepEqual(right.orientations, [0, 1, 2, 0, 2, 1, 0, 0]);
  assert.equal(serializeCubeInput(right), "25314672313211");
  assert.equal(rankCubeState(right), 805242);
  const back = applyMove(SOLVED_STATE, "B");
  assert.deepEqual(back.permutation, [0, 1, 2, 3, 5, 6, 7, 4]);
  assert.deepEqual(back.orientations, [0, 0, 0, 0, 1, 2, 1, 2]);
  assert.equal(serializeCubeInput(back), "12356741112323");
  assert.equal(rankCubeState(back), 6577);
  const down = applyMove(SOLVED_STATE, "D");
  assert.deepEqual(down.permutation, [0, 1, 3, 6, 4, 2, 5, 7]);
  assert.deepEqual(down.orientations, [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(serializeCubeInput(down), "13642571111111");
  assert.equal(rankCubeState(down), 144342);
  assert.deepEqual(parseCubeInput("13642571111111"), down);
});

test("the pinned README's eleven-move solution solves its exchanged-corner input", () => {
  const state = parseCubeInput("21345671111111");
  const solution: CubeMove[] = ["B'", "R'", "D2", "R'", "B", "R", "B'", "R", "D2", "B", "R'"];
  assert.equal(rankCubeState(state), 524880);
  assert.deepEqual(applyMoves(state, solution), SOLVED_STATE);
});

test("four quarters, inverse turns, and two halves restore mixed states without mutating their input", () => {
  for (const state of [solvedCube(), unrankCubeState(144342), unrankCubeState(2345678), unrankCubeState(CUBE_STATE_COUNT - 1)]) {
    const before = structuredClone(state);
    for (const face of ["R", "B", "D"] as const) {
      assert.deepEqual(applyMoves(state, [face, face, face, face]), state);
      assert.deepEqual(applyMoves(state, [`${face}2`, `${face}2`]), state);
    }
    for (const move of CUBE_MOVES) {
      const next = applyMove(state, move);
      assert.equal(next.permutation[0], 0); assert.equal(next.orientations[0], 0);
      assert.equal(next.orientations.reduce((sum, value) => sum + value, 0) % 3, 0);
      assert.equal(isValidCubeState(next), true);
      assert.deepEqual(applyMove(next, inverseMove(move)), state);
      assert.equal(inverseMove(inverseMove(move)), move);
    }
    assert.deepEqual(state, before);
  }
  assert.notStrictEqual(solvedCube().permutation, solvedCube().permutation);
});

// Independent coordinate transforms derived from clockwise turns as viewed
// outside RIGHT/BACK/DOWN. They do not use the module's source/twist tables.
const physicalTurn: Record<CubeFace, (v: Vector3) => Vector3> = {
  R: ([x, y, z]) => [x, z, -y],
  B: ([x, y, z]) => [-y, x, z],
  D: ([x, y, z]) => [z, y, -x],
};
const onFace: Record<CubeFace, (v: Vector3) => boolean> = {
  R: ([x]) => x === 1, B: ([, , z]) => z === -1, D: ([, y]) => y === -1,
};
const closeVector = (actual: Vector3, expected: Vector3) => actual.forEach((n, i) => assert.ok(Math.abs(n - expected[i]) < 1e-10));

test("corner positions and all sticker colors follow the same physical rotation, including mixed twists", () => {
  for (const state of [SOLVED_STATE, unrankCubeState(2345678)]) {
    for (const face of ["R", "B", "D"] as const) {
      const next = applyMove(state, face);
      let affected = 0;
      for (let position = 0; position < 8; position++) {
        const moving = onFace[face](CORNER_POSITIONS[position]);
        assert.equal(isCornerAffected(position, face), moving); if (moving) affected++;
        const destination = next.permutation.indexOf(state.permutation[position]);
        const expectedPosition = moving ? physicalTurn[face](CORNER_POSITIONS[position]) : CORNER_POSITIONS[position];
        closeVector(CORNER_POSITIONS[destination], expectedPosition);
        if (moving) closeVector(rotateVector(CORNER_POSITIONS[position], face), expectedPosition);
        const after = stickersAt(next, destination);
        for (const sticker of stickersAt(state, position)) {
          const result = after.find(other => other.homeFace === sticker.homeFace)!;
          assert.ok(result);
          closeVector(result.normal, moving ? physicalTurn[face](sticker.normal) : sticker.normal);
        }
      }
      assert.equal(affected, 4);
    }
  }
});

test("sticker bases are right-handed, solved stickers match their faces, and renderer rotations use explicit axes", () => {
  for (let position = 0; position < 8; position++) {
    const [a, b, c] = CORNER_FACE_ORDER[position].map(face => FACE_NORMALS[face]);
    const determinant = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    assert.equal(determinant, 1);
    for (const sticker of stickersAt(SOLVED_STATE, position)) assert.equal(sticker.homeFace, sticker.currentFace);
  }
  assert.deepEqual(moveRotation("R"), { axis: "x", layer: 1, angle: -90 });
  assert.deepEqual(moveRotation("B"), { axis: "z", layer: -1, angle: 90 });
  assert.deepEqual(moveRotation("D'"), { axis: "y", layer: -1, angle: -90 });
  assert.deepEqual(moveRotation("R2"), { axis: "x", layer: 1, angle: -180 });
  closeVector(rotateVector([1, 1, 1], "D", 0), [1, 1, 1]);
  closeVector(rotateVector([1, 1, 1], "D", 0.5), [Math.SQRT2, 1, 0]);
});

test("rank/unrank and input serialization round-trip all orientation codes across representative permutations", () => {
  for (const permutationRank of [0, 1, 198, 1104, 5039]) {
    for (let orientationRank = 0; orientationRank < 729; orientationRank++) {
      const rank = permutationRank * 729 + orientationRank;
      const state = unrankCubeState(rank);
      assert.equal(isValidCubeState(state), true);
      assert.equal(rankCubeState(state), rank);
      assert.deepEqual(parseCubeInput(serializeCubeInput(state)), state);
    }
  }
});

test("invalid digits, duplicate cubies, inconsistent twists, moved anchors, and out-of-range ranks are rejected", () => {
  for (const input of ["", "1234567111111", "123456711111111", "12345671111110", "12345671111114", "12345661111111", "12345672111111", " 12345671111111"]) assert.throws(() => parseCubeInput(input), RangeError);
  assert.equal(isValidCubeState({ permutation: [1, 0, 2, 3, 4, 5, 6, 7], orientations: Array(8).fill(0) }), false);
  assert.equal(isValidCubeState({ permutation: [...SOLVED_STATE.permutation], orientations: [1, 2, 0, 0, 0, 0, 0, 0] }), false);
  assert.equal(isValidCubeState({ permutation: [...SOLVED_STATE.permutation], orientations: [0, 1.5, 1.5, 0, 0, 0, 0, 0] }), false);
  const sparse = Array<number>(8); sparse[0] = 0;
  assert.equal(isValidCubeState({ permutation: [...SOLVED_STATE.permutation], orientations: sparse }), false);
  for (const rank of [-1, CUBE_STATE_COUNT, 0.5, NaN, Infinity]) assert.throws(() => unrankCubeState(rank), RangeError);
  assert.throws(() => applyMove(SOLVED_STATE, "U" as CubeMove), RangeError);
  assert.throws(() => stickersAt(SOLVED_STATE, 8), RangeError);
});
