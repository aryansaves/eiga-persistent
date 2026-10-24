/** The only uploaded content is a versioned, normalized library. */
export interface Snapshot {
  version: 1;
  films: {
    id: string;
    title: string;
    year: number | null;
    uri: string | null;
    directors: string[];
  }[];
  watches: { filmId: string; watchedOn: string | null; rewatch: boolean }[];
  ratings: [string, number][];
  reviews: [string, string][];
  likes: string[];
}

export const MAX_SNAPSHOT_BYTES = 1_500_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !value.includes("\0")
  );
}

function date(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function filmUri(value: unknown): value is string | null {
  if (value === null) return true;
  if (!text(value, 2048)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.hostname === "letterboxd.com" ||
        url.hostname === "boxd.it" ||
        url.hostname === "www.letterboxd.com")
    );
  } catch {
    return false;
  }
}

/** Rebuild every object, discarding unknown properties rather than storing them. */
export function parseSnapshot(value: unknown): Snapshot {
  const invalid = () => {
    throw new Error("The saved library has an unsupported or invalid format.");
  };
  if (
    !record(value) ||
    value.version !== 1 ||
    !Array.isArray(value.films) ||
    !Array.isArray(value.watches) ||
    !Array.isArray(value.ratings) ||
    !Array.isArray(value.reviews) ||
    !Array.isArray(value.likes)
  )
    return invalid();
  if (
    value.films.length < 1 ||
    value.films.length > 20_000 ||
    value.watches.length > 100_000
  )
    return invalid();
  const ids = new Set<string>();
  const films = value.films.map((film) => {
    if (
      !record(film) ||
      !text(film.id, 1024) ||
      ids.has(film.id) ||
      !text(film.title, 1024) ||
      !(
        film.year === null ||
        (typeof film.year === "number" &&
          Number.isInteger(film.year) &&
          film.year >= 1800 &&
          film.year <= 3000)
      ) ||
      !filmUri(film.uri) ||
      !Array.isArray(film.directors) ||
      film.directors.length > 100 ||
      !film.directors.every((director) => text(director, 512))
    )
      return invalid();
    ids.add(film.id);
    return {
      id: film.id,
      title: film.title,
      year: film.year,
      uri: film.uri,
      directors: film.directors as string[],
    };
  });
  const watches = value.watches.map((watch) => {
    if (
      !record(watch) ||
      typeof watch.filmId !== "string" ||
      !ids.has(watch.filmId) ||
      !date(watch.watchedOn) ||
      typeof watch.rewatch !== "boolean"
    )
      return invalid();
    return {
      filmId: watch.filmId,
      watchedOn: watch.watchedOn,
      rewatch: watch.rewatch,
    };
  });
  function entries<T>(
    values: unknown[],
    check: (v: unknown) => v is T,
  ): [string, T][] {
    const seen = new Set<string>();
    if (values.length > ids.size) return invalid();
    return values.map((entry) => {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        !ids.has(entry[0]) ||
        seen.has(entry[0]) ||
        !check(entry[1])
      )
        return invalid();
      seen.add(entry[0]);
      return [entry[0], entry[1]];
    });
  }
  const ratings = entries(
    value.ratings,
    (v): v is number =>
      typeof v === "number" && v >= 0.5 && v <= 5 && Number.isInteger(v * 2),
  );
  const reviews = entries(
    value.reviews,
    (v): v is string =>
      typeof v === "string" && v.length <= 100_000 && !v.includes("\0"),
  );
  if (
    value.likes.length > ids.size ||
    !value.likes.every((id) => typeof id === "string" && ids.has(id)) ||
    new Set(value.likes).size !== value.likes.length
  )
    return invalid();
  const snapshot: Snapshot = {
    version: 1,
    films,
    watches,
    ratings,
    reviews,
    likes: value.likes as string[],
  };
  if (
    new TextEncoder().encode(JSON.stringify(snapshot)).byteLength >
    MAX_SNAPSHOT_BYTES
  )
    throw new Error(
      "This library is too large to save. The limit is 1.5 MB of normalized data.",
    );
  return snapshot;
}
