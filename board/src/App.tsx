import { useEffect } from 'react';
import { initSocket } from './socket/socketClient';
import Header from './components/layout/Header';
import WorkflowBanner from './components/workflow/WorkflowBanner';
import AgentGrid from './components/agents/AgentGrid';
import KanbanBoard from './components/kanban/KanbanBoard';
import EconomicsPanel from './components/economics/EconomicsPanel';
import EventLog from './components/log/EventLog';

export default function App() {
  useEffect(() => {
    initSocket();
  }, []);

  return (
    <div className="min-h-screen bg-[#0f172a] text-slate-100 flex flex-col">
      <Header />

      <main className="flex-1 flex flex-col gap-4 p-4 max-w-[1600px] w-full mx-auto">
        <WorkflowBanner />
        <AgentGrid />
        <KanbanBoard />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pb-4">
          <EconomicsPanel />
          <EventLog />
        </div>
      </main>
    </div>
  );
}
