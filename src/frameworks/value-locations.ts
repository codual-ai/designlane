/** Where values are written, as every framework's reader records them: a value's span and what it holds, and the
 * names it's reached through. */

import type { CodeSpan, ColorLocations, TypeLocations, ValueKind, ValueLocation } from "../scan/types.js";

/** `span` as the place a value of `kind` is written. */
export const valueAt = (span: CodeSpan, kind: ValueKind): ValueLocation => ({ ...span, kind });

/** `{ locations }` to spread into a token, or nothing when none of its values' places is known. */
export const withLocations = <T extends ColorLocations | TypeLocations>(locations: T): { locations?: T } =>
  Object.keys(locations).length > 0 ? { locations } : {};

/** `location` reached through the names written at `names`, the first one reached first. */
export const through = (location: ValueLocation, names: readonly CodeSpan[]): ValueLocation =>
  names.length === 0 ? location : { ...location, via: [...names, ...(location.via ?? [])] };

/**
 * Follows names from `first` to the value they lead to: `next` gives what a name leads to, or null when what it's
 * given is the value itself. What holds the value, with where each name on the way is written; undefined at a name
 * leading nowhere, or after `max` names, which is a loop.
 */
export function followNames<T>(
  first: T,
  next: (at: T) => T | undefined | null,
  nameAt: (at: T) => CodeSpan,
  max: number,
): { target: T; via: CodeSpan[] } | undefined {
  const via: CodeSpan[] = [];
  let at: T | undefined = first;
  for (let names = 0; at !== undefined && names <= max; names++) {
    const to = next(at);
    if (to === null) return { target: at, via };
    via.push(nameAt(at));
    at = to;
  }
  return undefined;
}
