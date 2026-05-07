# Policy Design

The central design choice is to model multi-agent collaboration as Supervisor-led task routing rather than a free-form group chat. TeamRoom should make the collaboration visible and controllable, while the domain Supervisor keeps ownership of business decomposition.

## Design Summary

```text
Goal
  -> Supervisor Dispatch
  -> Dynamic Task Graph
  -> Agent Assignment
  -> Supervisor Review
  -> Event Stream
```

The UI may feel like a group chat, but the durable abstraction is the task graph and the policy that maps stages to agents.

## Agent Capability Profile

Each room member has a local profile:

```json
{
  "agentId": "frontend-agent",
  "roles": ["implementer"],
  "capabilities": ["frontend", "react", "ui"],
  "maxConcurrentTasks": 1
}
```

Capabilities should be plain tags. Avoid making them too specific. Good examples:

```text
supervisor, dimension, model, form, permission, rule, integration, workflow, review, writing
```

## Task Graph

The default graph is dynamic:

```text
supervisor_dispatch -> specialist_work... -> supervisor_review
```

This matches the implementation-design assistant pattern:

- Supervisor understands the user requirement and decides which specialists need to participate.
- TeamRoom parses the Supervisor's machine-readable dispatch plan.
- Specialist agents execute only the assigned domain work.
- Supervisor performs final consistency review and records human confirmation points.

Each generated specialist stage declares needs:

```json
{
  "type": "specialist_work",
  "needs": ["dimension", "model"],
  "assignedAgentId": "agent_2"
}
```

The policy engine assigns agents by matching needs to capabilities and roles.

## Built-In Policies

### supervisor

This is the default mode.

Use when:

- one agent is the project Supervisor or orchestration center
- business decomposition should stay inside that Supervisor
- TeamRoom should visualize dispatch, execution, return, and review

Mechanism:

```text
1. assign Supervisor Dispatch to the Supervisor agent
2. ask Supervisor to return TEAMROOM_DISPATCH_JSON with subtasks
3. create one specialist_work stage per valid subtask
4. assign each stage to the requested agent_id
5. return all outputs to Supervisor Review
```

If the Supervisor does not return parseable JSON, TeamRoom uses the room policy's `fallbackDispatch` setting:

- `keyword`: ask only specialists whose tags match the task keywords
- `none`: do not create fallback specialist stages
- `all`: ask every non-Supervisor room member for impact checks

The default is `none`, so TeamRoom does not decide on behalf of the Supervisor. Fallbacks are only for demo resilience; the intended path is Supervisor-authored dispatch.

### manual

The user or caller assigns stages explicitly.

Use when:

- the task is sensitive
- agent ownership is known
- demo clarity matters

### round_robin

Stages are assigned in member order.

Use when:

- all agents are similar
- testing the system
- policy complexity would distract from the demo

### capability

Stages are assigned by matching stage needs to member capabilities.

Use when:

- agents have clear specialties
- task types vary
- you want a general-purpose sharing pattern

### leader

A leader agent owns understanding, planning, and summarization. Other agents execute and review.

Use when:

- one agent is stronger at planning
- the team needs a stable coordinator
- the user wants a familiar team structure

### review_gate

Execution stages must pass through a review stage.

Use when:

- output quality matters
- implementation can change shared files
- the task will be shown to others

In the MVP, `review_gate` is represented by `requireReview: true`.

## Scoring In Generic Modes

The scoring model still applies to non-Supervisor generic modes. It is intentionally simple:

```text
+3 for every capability match
+2 for every role match
+1 if the agent is idle
-2 if the agent is already busy
```

When multiple agents receive the same score, TeamRoom breaks the tie by collaboration fairness:

```text
fewer assignments in the current task first
then room member order as a round-robin fallback
```

This matters when OpenClaw agents do not expose rich capability metadata yet. In that case, generic modes still distribute stages across room members instead of repeatedly selecting the first agent.

This is easy to explain in an internal sharing session, and it can later be replaced by model-based planning or historical performance scoring.

## Reusable Lesson

For implementation-design work, the reusable lesson is not:

```text
planner -> coder -> reviewer
```

It is:

```text
Supervisor owns decomposition
TeamRoom owns orchestration visibility
Specialists own bounded domain execution
Human BA owns final business responsibility
```

That is the reusable lesson.

## Example Room Policy

```yaml
room:
  name: implementation-design-room

policy:
  mode: supervisor
  require_review: true
  max_parallel: 2
  fallback_dispatch: none
  room_context_limit: 6
  task_message_limit: 12
  supervisor_extra_prompt: ""
  specialist_extra_prompt: ""
  review_extra_prompt: ""
  prompt_templates:
    supervisorDispatch: "Supervisor 派工 prompt 模板"
    specialistWork: "Specialist 执行 prompt 模板"
    supervisorReview: "Supervisor 复核 prompt 模板"
    previousOutputItem: "前序 agent 输出拼接模板"
    roomContextItem: "历史任务上下文拼接模板"
    taskMessageItem: "人工补充消息拼接模板"

members:
  - agent_id: agent_1
    roles: [supervisor, leader]
    capabilities: [supervisor, analysis, planning, review]

  - agent_id: agent_2
    roles: [specialist]
    capabilities: [dimension, model]

  - agent_id: agent_3
    roles: [specialist]
    capabilities: [form]

  - agent_id: agent_4
    roles: [specialist]
    capabilities: [permission, access]
```

## Future Extensions

- Observe native OpenClaw A2A `session_spawn` and `session_send` events directly instead of TeamRoom-mediated execution.
- Let users edit the graph before execution.
- Track agent success rate per capability.
- Add reviewer voting for high-risk tasks.
- Add policy simulation before dispatching.
