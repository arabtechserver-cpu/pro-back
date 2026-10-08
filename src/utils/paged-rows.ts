export async function* pagedRows(model: any, query: any = {}, pageSize = 100): AsyncGenerator<any> {
  let cursor: string | undefined;
  while (true) {
    const rows = await model.findMany({
      ...query, take: pageSize, orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    for (const row of rows) yield row;
    if (rows.length < pageSize) return;
    cursor = rows[rows.length - 1].id;
  }
}
