/**
 * StreamResponse - A streaming session for reading from a durable stream.
 *
 * Represents a live session with fixed `url`, `offset`, and `live` parameters.
 * Supports multiple consumption styles: Promise helpers, ReadableStreams, and Subscribers.
 */

import { DurableStreamError } from "./error"
import {
  STREAM_CURSOR_HEADER,
  STREAM_OFFSET_HEADER,
  STREAM_UP_TO_DATE_HEADER,
} from "./constants"
import type {
  ByteChunk,
  StreamResponse as IStreamResponse,
  JsonBatch,
  LiveMode,
  Offset,
  TextChunk,
} from "./types"

/**
 * Session state machine.
 */
enum SessionState {
  /** First response received, Response object held (body not read) */
  Ready = `ready`,
  /** At least one consumer (stream/subscriber) is active */
  Consuming = `consuming`,
  /** Completed, cancelled, or errored */
  Closed = `closed`,
}

/**
 * Internal configuration for creating a StreamResponse.
 */
export interface StreamResponseConfig {
  /** The stream URL */
  url: string
  /** Content type from the first response */
  contentType?: string
  /** Live mode for this session */
  live: LiveMode
  /** Starting offset */
  startOffset: Offset
  /** Whether to treat as JSON (hint or content-type) */
  isJsonMode: boolean
  /** Initial offset from first response headers */
  initialOffset: Offset
  /** Initial cursor from first response headers */
  initialCursor?: string
  /** Initial upToDate from first response headers */
  initialUpToDate: boolean
  /** The held first Response object */
  firstResponse: Response
  /** Abort controller for the session */
  abortController: AbortController
  /** Function to fetch the next chunk (for long-poll) */
  fetchNext: (
    offset: Offset,
    cursor: string | undefined,
    signal: AbortSignal
  ) => Promise<Response>
  /** Function to start SSE and return an async iterator */
  startSSE?: (
    offset: Offset,
    cursor: string | undefined,
    signal: AbortSignal
  ) => AsyncIterator<ByteChunk>
}

/**
 * Implementation of the StreamResponse interface.
 */
export class StreamResponseImpl<
  TJson = unknown,
> implements IStreamResponse<TJson> {
  // --- Static session info ---
  readonly url: string
  readonly contentType?: string
  readonly live: LiveMode
  readonly startOffset: Offset

  // --- Evolving state ---
  offset: Offset
  cursor?: string
  upToDate: boolean

  // --- Internal state ---
  #state: SessionState = SessionState.Ready
  #isJsonMode: boolean
  #firstResponse: Response | null
  #abortController: AbortController
  #fetchNext: StreamResponseConfig[`fetchNext`]
  #startSSE?: StreamResponseConfig[`startSSE`]
  #closedResolve!: () => void
  #closedReject!: (err: Error) => void
  #closed: Promise<void>
  #stopAfterUpToDate = false
  #sseIterator: AsyncIterator<ByteChunk> | null = null

  constructor(config: StreamResponseConfig) {
    this.url = config.url
    this.contentType = config.contentType
    this.live = config.live
    this.startOffset = config.startOffset
    this.offset = config.initialOffset
    this.cursor = config.initialCursor
    this.upToDate = config.initialUpToDate

    this.#isJsonMode = config.isJsonMode
    this.#firstResponse = config.firstResponse
    this.#abortController = config.abortController
    this.#fetchNext = config.fetchNext
    this.#startSSE = config.startSSE

    this.#closed = new Promise((resolve, reject) => {
      this.#closedResolve = resolve
      this.#closedReject = reject
    })
  }

  // =================================
  // Internal helpers
  // =================================

  #ensureJsonMode(): void {
    if (!this.#isJsonMode) {
      throw new DurableStreamError(
        `JSON methods are only valid for JSON-mode streams. ` +
          `Content-Type is "${this.contentType}" and json hint was not set.`,
        `BAD_REQUEST`
      )
    }
  }

  #markConsuming(): void {
    if (this.#state === SessionState.Ready) {
      this.#state = SessionState.Consuming
    }
  }

  #markClosed(): void {
    if (this.#state !== SessionState.Closed) {
      this.#state = SessionState.Closed
      this.#closedResolve()
    }
  }

  #markError(err: Error): void {
    if (this.#state !== SessionState.Closed) {
      this.#state = SessionState.Closed
      this.#closedReject(err)
    }
  }

  /**
   * Determine if we should continue with live updates based on live mode
   * and whether a promise helper signaled to stop.
   */
  #shouldContinueLive(): boolean {
    if (this.#stopAfterUpToDate) return false
    if (this.live === false) return false
    return true
  }

  /**
   * Update state from response headers.
   */
  #updateStateFromResponse(response: Response): void {
    const offset = response.headers.get(STREAM_OFFSET_HEADER)
    if (offset) this.offset = offset
    const cursor = response.headers.get(STREAM_CURSOR_HEADER)
    if (cursor) this.cursor = cursor
    this.upToDate = response.headers.has(STREAM_UP_TO_DATE_HEADER)
  }

  /**
   * Create the core byte stream that handles the first response and live updates.
   * This is optimized to pipe from fetch response bodies.
   */
  #createByteStream(): ReadableStream<ByteChunk> {
    this.#markConsuming()

    const self = this
    let firstResponseConsumed = false

    return new ReadableStream<ByteChunk>({
      async pull(controller) {
        try {
          // First, consume the held first response
          if (!firstResponseConsumed && self.#firstResponse) {
            firstResponseConsumed = true
            const response = self.#firstResponse
            self.#firstResponse = null

            // Read the response body
            const body = response.body
            if (body) {
              const reader = body.getReader()
              const chunks: Array<Uint8Array> = []

              let result = await reader.read()
              while (!result.done) {
                chunks.push(result.value)
                result = await reader.read()
              }

              // Concatenate chunks
              const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
              const data = new Uint8Array(totalLength)
              let offset = 0
              for (const chunk of chunks) {
                data.set(chunk, offset)
                offset += chunk.length
              }

              controller.enqueue({
                data,
                offset: self.offset,
                cursor: self.cursor,
                upToDate: self.upToDate,
              })
            } else {
              // Empty response
              controller.enqueue({
                data: new Uint8Array(0),
                offset: self.offset,
                cursor: self.cursor,
                upToDate: self.upToDate,
              })
            }

            // If upToDate and not continuing live, we're done
            if (self.upToDate && !self.#shouldContinueLive()) {
              self.#markClosed()
              controller.close()
              return
            }

            // If we should continue, don't close yet
            if (self.#shouldContinueLive()) {
              return // Will be called again for next chunk
            }

            self.#markClosed()
            controller.close()
            return
          }

          // Continue with live updates if needed
          if (self.#shouldContinueLive()) {
            // Check if we should use SSE
            if (self.live === `sse` && self.#startSSE) {
              if (!self.#sseIterator) {
                self.#sseIterator = self.#startSSE(
                  self.offset,
                  self.cursor,
                  self.#abortController.signal
                )
              }

              const result = await self.#sseIterator.next()
              if (result.done) {
                self.#markClosed()
                controller.close()
                return
              }

              const chunk = result.value
              self.offset = chunk.offset
              self.cursor = chunk.cursor
              self.upToDate = chunk.upToDate

              controller.enqueue(chunk)

              if (self.upToDate && !self.#shouldContinueLive()) {
                self.#markClosed()
                controller.close()
              }
              return
            }

            // Use long-poll
            if (self.#abortController.signal.aborted) {
              self.#markClosed()
              controller.close()
              return
            }

            const response = await self.#fetchNext(
              self.offset,
              self.cursor,
              self.#abortController.signal
            )

            self.#updateStateFromResponse(response)

            // Read response body
            const data = new Uint8Array(await response.arrayBuffer())

            controller.enqueue({
              data,
              offset: self.offset,
              cursor: self.cursor,
              upToDate: self.upToDate,
            })

            if (self.upToDate && !self.#shouldContinueLive()) {
              self.#markClosed()
              controller.close()
            }
            return
          }

          // No more data
          self.#markClosed()
          controller.close()
        } catch (err) {
          if (self.#abortController.signal.aborted) {
            self.#markClosed()
            controller.close()
          } else {
            self.#markError(err instanceof Error ? err : new Error(String(err)))
            controller.error(err)
          }
        }
      },

      cancel() {
        self.#abortController.abort()
        self.#markClosed()
      },
    })
  }

  // =================================
  // 1) Accumulating helpers (Promise)
  // =================================

  async body(): Promise<Uint8Array> {
    this.#stopAfterUpToDate = true
    const chunks: Array<Uint8Array> = []

    const reader = this.#createByteStream().getReader()
    let result = await reader.read()
    while (!result.done) {
      if (result.value.data.length > 0) {
        chunks.push(result.value.data)
      }
      if (result.value.upToDate) break
      result = await reader.read()
    }

    // Concatenate all chunks
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
    const data = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      data.set(chunk, offset)
      offset += chunk.length
    }

    this.#markClosed()
    return data
  }

  async json(): Promise<Array<TJson>> {
    this.#ensureJsonMode()
    this.#stopAfterUpToDate = true
    const items: Array<TJson> = []
    const decoder = new TextDecoder()

    const reader = this.#createByteStream().getReader()
    let result = await reader.read()
    while (!result.done) {
      if (result.value.data.length > 0) {
        const text = decoder.decode(result.value.data)
        const parsed = this.#parseJsonChunk<TJson>(text)
        items.push(...parsed)
      }
      if (result.value.upToDate) break
      result = await reader.read()
    }

    this.#markClosed()
    return items
  }

  async text(): Promise<string> {
    this.#stopAfterUpToDate = true
    const decoder = new TextDecoder()
    const parts: Array<string> = []

    const reader = this.#createByteStream().getReader()
    let result = await reader.read()
    while (!result.done) {
      if (result.value.data.length > 0) {
        parts.push(decoder.decode(result.value.data, { stream: true }))
      }
      if (result.value.upToDate) break
      result = await reader.read()
    }

    // Flush any remaining data
    parts.push(decoder.decode())

    this.#markClosed()
    return parts.join(``)
  }

  #parseJsonChunk<T>(text: string): Array<T> {
    try {
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed)) {
        return parsed as Array<T>
      } else {
        return [parsed as T]
      }
    } catch {
      // Try newline-delimited JSON
      const lines = text.split(`\n`).filter((l) => l.trim())
      return lines.map((line) => JSON.parse(line) as T)
    }
  }

  // =====================
  // 2) ReadableStreams
  // =====================

  bodyStream(): ReadableStream<Uint8Array> {
    const byteStream = this.#createByteStream()
    return byteStream.pipeThrough(
      new TransformStream<ByteChunk, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk.data)
        },
      })
    )
  }

  jsonStream(): ReadableStream<TJson> {
    this.#ensureJsonMode()
    const self = this
    const byteStream = this.#createByteStream()
    const decoder = new TextDecoder()

    return byteStream.pipeThrough(
      new TransformStream<ByteChunk, TJson>({
        transform(chunk, controller) {
          if (chunk.data.length > 0) {
            const text = decoder.decode(chunk.data)
            const items = self.#parseJsonChunk<TJson>(text)
            for (const item of items) {
              controller.enqueue(item)
            }
          }
        },
      })
    )
  }

  textStream(): ReadableStream<string> {
    const byteStream = this.#createByteStream()
    const decoder = new TextDecoder()

    return byteStream.pipeThrough(
      new TransformStream<ByteChunk, string>({
        transform(chunk, controller) {
          controller.enqueue(decoder.decode(chunk.data, { stream: true }))
        },
        flush(controller) {
          // Flush any remaining bytes in the decoder
          const remaining = decoder.decode()
          if (remaining) {
            controller.enqueue(remaining)
          }
        },
      })
    )
  }

  // =====================
  // 3) Subscriber APIs
  // =====================

  subscribeJson(
    subscriber: (batch: JsonBatch<TJson>) => Promise<void>
  ): () => void {
    this.#ensureJsonMode()
    const abortController = new AbortController()
    const decoder = new TextDecoder()
    const self = this
    const byteStream = this.#createByteStream()

    // Start consuming in the background
    ;(async () => {
      try {
        const reader = byteStream.getReader()
        let result = await reader.read()
        while (!result.done) {
          if (abortController.signal.aborted) break

          const chunk = result.value
          let items: Array<TJson> = []
          if (chunk.data.length > 0) {
            const text = decoder.decode(chunk.data)
            items = self.#parseJsonChunk<TJson>(text)
          }

          await subscriber({
            items,
            offset: chunk.offset,
            cursor: chunk.cursor,
            upToDate: chunk.upToDate,
          })

          result = await reader.read()
        }
      } catch (e) {
        // Ignore errors after unsubscribe
        if (!abortController.signal.aborted) throw e
      }
    })()

    return () => {
      abortController.abort()
      this.cancel()
    }
  }

  subscribeBytes(subscriber: (chunk: ByteChunk) => Promise<void>): () => void {
    const abortController = new AbortController()
    const byteStream = this.#createByteStream()

    ;(async () => {
      try {
        const reader = byteStream.getReader()
        let result = await reader.read()
        while (!result.done) {
          if (abortController.signal.aborted) break
          await subscriber(result.value)
          result = await reader.read()
        }
      } catch (e) {
        if (!abortController.signal.aborted) throw e
      }
    })()

    return () => {
      abortController.abort()
      this.cancel()
    }
  }

  subscribeText(subscriber: (chunk: TextChunk) => Promise<void>): () => void {
    const abortController = new AbortController()
    const decoder = new TextDecoder()
    const byteStream = this.#createByteStream()

    ;(async () => {
      try {
        const reader = byteStream.getReader()
        let result = await reader.read()
        while (!result.done) {
          if (abortController.signal.aborted) break
          const chunk = result.value
          await subscriber({
            text: decoder.decode(chunk.data, { stream: true }),
            offset: chunk.offset,
            cursor: chunk.cursor,
            upToDate: chunk.upToDate,
          })
          result = await reader.read()
        }
      } catch (e) {
        if (!abortController.signal.aborted) throw e
      }
    })()

    return () => {
      abortController.abort()
      this.cancel()
    }
  }

  // =====================
  // 4) Lifecycle
  // =====================

  cancel(reason?: unknown): void {
    this.#abortController.abort(reason)
    if (this.#sseIterator?.return) {
      this.#sseIterator.return()
    }
    this.#markClosed()
  }

  get closed(): Promise<void> {
    return this.#closed
  }
}
