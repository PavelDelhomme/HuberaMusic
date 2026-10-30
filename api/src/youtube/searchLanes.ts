/**
 * Recherche YouTube : la liste visible ne doit pas attendre la voie la plus lente
 * (album, orthographe, getTrack, paroles, repli web).
 */

/** Pas de sursis : dès que la liste Innertube est là, on répond. */
export const SEARCH_LIST_GRACE_MS = 0;
export const SEARCH_LIST_HARD_CAP_MS = 8_500;
/** Catalogue vide seulement. Jamais le repli web de 12 s sur le chemin de la liste. */
export const SEARCH_WEB_EMPTY_BUDGET_MS = 700;

export type SearchLaneResult<T> = {
  values: Partial<Record<string, T>>;
  /** Voies encore en vol quand la liste est déjà renvoyée. */
  pending: string[];
  waitedMs: number;
};

export async function collectSearchLanes<T>(
  lanes: Record<string, Promise<T>>,
  opts: {
    /** Voies qui portent la liste (titres). Dès que l’une a des items, les autres n’ont qu’un court sursis. */
    listLanes: string[];
    hasList: (value: T) => boolean;
    graceMs: number;
    hardCapMs: number;
  },
): Promise<SearchLaneResult<T>> {
  const names = Object.keys(lanes);
  const values: Partial<Record<string, T>> = {};
  const pending = new Set(names);
  const t0 = Date.now();

  if (!names.length) {
    return { values, pending: [], waitedMs: 0 };
  }

  return new Promise((resolve) => {
    let listReady = false;
    let done = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const hardTimer = setTimeout(finish, Math.max(0, opts.hardCapMs));

    function finish() {
      if (done) return;
      done = true;
      if (graceTimer) clearTimeout(graceTimer);
      clearTimeout(hardTimer);
      resolve({
        values,
        pending: [...pending],
        waitedMs: Date.now() - t0,
      });
    }

    function armGrace() {
      if (graceTimer || !listReady || done) return;
      graceTimer = setTimeout(finish, Math.max(0, opts.graceMs));
    }

    for (const name of names) {
      lanes[name].then(
        (value) => {
          if (done) return;
          values[name] = value;
          pending.delete(name);
          if (!listReady && opts.listLanes.includes(name) && opts.hasList(value)) {
            listReady = true;
            armGrace();
          }
          if (pending.size === 0) finish();
        },
        () => {
          if (done) return;
          pending.delete(name);
          if (pending.size === 0) finish();
        },
      );
    }
  });
}

/**
 * Rend la liste tout de suite. La promesse lente (paroles, getTrack, repli web)
 * continue à côté et ne retient pas l’appelant.
 */
export function listWithoutSlowPath<T>(list: T, slow: Promise<unknown>): T {
  void slow.then(
    () => {},
    () => {},
  );
  return list;
}
