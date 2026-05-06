# Chatbot Comparison

This project was inspired by `mattt-s/Chatbot`, but it intentionally chooses a smaller surface area.

Reference project:

```text
https://github.com/mattt-s/Chatbot
```

## What To Borrow

### Group as a Coordination Surface

Chatbot treats a group conversation as a place where multiple roles can participate. TeamRoom keeps this idea, but maps it to rooms and task events instead of a full chat product.

### Independent Agent Sessions

Each role or agent should keep its own session. This avoids context pollution and makes debugging easier.

### `@role` Routing

Mention-based routing is useful:

```text
@reviewer please check the result
@frontend implement the panel
```

TeamRoom supports the same concept through room member roles and manual assignment.

### Busy State and Queue

Agent state should be visible:

```text
idle, running, failed
```

The MVP keeps stage and task state visible and can later add per-agent queues.

### SSE Event Stream

SSE is a good fit for browser-visible agent progress. It is simpler than WebSocket for one-way updates and works well behind internal proxies.

## What To Remove

### Docker-Centric Deployment

TeamRoom should be runnable with:

```bash
npm start
```

This is easier for companies where Docker is restricted.

### Heavy Web App Stack

No Next.js is required for the MVP. A static page plus a small API server is enough.

### Product Chat Features

TeamRoom does not need full account management, rich chat history, attachment libraries, or product-grade chat navigation for the first version.

### Plugin-to-App Bridge Complexity

If the native plugin can serve routes directly, TeamRoom should avoid a separate WebSocket bridge. Keep the system in one process when possible.

## Difference In One Sentence

Chatbot is closer to a full multi-agent chat application. TeamRoom is a lightweight multi-agent collaboration control plane.

## Useful Framing For Sharing

Do not present TeamRoom as "we copied Chatbot and made it smaller." Present it as:

```text
We borrowed proven interaction mechanisms,
then generalized the core around rooms, policies, task graphs, and event streams.
```

That gives the project a reusable engineering lesson.
