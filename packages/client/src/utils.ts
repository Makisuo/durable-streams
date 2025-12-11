/**
 * Shared utility functions for the Durable Streams client.
 */

import { DurableStreamError } from "./error"
import type { Auth, MaybePromise } from "./types"

/**
 * Resolve headers from auth and additional headers.
 * Unified implementation used by both stream() and DurableStream.
 */
export async function resolveHeaders(
  auth: Auth | undefined,
  additionalHeaders?:
    | HeadersInit
    | Record<string, string | (() => MaybePromise<string>)>
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {}

  // Resolve auth
  if (auth) {
    if (`token` in auth) {
      const headerName = auth.headerName ?? `authorization`
      headers[headerName] = `Bearer ${auth.token}`
    } else if (`headers` in auth) {
      Object.assign(headers, auth.headers)
    } else if (`getHeaders` in auth) {
      const authHeaders = await auth.getHeaders()
      Object.assign(headers, authHeaders)
    }
  }

  // Resolve additional headers
  if (additionalHeaders) {
    if (additionalHeaders instanceof Headers) {
      additionalHeaders.forEach((value, key) => {
        headers[key] = value
      })
    } else if (Array.isArray(additionalHeaders)) {
      for (const [key, value] of additionalHeaders) {
        headers[key] = value
      }
    } else {
      // Object - may contain sync values or async functions
      for (const [key, value] of Object.entries(additionalHeaders)) {
        if (typeof value === `function`) {
          headers[key] = await (value as () => MaybePromise<string>)()
        } else {
          headers[key] = value
        }
      }
    }
  }

  return headers
}

/**
 * Handle error responses from the server.
 * Throws appropriate DurableStreamError based on status code.
 */
export async function handleErrorResponse(
  response: Response,
  url: string,
  context?: { operation?: string }
): Promise<never> {
  const status = response.status

  if (status === 404) {
    throw new DurableStreamError(`Stream not found: ${url}`, `NOT_FOUND`, 404)
  }

  if (status === 409) {
    // Context-specific 409 messages
    const message =
      context?.operation === `create`
        ? `Stream already exists: ${url}`
        : `Sequence conflict: seq is lower than last appended`
    const code =
      context?.operation === `create` ? `CONFLICT_EXISTS` : `CONFLICT_SEQ`
    throw new DurableStreamError(message, code, 409)
  }

  if (status === 400) {
    throw new DurableStreamError(
      `Bad request (possibly content-type mismatch)`,
      `BAD_REQUEST`,
      400
    )
  }

  throw await DurableStreamError.fromResponse(response, url)
}

/**
 * Create a ReadableStream from an async iterator with standard pull/cancel semantics.
 */
export function iteratorToReadableStream<T, R>(
  iterator: AsyncIterator<T>,
  transform: (value: T) => R
): ReadableStream<R> {
  return new ReadableStream<R>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next()
        if (done) {
          controller.close()
        } else {
          controller.enqueue(transform(value))
        }
      } catch (e) {
        controller.error(e)
      }
    },

    cancel() {
      void iterator.return?.()
    },
  })
}

/**
 * Resolve a value that may be a function returning a promise.
 */
export async function resolveValue<T>(
  value: T | (() => MaybePromise<T>)
): Promise<T> {
  if (typeof value === `function`) {
    return (value as () => MaybePromise<T>)()
  }
  return value
}
