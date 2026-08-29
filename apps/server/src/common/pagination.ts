import { PageResult } from '@ai-trader/shared';

export interface PaginationParams {
  page?: number;
  pageSize?: number;
}

export function normalizePagination(params: PaginationParams = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 20));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function toPageResult<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
): PageResult<T> {
  return { items, total, page, pageSize };
}
