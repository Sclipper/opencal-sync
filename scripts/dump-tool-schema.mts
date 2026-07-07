// Usage: COMPOSIO_API_KEY=... npx tsx scripts/dump-tool-schema.mts GOOGLECALENDAR_CREATE_EVENT
export {}

const slug = process.argv[2]
if (!slug || !process.env.COMPOSIO_API_KEY) {
  console.error('Usage: COMPOSIO_API_KEY=... npx tsx scripts/dump-tool-schema.mts <TOOL_SLUG>')
  process.exit(1)
}

const res = await fetch(`https://backend.composio.dev/api/v3/tools/${slug}`, {
  headers: { 'x-api-key': process.env.COMPOSIO_API_KEY },
})
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${await res.text()}`)
  process.exit(1)
}
const tool = await res.json()
console.log(JSON.stringify(tool.input_parameters ?? tool, null, 2))
