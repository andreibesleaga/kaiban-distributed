import { useBoardStore } from '../../store/boardStore';
import AgentCard from './AgentCard';

export default function AgentGrid() {
  const agents = useBoardStore((s) => s.agents);
  const tasks = useBoardStore((s) => s.tasks);

  if (agents.size === 0) {
    return (
      <div className="rounded-xl border border-slate-800 bg-[#1e293b]/50 px-5 py-8 text-center text-slate-600 text-sm">
        Waiting for agents to connect…
      </div>
    );
  }

  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
        Agents ({agents.size})
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {Array.from(agents.values()).map((agent) => {
          const currentTask = agent.currentTaskId ? tasks.get(agent.currentTaskId) : undefined;
          return <AgentCard key={agent.agentId} agent={agent} currentTask={currentTask} />;
        })}
      </div>
    </section>
  );
}
