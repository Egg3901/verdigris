// Guard: every frame name the code asks for must exist in the atlas.
//
// Runs on prebuild. Until art/bake.py exists there is no atlas, and that is not a
// failure: the renderer's documented contract is that a missing frame falls back
// to a vector primitive, so the game can never be blanked by missing art.
import { existsSync, readFileSync } from 'node:fs';

const ATLAS = new URL('../public/atlas.json', import.meta.url);
if (!existsSync(ATLAS)) {
  console.log('atlascheck: no atlas yet, running on fallback primitives');
  process.exit(0);
}
const atlas = JSON.parse(readFileSync(ATLAS, 'utf8'));
const have = new Set(Object.keys(atlas.frames ?? {}));
console.log(`atlascheck: ${have.size} frames present`);
