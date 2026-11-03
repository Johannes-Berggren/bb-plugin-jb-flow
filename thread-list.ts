// threads.list returns archived threads too unless told otherwise, and one page
// holds at most 500 rows. Anything that reads a single unfiltered page silently
// loses live threads once enough have been archived.

const PAGE_SIZE = 500;

type ListArgs = { archived: boolean; limit: number; offset: number; sectionId?: string; signal?: AbortSignal };
type ThreadLister<T> = { sdk: { threads: { list(args: ListArgs): Promise<T[]> } } };

/** Every thread that isn't archived, across all pages. Hidden threads stay out, as in threads.list. */
export async function listLiveThreads<T extends { id: string }>(
  bb: ThreadLister<T>,
  filter: { sectionId?: string; signal?: AbortSignal } = {},
): Promise<T[]> {
  // By id: a thread changing while we page can show up on two pages.
  const threads = new Map<string, T>();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await bb.sdk.threads.list({ ...filter, archived: false, limit: PAGE_SIZE, offset });
    for (const thread of page) threads.set(thread.id, thread);
    if (page.length < PAGE_SIZE) return [...threads.values()];
  }
}
