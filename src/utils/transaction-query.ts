export type TransactionListQuery = {
  limit: number;
  cursor: string | null;
  status: "all" | "pending" | "completed" | "failed";
  search: string;
};

export function normalizeTransactionListQuery(input: Record<string, unknown>): TransactionListQuery {
  const parsedLimit = Number.parseInt(String(input.limit || "25"), 10);
  const limit = Math.min(50, Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 25));
  const cursor = String(input.cursor || "").trim() || null;
  const requestedStatus = String(input.status || "all").trim().toLowerCase();
  const status = ["pending", "completed", "failed"].includes(requestedStatus)
    ? requestedStatus as TransactionListQuery["status"]
    : "all";
  const search = String(input.search || "").trim().slice(0, 100);

  return { limit, cursor, status, search };
}

export function buildAdminTransactionPageQuery(query: TransactionListQuery) {
  const where: any = {};
  if (query.status !== "all") where.status = query.status;

  if (query.search) {
    where.OR = [
      { refNo: { contains: query.search, mode: "insensitive" } },
      { method: { contains: query.search, mode: "insensitive" } },
      { type: { contains: query.search, mode: "insensitive" } },
      {
        user: {
          is: {
            OR: [
              { fullName: { contains: query.search, mode: "insensitive" } },
              { email: { contains: query.search, mode: "insensitive" } },
              { username: { contains: query.search, mode: "insensitive" } }
            ]
          }
        }
      }
    ];
  }

  return {
    where,
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
    select: {
      id: true,
      userId: true,
      type: true,
      amount: true,
      method: true,
      status: true,
      refNo: true,
      createdAt: true,
      updatedAt: true,
      user: {
        select: {
          fullName: true,
          email: true,
          username: true,
          phone: true,
          balance: true
        }
      }
    }
  };
}
