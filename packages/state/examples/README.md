# Durable Streams State Examples

This directory contains single-file HTML examples demonstrating the Durable Streams State Protocol.

## Prerequisites

1. **Build the packages:**

   ```bash
   # From the monorepo root
   pnpm install
   pnpm build
   ```

2. **Start the Durable Streams server:**

   ```bash
   # From the monorepo root
   pnpm --filter @durable-streams/server dev
   ```

   The server should be running on `http://localhost:4437`

## Running Examples

Simply open any HTML file in your browser:

```bash
# From this directory
open progress-bar.html
# or
python3 -m http.server 8080
# then visit http://localhost:8080/progress-bar.html
```

## Examples

### progress-bar.html

**Background Jobs with Progress Tracking**

A demo of the state protocol showing multiple concurrent background jobs with:

- Real-time progress updates (0-100%)
- Status messages and state transitions
- Randomized job behavior (tasks, duration, error rates)
- Live statistics and beautiful UI
- Multiple simultaneous jobs

**Key Concepts Demonstrated:**

- StreamDB collection setup with Standard Schema validation
- Insert events to create new jobs
- Update events for progress tracking
- Real-time subscriptions with `subscribeChanges()`
- State materialization from event log

**Try it:**

1. Click "Start New Job" to create background tasks
2. Watch jobs progress through stages with status updates
3. Some jobs will succeed, others may fail (~20% error rate)
4. Start multiple jobs simultaneously to see concurrent updates

## Architecture

Each example demonstrates:

- **Single-file simplicity**: All HTML, CSS, and JS in one file
- **State Protocol**: Event-driven state synchronization
- **StreamDB**: Reactive collections backed by durable streams
- **Standard Schema**: Type-safe validation
- **Real-time updates**: Live UI updates as events flow through the stream

## Troubleshooting

**"Failed to connect" error:**

- Make sure the Durable Streams server is running on port 4437
- Check that packages are built with `pnpm build`

**Import errors:**

- Verify you're running from the monorepo with built packages
- Check that `../../client/dist/index.js` and `../dist/index.js` exist

**CORS errors:**

- The server should have CORS enabled by default
- If issues persist, try serving the HTML through a local server instead of `file://`
