# TanStack DB groupBy Issue: Duplicate Insert Errors on Live Updates

## Summary

TanStack DB's `groupBy()` query works correctly when processing batched data during initial load, but fails with "already exists" errors when processing the same data as incremental live updates.

## Environment

- `@tanstack/db`: (check package.json version)
- `@tanstack/solid-db`: (check package.json version)
- Framework: Solid.js
- Context: StreamDB consuming events from a durable stream

## The Issue

When using `groupBy()` in a `useLiveQuery`, the query crashes with:

```
CollectionOperationError: Cannot insert document with key "ru" from sync
because it already exists in the collection "live-query-1"
```

The error occurs in TanStack DB's internal collection created by the groupBy operation, not in our source collection.

## Reproduction

### Data Pattern

We have a stream of Wikipedia events with this structure:

```typescript
{
  id: "en.wikipedia.org-1234567890-123456",
  language: "ru",  // or "en", "fr", etc.
  // ... other fields
}
```

Multiple events can have the same `language` value but different `id` values.

### Query That Fails

```typescript
const topLanguagesQuery = useLiveQuery((q) => {
  const languageCounts = q
    .from({ events: db.collections.events })
    .groupBy(({ events }) => events.language)
    .select(({ events }) => ({
      language: events.language,
      count: count(events.id),
    }))

  return q
    .from({ stats: languageCounts })
    .orderBy(({ stats }) => stats.count, "desc")
    .limit(5)
})
```

### Event Sequence

1. Insert event: `{ id: "event1", language: "ru" }`
2. Insert event: `{ id: "event2", language: "ru" }` ← Error occurs here

### What Works ✅

**Batch Processing (Preload)**

- Write both events to stream
- Create StreamDB and call `db.preload()`
- Run the groupBy query
- **Result**: Works perfectly, shows `{ language: "ru", count: 2 }`

### What Fails ❌

**Live Incremental Updates**

- Create StreamDB and call `db.preload()` (empty or with some data)
- Run the groupBy query
- Write first event with `language: "ru"` to stream
- **Result**: Query processes successfully, shows `{ language: "ru", count: 1 }`
- Write second event with `language: "ru"` to stream
- **Result**: Crashes with "already exists in collection live-query-1"

## Expected Behavior

When the second event with `language: "ru"` arrives:

- The groupBy should recognize "ru" already exists in the aggregation
- It should **update** the existing aggregate: `{ language: "ru", count: 2 }`
- NOT try to **insert** a duplicate "ru" key

## Actual Behavior

The groupBy tries to insert "en" (or other language codes) into its internal collection a second time, causing a duplicate key error.

### Error Details

```
CollectionOperationError: Cannot insert document with key "en" from sync
because it already exists in the collection "live-query-1"
```

**Stack trace location**: The error occurs in `handler.commit()` during the differential dataflow's `applyChanges()` method.

**When it happens**: After processing a batch with `upToDate: true`, when TanStack DB commits the aggregated query results to its internal collection.

## Code Context

### How Events Are Synced to Collection

We use TanStack DB's Collection sync API:

```typescript
const collection = createCollection({
  id: `stream-db:events`,
  schema: eventSchema,
  getKey: (item) => String(item.id),
  sync: createStreamSyncConfig(...),
  startSync: true,
  gcTime: 0,
})
```

Events arrive via:

```typescript
sync: ({ begin, write, commit, markReady }) => {
  // Events processed in batches
  begin()
  write({ value: event, type: "insert" }) // or 'update', 'delete'
  commit() // Commits batch when upToDate signal received
}
```

### Upsert Logic

Our sync layer handles duplicate keys by converting them to updates:

```typescript
// If we see an insert for an existing key, we convert it to update
if (operation === "upsert") {
  const existing = existingKeys.has(eventKey)
  operation = existing ? "update" : "insert"
}
```

So the base collection never sees duplicate inserts - they're converted to updates.

## Hypothesis

The differential dataflow's groupBy operator may not be correctly handling the case where:

1. Multiple `insert` events in the source collection have the same groupBy key
2. Even though they have different primary keys in the source

When processing incrementally:

- Event 1 (id=abc, lang=ru) → groupBy creates aggregate (key=ru, count=1)
- Event 2 (id=xyz, lang=ru) → groupBy should **update** aggregate to (key=ru, count=2)
- But instead it tries to **insert** (key=ru, count=2) again

## Workarounds Attempted

1. Converting all operations to `upsert` in the source - doesn't help, same error
2. Different error handling - doesn't prevent the crash
3. Not using groupBy - works, but defeats the purpose

## Additional Notes

- This works fine when processing the same events in batch (preload)
- Other queries without groupBy work fine with live updates
- The error is in TanStack DB's internal `"live-query-1"` collection, not our source collection
- The source collection's primary key is `id`, groupBy key is `language` (different fields)

## Test Case

See `packages/state/test/stream-db.test.ts` - "Upsert Operations" suite for test attempts (though can't fully reproduce without Solid.js context).

## Questions for Maintainer

1. Is this a known issue with groupBy and incremental updates?
2. Should groupBy automatically detect when an aggregate key already exists and update instead of insert?
3. Is there a different pattern we should use for aggregations over live-updating data?
4. Could this be related to how we batch commits in our sync implementation?
