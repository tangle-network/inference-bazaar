import { useRouteError } from 'react-router-dom'

/**
 * Route-level error boundary. A malformed venue/catalog response that slips past
 * the typed assumptions (or any render throw) degrades to this panel instead of
 * white-screening the whole app. Wired as every route's `errorElement`.
 */
export function RouteError() {
  const err = useRouteError()
  const msg =
    err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unexpected error.'
  return (
    <div className="px-6 py-16 text-center">
      <div className="font-body text-[18px] font-semibold text-[var(--s-text)]">
        Something broke on this page
      </div>
      <div className="mx-auto mt-2 max-w-[520px] truncate font-data text-[13px] text-[var(--s-text-muted)]">
        {msg}
      </div>
      <button onClick={() => window.location.reload()} className="btn-primary mt-4 h-9">
        Reload
      </button>
    </div>
  )
}
