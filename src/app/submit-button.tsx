'use client'

import { useFormStatus } from 'react-dom'

// Server-action buttons that hit a provider API sit pending for seconds (link cleanup deletes one
// event per API call) with no visual change — people assume it failed and reload, which throws away
// the action's revalidated payload. This just reports the pending state React already tracks.
export function SubmitButton({ className, pendingLabel, children }: {
  className?: string
  pendingLabel: string
  children: React.ReactNode
}) {
  const { pending } = useFormStatus()
  return (
    <button className={`${className ?? ''} disabled:cursor-wait disabled:opacity-50`} disabled={pending} aria-busy={pending}>
      {pending ? pendingLabel : children}
    </button>
  )
}
