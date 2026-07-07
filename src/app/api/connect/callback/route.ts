import { redirect } from 'next/navigation'
import { completeConnectionFlow } from '../../../../lib/connections'
import { getDb } from '../../../../lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  await completeConnectionFlow(getDb())
  redirect('/')
}
