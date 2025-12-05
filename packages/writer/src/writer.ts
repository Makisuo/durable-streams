/**
 * Writer operations for Durable Streams.
 *
 * This package includes all read operations from @durable-streams/client
 * plus write operations (create, append, delete) for server-side use.
 */

import { DurableStream as BaseStream } from "@durable-streams/client"

/**
 * DurableStream - Full read/write client for Durable Streams.
 *
 * Includes all read operations plus write operations:
 * - create() - Create a new stream
 * - append() - Append data to a stream
 * - delete() - Delete a stream
 *
 * Use this package server-side. For read-only client applications,
 * use @durable-streams/client instead for a smaller bundle size.
 *
 * @example
 * ```typescript
 * import { DurableStream } from "@durable-streams/writer"
 *
 * // Create and write to a stream
 * const stream = await DurableStream.create({
 *   url: "https://streams.example.com/my-stream",
 *   contentType: "application/json",
 * })
 *
 * await stream.append(JSON.stringify({ event: "user.created" }))
 * ```
 */
export class DurableStream extends BaseStream {}

// Re-export types for write operations
export type { CreateOptions, AppendOptions } from "@durable-streams/client"
