import { dirname, filename, wasmPath, wasmByteLength } from 'my-wasm-pkg'

export const dynamic = 'force-dynamic'

export function GET() {
  return Response.json({ dirname, filename, wasmPath, wasmByteLength })
}
