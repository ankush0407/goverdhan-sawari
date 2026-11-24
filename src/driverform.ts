// Driver sign-up in ONE message: name, vehicle number and seats, in any order, with or without commas.

// State and union-territory codes that start an Indian plate (TG is Telangana's code since 2024; TS is its old one).
const STATE_CODES = new Set('AN AP AR AS BR CG CH DD DL DN GA GJ HP HR JH JK KA KL LA LD MH ML MN MP MZ NL OD OR PB PY RJ SK TG TN TR TS UA UK UP WB'.split(' '));

/** Indian registration plate → tidy form ("up-85-ab 1234" → "UP85 AB 1234"), or null if it doesn't look like one. */
export function normalizePlate(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  let m = s.match(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{4})$/); // UP85 AB 1234, UP85 1234
  if (m && STATE_CODES.has(m[1])) return [m[1] + m[2], m[3], m[4]].filter(Boolean).join(' ');
  m = s.match(/^(\d{2})BH(\d{4})([A-Z]{1,2})$/); // Bharat series: 22 BH 1234 AA
  if (m) return `${m[1]} BH ${m[2]} ${m[3]}`;
  return null;
}

export type DriverDetails = { name?: string; plate?: string; seats?: number };

// A plate inside a longer message, with or without spaces and dashes: UP85 AB 1234, up-85-ab-1234, UP85 1234, 22 BH 1234 AA.
const PLATE_IN_TEXT = /(?<![A-Za-z0-9])(?:[A-Za-z]{2}[\s-]*\d{1,2}[\s-]*(?:[A-Za-z]{1,3}[\s-]*)?\d{4}|\d{2}[\s-]*BH[\s-]*\d{4}[\s-]*[A-Za-z]{1,2})(?![A-Za-z0-9])/i;
// Words that label a field or just pad a sentence; they are not part of a name.
const FILLER = /\b(?:full\s*name|name|vehicle|number|plate|seats?|seater|seating|i\s*am|i'm|my|is|and|hai|mera|naam)\b|नाम|गाड़ी|नंबर|सीटें|सीट/giu;

/**
 * Pulls whatever it can out of a message: the vehicle number (validated and tidied), the seat count (the last standalone
 * number from 2 to 8: "4", "5 seats", "4-seater") and the name (what is left). Fields it cannot find are simply absent.
 */
export function parseDriverDetails(text: string): DriverDetails {
  const out: DriverDetails = {};
  let rest = text;

  const pm = rest.match(PLATE_IN_TEXT);
  if (pm) {
    const plate = normalizePlate(pm[0]);
    if (plate) { out.plate = plate; rest = rest.replace(pm[0], ' '); }
  }

  let seats: RegExpMatchArray | undefined;
  for (const m of rest.matchAll(/(?<![\w.])(\d{1,2})(?!\w)(?!\.\d)/g)) if (+m[1] >= 2 && +m[1] <= 8) seats = m;
  if (seats) {
    out.seats = +seats[1];
    rest = rest.slice(0, seats.index!) + ' ' + rest.slice(seats.index! + seats[0].length);
  }

  const name = rest.replace(FILLER, ' ').split(/[,;\n|:]+|\s-\s/)
    .map((s) => s.replace(/^[\s.\-]+|[\s.\-]+$/g, '').replace(/\s+/g, ' '))
    .find((s) => /\p{L}.*\p{L}/u.test(s));
  if (name) out.name = name.slice(0, 60);
  return out;
}
