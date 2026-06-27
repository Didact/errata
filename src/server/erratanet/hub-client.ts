import { getErratanetConfig } from '../config/storage'
import type { ErratapackManifest } from '../../lib/erratanet/pack-schema'

/**
 * The only module that talks to the remote erratanet hub.
 *
 * Every call reads `hubUrl` + `token` from `getErratanetConfig(dataDir)`. On a
 * non-ok response the hub's own `{ error }` message (or status text) is surfaced
 * as a normalized `Error`, so callers never have to dig through the raw HTTP
 * shape. Auth is `Authorization: Bearer <token>`; search is public.
 */

/** A package as the hub returns it from search / detail endpoints. */
export interface HubPackageSummary {
  id: string
  title?: string
  description?: string
  publisher?: string
  latestVersion?: string
  versions?: string[]
  [key: string]: unknown
}

/** The authenticated account, per `GET /api/v1/me`. */
export interface HubAccount {
  handle: string
  [key: string]: unknown
}

/** Result of publishing a new version. */
export interface HubPublishResult {
  id: string
  version: string
  [key: string]: unknown
}

/** Result of exchanging credentials for an API token. */
export interface HubLoginResult {
  token: string
  handle: string
  displayName?: string
}

export interface HubClient {
  getAccount(dataDir: string): Promise<HubAccount>
  search(dataDir: string, query: string): Promise<HubPackageSummary[]>
  getPack(dataDir: string, id: string, version?: string): Promise<HubPackageSummary>
  downloadPack(dataDir: string, id: string, version?: string): Promise<ArrayBuffer>
  publishVersion(
    dataDir: string,
    id: string,
    manifest: ErratapackManifest,
    packZip: Uint8Array,
    opts?: { unlisted?: boolean },
  ): Promise<HubPublishResult>
  login(
    hubUrl: string,
    identifier: string,
    password: string,
    name?: string,
  ): Promise<HubLoginResult>
}

/** Read hub connection config, throwing a clear error when not configured. */
async function resolveHub(dataDir: string): Promise<{ hubUrl: string; token: string }> {
  const config = await getErratanetConfig(dataDir)
  const hubUrl = config.hubUrl.trim().replace(/\/+$/, '')
  if (!hubUrl) {
    throw new Error('No erratanet hub configured. Set a hub URL in Settings first.')
  }
  return { hubUrl, token: config.token }
}

/** Build the absolute hub URL for a path, appending an optional query. */
function hubEndpoint(hubUrl: string, path: string, query?: Record<string, string | undefined>): string {
  const url = new URL(path.startsWith('/') ? path.slice(1) : path, hubUrl + '/')
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value)
    }
  }
  return url.toString()
}

/** Bearer auth header, omitted when no token is set. */
function authHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/**
 * Turn a non-ok response into a normalized Error using the hub's `{ error }`
 * message when present, falling back to plain text or the status line.
 */
async function hubError(res: Response): Promise<Error> {
  let message = res.statusText || `Request failed with status ${res.status}`
  const body = await res.text().catch(() => '')
  if (body) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown; message?: unknown }
      const fromJson = parsed.error ?? parsed.message
      if (typeof fromJson === 'string' && fromJson.trim()) {
        message = fromJson.trim()
      } else {
        message = body
      }
    } catch {
      message = body
    }
  }
  return new Error(message)
}

/** Parse a JSON body, normalizing any failure into a readable Error. */
async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw await hubError(res)
  return (await res.json()) as T
}

export async function getAccount(dataDir: string): Promise<HubAccount> {
  const { hubUrl, token } = await resolveHub(dataDir)
  const res = await fetch(hubEndpoint(hubUrl, '/api/v1/me'), {
    headers: { Accept: 'application/json', ...authHeaders(token) },
  })
  return parseJson<HubAccount>(res)
}

export async function search(dataDir: string, query: string): Promise<HubPackageSummary[]> {
  const { hubUrl } = await resolveHub(dataDir)
  const res = await fetch(hubEndpoint(hubUrl, '/api/v1/packages', { q: query }), {
    headers: { Accept: 'application/json' },
  })
  const json = await parseJson<
    { results?: HubPackageSummary[]; packages?: HubPackageSummary[] } | HubPackageSummary[]
  >(res)
  if (Array.isArray(json)) return json
  return json.results ?? json.packages ?? []
}

export async function getPack(
  dataDir: string,
  id: string,
  version?: string,
): Promise<HubPackageSummary> {
  const { hubUrl, token } = await resolveHub(dataDir)
  const res = await fetch(
    hubEndpoint(hubUrl, `/api/v1/packages/${encodeURIComponent(id)}`, { version }),
    { headers: { Accept: 'application/json', ...authHeaders(token) } },
  )
  return parseJson<HubPackageSummary>(res)
}

export async function downloadPack(
  dataDir: string,
  id: string,
  version?: string,
): Promise<ArrayBuffer> {
  const { hubUrl, token } = await resolveHub(dataDir)
  const ver = version ?? 'latest'
  // fetch follows the 302 redirect to the underlying blob storage automatically.
  const res = await fetch(
    hubEndpoint(
      hubUrl,
      `/api/v1/packages/${encodeURIComponent(id)}/versions/${encodeURIComponent(ver)}/download`,
    ),
    { headers: { ...authHeaders(token) }, redirect: 'follow' },
  )
  if (!res.ok) throw await hubError(res)
  return res.arrayBuffer()
}

export async function publishVersion(
  dataDir: string,
  id: string,
  manifest: ErratapackManifest,
  packZip: Uint8Array,
  opts?: { unlisted?: boolean },
): Promise<HubPublishResult> {
  const { hubUrl, token } = await resolveHub(dataDir)
  const form = new FormData()
  form.set('manifest', JSON.stringify(manifest))
  // Copy into a fresh, exactly-sized buffer so Blob never sees a pooled/oversized
  // ArrayBuffer backing the view.
  const bytes = packZip.slice()
  form.set('pack', new Blob([bytes], { type: 'application/zip' }), `${manifest.version}.errata.zip`)
  if (opts?.unlisted !== undefined) form.set('unlisted', opts.unlisted ? 'true' : 'false')
  const res = await fetch(
    hubEndpoint(hubUrl, `/api/v1/packages/${encodeURIComponent(id)}/versions`),
    {
      method: 'POST',
      headers: { ...authHeaders(token) },
      body: form,
    },
  )
  return parseJson<HubPublishResult>(res)
}

/**
 * Exchange username/email + password for a fresh API token. Unlike the other
 * calls this takes the hub URL + credentials directly: there is no stored token
 * yet, this is how one is obtained. The caller stores the returned token.
 */
export async function login(
  hubUrl: string,
  identifier: string,
  password: string,
  name = 'Errata',
): Promise<HubLoginResult> {
  const base = hubUrl.trim().replace(/\/+$/, '')
  if (!base) throw new Error('Enter a hub URL.')
  const res = await fetch(hubEndpoint(base, '/api/v1/tokens'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identifier, password, name }),
  })
  return parseJson<HubLoginResult>(res)
}

/** Convenience object implementing the `HubClient` interface. */
export const hubClient: HubClient = {
  getAccount,
  search,
  getPack,
  downloadPack,
  publishVersion,
  login,
}
