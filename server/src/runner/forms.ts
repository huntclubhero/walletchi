// WALLETCHI FINAL FORM (evolution stage 4): past PRIME a pet grows into a final form.
// The catalogue is a surprise and is not part of this public snapshot: this file keeps the
// same exports with a single placeholder form so the rest of the code reads and builds.
// The feature ships behind FORMS_ENABLED (off by default).

export type Pal = Record<string, string>;

export interface Part {
  g: string[]; // rows of cell letters ('.' = empty)
  dx: number; // offset in cells from the body's top-left cell
  dy: number;
}

export interface FormDef {
  key: string;
  name: string;
  family: string;
  note: string;
  behind: Part[]; // under the body
  front: Part[]; // over the body
  feet: boolean;
  spikes?: boolean;
}

export interface Extent {
  l: number;
  r: number;
  t: number;
  b: number;
}

export const FORMS: readonly FormDef[] = [
  { key: "secret", name: "Final Form", family: "Secret", note: "revealed in the game", behind: [], front: [], feet: true },
];

export const FAMILIES = [...new Set(FORMS.map((f) => f.family))];

export interface RolledForm extends FormDef {
  ext: Extent;
  rngSeed: number;
}

/** The form a pet grows into. Placeholder in the public snapshot. */
export function formFor(_seed: string, _force?: string): RolledForm {
  return { ...FORMS[0]!, ext: { l: 0, r: 0, t: 0, b: 0 }, rngSeed: 0 };
}

export const isFormKey = (k: unknown): k is string => typeof k === "string" && FORMS.some((f) => f.key === k);

export interface FormLayers {
  behind: string;
  front: string;
}

/** The form's markup around a body. Placeholder in the public snapshot: draws nothing. */
export function formMarkup(_form: RolledForm, _ox: number, _oy: number, _cell: number, _pal: Pal, _body: string[]): FormLayers {
  return { behind: "", front: "" };
}
