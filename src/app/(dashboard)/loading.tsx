/** Instant skeleton while a dashboard route loads (shown by the app router). */
export default function DashboardLoading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="sticky top-0 flex h-14 items-center border-b bg-background px-4">
        <div className="h-5 w-40 animate-pulse rounded bg-muted" />
      </div>
      <div className="page">
        <div className="mb-4 h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 3xl:grid-cols-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-48 rounded-xl border bg-card p-3">
              <div className="mb-3 h-4 w-32 animate-pulse rounded bg-muted" />
              <div className="h-32 animate-pulse rounded bg-muted/60" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
