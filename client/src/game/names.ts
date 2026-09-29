// Italian flavor for names and the kill feed.
const FIRST = ["Pesce", "Nonna", "Zio", "Signora", "Capitano", "Piccolo", "Dottore", "Maestro", "Bella", "Fratello", "Contessa", "Professore"];
const LAST = ["Veloce", "Bot", "Gelato", "Spruzzo", "Limone", "Polpo", "Tortellino", "Scampi", "Pomodoro", "Biscotto", "Sardina", "Vongola", "Pistacchio", "Fico", "Carciofo"];

export function dummyName(i: number): string {
  return `${FIRST[i % FIRST.length]} ${LAST[(i * 4 + 1) % LAST.length]}`;
}

const VERBS = ["splatted", "painted", "glazed", "sprinkled", "frosted", "drizzled", "dunked", "decorated", "spritzed"];
export function splatVerb(seed: number): string {
  return VERBS[Math.abs(seed) % VERBS.length];
}

export const STYLE_LABELS: [number, string][] = [
  [1, "in volo"], // airborne
  [2, "da lontano"], // long shot
  [4, "in gita"], // from a vehicle
  [8, "dal cielo"], // zipline
  [16, "in acqua"], // swimmer
  [32, "vendetta!"], // revenge
  [64, "tris!"], // streak
  [128, "in scivolata"], // sliding
];

export const ELIM_TITLES = ["Che splat!", "Mamma mia!", "Bellissimo!", "Magnifico!", "Perfetto!", "Bravo!"];
export const DEATH_TITLES = ["Splattato!", "Tutto dipinto!", "Che disastro!", "Ahi ahi ahi!"];

/** Local splat streak callouts (index = streak length; 1 uses ELIM_TITLES). */
export const STREAK_TITLES = ["", "", "Doppietta!", "Tris!", "Poker!", "Cinquina!", "Inarrestabile!"];
