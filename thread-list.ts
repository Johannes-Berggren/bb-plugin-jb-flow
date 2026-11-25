// threads.list returns archived threads too unless told otherwise, and one page
// holds at most 500 rows. Anything that reads a single unfiltered page silently
// loses live threads once enough have been archived. environments.list has the
// same cap, so both are read page by page here.

const PAGE_SIZE = 500;

type ListArgs = { archived?: boolean; includeHidden?: boolean; limit: number; offset: number; sectionId?: string; signal?: AbortSignal };
type ThreadLister<T> = { sdk: { threads: { list(args: ListArgs): Promise<T[]> } } };

/** Every thread that isn't archived, across all pages. Hidden threads stay out, as in threads.list. */
export function listLiveThreads<T extends { id: string }>(
  bb: ThreadLister<T>,
  filter: { sectionId?: string; signal?: AbortSignal } = {},
): Promise<T[]> {
  return listThreadPages(bb, { ...filter, archived: false });
}

export function listThreadPages<T extends { id: string }>(
  bb: ThreadLister<T>,
  filter: Omit<ListArgs, "limit" | "offset">,
): Promise<T[]> {
  return allPages((page) => bb.sdk.threads.list({ ...filter, ...page }));
}

type EnvironmentListArgs = { limit: number; offset: number; signal?: AbortSignal };
type EnvironmentLister<T> = { sdk: { environments: { list(args: EnvironmentListArgs): Promise<T[]> } } };

/**
 * Every environment, across all pages. environments.list caps a call without a
 * limit at 200 rows and rejects a limit above 500, so it has to be paged too.
 */
export function listEnvironmentPages<T extends { id: string }>(
  bb: EnvironmentLister<T>,
  filter: { signal?: AbortSignal } = {},
): Promise<T[]> {
  return allPages((page) => bb.sdk.environments.list({ ...filter, ...page }));
}

async function allPages<T extends { id: string }>(
  read: (page: { limit: number; offset: number }) => Promise<T[]>,
): Promise<T[]> {
  // By id: a row changing while we page can show up on two pages.
  const rows = new Map<string, T>();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await read({ limit: PAGE_SIZE, offset });
    for (const row of page) rows.set(row.id, row);
    if (page.length < PAGE_SIZE) return [...rows.values()];
  }
}
