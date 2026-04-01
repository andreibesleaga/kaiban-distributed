# Acceptance Criteria (E2E)

## Feature: Distributed Task Execution

**Scenario: A workflow is assigned to a Team running across multiple Node.js workers.**

- **Given** I have a Team configured with an Orchestrator and two Agents (Researcher and Writer).
- **And** the Researcher Agent is hosted on Node A.
- **And** the Writer Agent is hosted on Node B.
- **When** the Orchestrator assigns a task to the Team.
- **Then** Node A should consume the task from the Messaging Layer.
- **And** Node A should transition the state to `DOING` (syncing globally).
- **And** Node A should complete its reasoning and post the result.
- **And** Node B should subsequently receive its dependent task.
- **And** the final workflow result should be identical to a monolithic KaibanJS execution.

## Feature: Fault Tolerance

**Scenario: A worker node crashes mid-execution.**

- **Given** a Worker Node is currently processing a task in the `DOING` state.
- **When** the Node process is forcefully terminated (simulating a crash).
- **Then** the Messaging Layer (BullMQ) should detect the stalled job.
- **And** the task should be re-queued.
- **And** another available Worker Node should pick up the task and resume execution.

## Feature: UI Synchronization

**Scenario: Real-time board updates during distributed execution.**

- **Given** I am viewing the Kaiban Board UI via a browser connected to the Edge Gateway.
- **When** a Worker Node on a disparate server changes a task state to `DONE`.
- **Then** the Edge Gateway should receive the Pub/Sub event immediately.
- **And** the UI should visually reflect the newly completed task without requiring a page refresh.
