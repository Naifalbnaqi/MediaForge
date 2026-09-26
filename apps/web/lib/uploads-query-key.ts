/**
 * TanStack Query key for the "my files" list (`listUploads`). Shared by
 * `file-list.tsx` (the query owner), `upload-form.tsx` (invalidates on a
 * successful upload), and `file-row.tsx` (invalidates/optimistically updates
 * on a successful processing request) so they all read/write the same cache
 * entry. Kept in its own module (rather than exported from `file-list.tsx`)
 * so `file-list.tsx` and `file-row.tsx` can import from a common place
 * without a circular import between the two components.
 */
export const UPLOADS_QUERY_KEY = ['uploads'] as const;
