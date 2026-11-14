import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  useAnswerQuestion, useCreateTask, useDeleteMemory, useGetBranch, useGetDashboard,
  useGetTask, useHealthCheck, useListMemory, useListTaskSources, useListTasks,
  useUpdateHandoff, getGetDashboardQueryKey, getGetTaskQueryKey, getGetBranchQueryKey,
  getListMemoryQueryKey, getListTaskSourcesQueryKey, getListTasksQueryKey,
} from '@workspace/api-client-react';
import type { Branch, MemoryFact, Source, StructuredQuestion, TaskDetail, TaskSummary } from '@workspace/api-client-react';
import {
  ArrowDownRight, ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, CircleHelp,
  Clock3, ExternalLink, FileText, GitBranch, LayoutDashboard, LoaderCircle, Mic, Plus,
  Search, Settings, ShieldCheck, X,
} from 'lucide-react';
import { Link, Route, Switch, useLocation, useParams, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();
const STATUS_COLOR: Record<string, string> = {
  queued: '#9395a1', running: '#5d91ff', waiting: '#e5ad4c',
  blocked: '#e5ad4c', done: '#70bd91', failed: '#e16d76',
};
const consentCopy: Record<string, string> = {
  once: 'Use once', this_task: 'Remember for this task', always: 'Remember always', never: 'Don’t ask again',
};
type SpeechResultEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> };
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};

function Status({ status }: { status: string }) {
  return <span className={`status-pill status-${status}`} data-testid={`status-${status}`}>{status.replace('_', ' ')}</span>;
}

function Shell({ children }: { children: ReactNode }) {
  const { data: tasks, isLoading } = useListTasks();
  const [location] = useLocation();
  const needsAttention = useMemo(() => (tasks ?? []).filter(t => t.status === 'waiting' || t.status === 'blocked'), [tasks]);
  const working = useMemo(() => (tasks ?? []).filter(t => t.status === 'running' || t.status === 'queued'), [tasks]);
  const finished = useMemo(() => (tasks ?? []).filter(t => t.status === 'done' || t.status === 'failed'), [tasks]);
  return <div className="app-shell">
    <header className="topbar">
      <div className="traffic" aria-hidden="true"><i/><i/><i/></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, color: '#7c7e89', fontSize: 10 }}>
        <span style={{ color: '#c7c8d0', fontWeight: 600, letterSpacing: '.02em' }}>LAIZYSINK</span>
        <span style={{ color: '#393a42' }}>/</span><span>Butler</span>
        <span style={{ marginLeft: 8, color: '#555761' }}>●</span>
      </div>
    </header>
    <div className="app-body">
      <aside className="rail" aria-label="Main navigation">
        <div className="rail-main">
          <Link href="/" className="new-task" data-testid="button-new-task"><Plus size={13} style={{ verticalAlign: 'middle', marginRight: 5 }}/>New Task</Link>
          <Link href="/dashboard" className={`rail-link ${location === '/dashboard' ? 'active' : ''}`} data-testid="link-dashboard">
            <LayoutDashboard size={13}/><span>Inbox &amp; Dashboard</span><span className="count">{needsAttention.length}</span>
          </Link>
          {isLoading ? <div className="rail-label">LOADING TASKS</div> : <>
            <div className="rail-label">NEEDS ATTENTION</div>
            {needsAttention.map(task => <TaskRailLink task={task} key={task.id}/>)}
            <div className="rail-label">WORKING</div>
            {working.length ? working.map(task => <TaskRailLink task={task} key={task.id}/>) : <div className="rail-label" style={{ paddingTop: 4 }}>Nothing running</div>}
            <div className="rail-label">FINISHED</div>
            {finished.length ? finished.slice(0, 4).map(task => <TaskRailLink task={task} key={task.id}/>) : <div className="rail-label" style={{ paddingTop: 4 }}>No finished tasks yet</div>}
          </>}
        </div>
        <Link href="/settings" className="settings-link" data-testid="link-settings"><Settings size={13}/><span>Settings</span></Link>
      </aside>
      <main className="main">{children}</main>
    </div>
  </div>;
}

function TaskRailLink({ task }: { task: TaskSummary }) {
  const [location] = useLocation();
  return <Link href={`/tasks/${task.id}`} className={`task-link ${location === `/tasks/${task.id}` ? 'active' : ''}`} data-testid={`link-task-${task.id}`}>
    <span className="dot" style={{ background: STATUS_COLOR[task.status] ?? '#999' }}/>{task.title || task.prompt}
  </Link>;
}

function Home() {
  const [prompt, setPrompt] = useState('');
  const [attachment, setAttachment] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [voiceMessage, setVoiceMessage] = useState('');
  const speechRecognition = useRef<SpeechRecognitionLike | null>(null);
  const create = useCreateTask();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { data: health } = useHealthCheck();
  const startVoiceInput = () => {
    if (isListening) {
      speechRecognition.current?.stop();
      return;
    }
    const speechWindow = window as SpeechWindow;
    const SpeechRecognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setVoiceMessage('Voice input is not supported in this browser.');
      return;
    }
    setVoiceMessage('');
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-GB';
    recognition.interimResults = false;
    recognition.onresult = event => {
      const transcript = event.results[0]?.[0]?.transcript?.trim();
      if (transcript) setPrompt(current => `${current}${current.trim() ? ' ' : ''}${transcript}`);
    };
    recognition.onerror = () => {
      setVoiceMessage('Voice input could not start. Check your microphone permission.');
      setIsListening(false);
      speechRecognition.current = null;
    };
    recognition.onend = () => {
      setIsListening(false);
      speechRecognition.current = null;
    };
    speechRecognition.current = recognition;
    setIsListening(true);
    try {
      recognition.start();
    } catch {
      setIsListening(false);
      speechRecognition.current = null;
      setVoiceMessage('Voice input could not start. Check your microphone permission.');
    }
  };
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || create.isPending) return;
    create.mutate({ data: { prompt: prompt.trim() } }, {
      onSuccess: task => {
        qc.invalidateQueries({ queryKey: getListTasksQueryKey() });
        qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
        navigate(`/tasks/${task.id}`);
      },
    });
  };
  return <section className="home-stage" data-testid="home-screen">
    <div className="home-content">
      <h1 className="home-title">What should we get done in the background?</h1>
      <p className="home-subtitle">Describe a goal and we will research, compare, and prepare the steps for your approval.</p>
      <form className="composer" onSubmit={handleSubmit}>
        <label htmlFor="task-prompt" className="sr-only">Describe a task</label>
        <textarea id="task-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Ask anything or describe a task..." maxLength={2000} data-testid="input-task-prompt" autoFocus/>
        <div className="composer-footer">
          <label className="icon-action" style={{ gap: 6, fontSize: 10, cursor: 'pointer' }} title="Attach a local reference file">
            <input type="file" aria-label="Attach a reference file" data-testid="input-attachment" style={{ display: 'none' }} onChange={e => setAttachment(e.target.files?.[0]?.name ?? '')}/>
            <FileText size={13}/>{attachment || 'Attach file'}
          </label>
          <span className="spacer"/>
          <span title={health?.status || 'Assistant status'} style={{ color: health?.status === 'ok' ? '#70bd91' : '#858792', fontSize: 9 }} data-testid="status-health"><span className="dot" style={{ background: health?.status === 'ok' ? '#70bd91' : '#858792', marginRight: 4 }}/>{health?.status === 'ok' ? 'Ready' : ''}</span>
          <button className="icon-action" type="button" title={isListening ? 'Listening…' : 'Use voice input'} aria-label={isListening ? 'Listening for speech' : 'Use voice input'} onClick={startVoiceInput} data-testid="button-voice-input"><Mic size={13}/></button>
          <button className="primary-btn" type="submit" disabled={!prompt.trim() || create.isPending} data-testid="button-submit-task">
            {create.isPending ? 'Starting…' : 'Start Task'} {create.isPending ? <LoaderCircle size={13}/> : <ArrowRight size={13}/>}
          </button>
        </div>
        {voiceMessage && <div className="source-detail" role="status" style={{ paddingTop: 7 }}>{voiceMessage}</div>}
        {create.isError && <div role="alert" className="error-box" style={{ padding: '10px 4px 0' }}>Couldn’t start this task. Please try again.</div>}
      </form>
    </div>
  </section>;
}

function LoadingRows() { return <div className="panel" style={{ padding: 14, display: 'grid', gap: 9 }} aria-label="Loading"><div className="skeleton"/><div className="skeleton"/><div className="skeleton"/></div>; }
function QueryError({ onRetry }: { onRetry: () => void }) {
  return <div className="panel error-box" role="alert">We couldn’t load this view. <button className="secondary-btn" onClick={onRetry} data-testid="button-retry">Try again</button></div>;
}
function Dashboard() {
  const query = useGetDashboard();
  const summary = query.data;
  return <div className="page" data-testid="dashboard-screen">
    <div className="page-head"><div><div className="eyebrow">Your workspace</div><h1 className="page-title">Task overview</h1><div className="subtle">A clear view of what Butler is researching and what needs you.</div></div>
      <Link href="/" className="primary-btn" data-testid="button-dashboard-new"><Plus size={13}/>New task</Link>
    </div>
    {query.isLoading ? <LoadingRows/> : query.isError ? <QueryError onRetry={() => query.refetch()}/> : summary ? <>
      <div className="stats-grid">
        <Stat label="All tasks" value={summary.taskCount} icon={<BookOpen size={14}/>}/>
        <Stat label="Needs attention" value={summary.needsAttention} icon={<CircleHelp size={14}/>} accent="#e5ad4c"/>
        <Stat label="In progress" value={summary.running} icon={<GitBranch size={14}/>} accent="#5d91ff"/>
        <Stat label="Completed" value={summary.finished} icon={<Check size={14}/>} accent="#70bd91"/>
      </div>
      <div className="section-heading"><h2>Recent tasks</h2><span className="eyebrow">{summary.recentTasks.length} shown</span></div>
      <TaskTable tasks={summary.recentTasks}/>
    </> : <div className="empty panel"><Search size={22}/><p>There’s nothing here yet.</p><Link href="/" className="text-link">Start your first task <ArrowRight size={12}/></Link></div>}
  </div>;
}
function Stat({ label, value, icon, accent }: { label: string; value: number; icon: ReactNode; accent?: string }) {
  return <div className="panel stat-card"><div className="subtle" style={{ display: 'flex', gap: 7, alignItems: 'center' }}>{icon}{label}</div><div className="stat-num" style={{ color: accent }}>{value}</div></div>;
}
function TaskTable({ tasks }: { tasks: TaskSummary[] }) {
  if (!tasks.length) return <div className="panel empty">No tasks yet. Give Butler a goal to work on.</div>;
  return <div className="panel">{tasks.map(task => <Link href={`/tasks/${task.id}`} className="task-row" key={task.id} data-testid={`row-task-${task.id}`}>
    <div><div className="task-row-title">{task.title || task.prompt}</div><div className="task-row-prompt">{task.prompt}</div></div>
    <Status status={task.status}/><span className="subtle task-date" style={{ fontSize: 10 }}>{new Date(task.updatedAt).toLocaleDateString()}</span>
  </Link>)}</div>;
}

function TaskDetailPage() {
  const { taskId = '' } = useParams<{ taskId: string }>();
  const query = useGetTask(taskId, { query: { enabled: !!taskId, queryKey: getGetTaskQueryKey(taskId) } });
  const qc = useQueryClient();
  const [selectedBranchId, setSelectedBranchId] = useState('');
  const [source, setSource] = useState<Source | null>(null);
  const [showLedger, setShowLedger] = useState(false);
  const task = query.data;
  useEffect(() => {
    if (!taskId) return;
    const events = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/events`);
    events.addEventListener('task-update', event => {
      try {
        const updatedTask = JSON.parse((event as MessageEvent<string>).data) as TaskDetail;
        qc.setQueryData(getGetTaskQueryKey(taskId), updatedTask);
        qc.invalidateQueries({ queryKey: getListTasksQueryKey() });
        qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
        qc.invalidateQueries({ queryKey: getListTaskSourcesQueryKey(taskId) });
      } catch {
        qc.invalidateQueries({ queryKey: getGetTaskQueryKey(taskId) });
      }
    });
    return () => events.close();
  }, [taskId, qc]);
  const activeBranchId = task?.branches.some(b => b.id === selectedBranchId) ? selectedBranchId : task?.branches[0]?.id ?? '';
  const branchQuery = useGetBranch(taskId, activeBranchId, { query: { enabled: !!taskId && !!activeBranchId, queryKey: getGetBranchQueryKey(taskId, activeBranchId) } });
  const sourceQuery = useListTaskSources(taskId, { query: { enabled: !!taskId, queryKey: getListTaskSourcesQueryKey(taskId) } });
  if (query.isLoading) return <div className="page"><div className="skeleton"/><div style={{ height: 14 }}/><LoadingRows/></div>;
  if (query.isError) return <div className="page"><QueryError onRetry={() => query.refetch()}/></div>;
  if (!task) return <div className="page"><div className="empty panel">Task not found.</div></div>;
  const sources = sourceQuery.data ?? task.branches.flatMap(b => b.sources);
  return <div className="page" data-testid={`task-detail-${task.id}`}>
    <div className="page-head">
      <div><Link href="/dashboard" className="text-link" data-testid="link-back-dashboard"><ArrowLeft size={12}/> All tasks</Link>
        <div className="eyebrow" style={{ marginTop: 15 }}>Task detail · {task.id}</div><h1 className="page-title">{task.title || task.prompt}</h1>
        <div className="subtle" style={{ maxWidth: 700 }}>{task.prompt}</div>
      </div><Status status={task.status}/>
    </div>
    <div className="detail-layout">
      <div className="detail-main">
        <section className="panel">
          <div className="card-head"><h2>Parallel research</h2><span className="eyebrow">{task.branches.length} branches</span></div>
          <div className="card-body">
            {!task.branches.length ? <div className="empty">Research branches will appear here.</div> :
              <>
                <div className="dag-root" data-testid="node-task-planner">
                  <span className="branch-node"><LayoutDashboard size={15}/></span>
                  <span className="branch-meta"><span className="branch-name">Task planner</span><span className="branch-summary">Independent research branches</span></span>
                  <Status status={task.status}/>
                </div>
                <div className="branch-list" data-testid="branch-dag">{task.branches.map(branch => <button className={`branch-item ${activeBranchId === branch.id ? 'selected' : ''}`} key={branch.id} onClick={() => setSelectedBranchId(branch.id)} data-testid={`button-branch-${branch.id}`}>
                  <span className="branch-node"><GitBranch size={15}/></span><span className="branch-meta"><span className="branch-name">{branch.name}</span><span className="branch-summary">{branch.summary || 'Researching this part of your request'}</span></span>
                  {branch.confidence != null && <span className="confidence">{Math.round(branch.confidence * 100)}%</span>}<Status status={branch.status}/>
                </button>)}</div>
                <div className="dag-merge" data-testid="node-master-merge">
                  <span className="branch-node"><GitBranch size={15}/></span>
                  <span className="branch-meta"><span className="branch-name">Master merge</span><span className="branch-summary">{task.summary || 'Collecting results from completed branches'}</span></span>
                  <Status status={task.status}/>
                </div>
              </>}
            {activeBranchId && <div style={{ borderTop: '1px solid #282930', marginTop: 15, paddingTop: 14 }}>
              <div className="eyebrow" style={{ marginBottom: 8 }}>Selected branch findings</div>
              {branchQuery.isLoading ? <div className="skeleton"/> : branchQuery.isError ? <QueryError onRetry={() => branchQuery.refetch()}/> :
                <BranchFindings branch={branchQuery.data ?? task.branches.find(b => b.id === activeBranchId) ?? null} onSource={setSource}/>}
            </div>}
          </div>
        </section>
        {task.question && <QuestionCard taskId={task.id} question={task.question}/>}
        {task.handoff && task.handoff.status !== 'not_needed' && <HandoffCard taskId={task.id} handoff={task.handoff}/>}
      </div>
      <aside className="detail-side">
        <section className="panel">
          <div className="card-head"><h2>Evidence ledger</h2><button className="text-link" onClick={() => setShowLedger(true)} data-testid="button-open-ledger">View all <ChevronRight size={12}/></button></div>
          <div className="card-body" style={{ paddingTop: 5, paddingBottom: 7 }}>
            {sourceQuery.isLoading ? <div className="skeleton"/> : sourceQuery.isError ? <div className="source-detail">Sources are temporarily unavailable.</div> : sources.length ? sources.slice(0, 4).map(s => <SourceRow source={s} key={s.id} onClick={() => setSource(s)}/>) : <div className="empty" style={{ padding: 20 }}>Evidence appears as research completes.</div>}
          </div>
        </section>
        <section className="panel">
          <div className="card-head"><h2>Progress</h2><Clock3 size={14} color="#888a94"/></div>
          <div className="card-body">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}><span className="subtle">Branches complete</span><span className="confidence">{task.branches.filter(b => b.status === 'done').length} / {task.branches.length}</span></div>
            <div style={{ height: 4, background: '#2a2b32', borderRadius: 5 }}><div style={{ height: '100%', width: `${task.branches.length ? task.branches.filter(b => b.status === 'done').length / task.branches.length * 100 : 0}%`, background: '#716cf5', borderRadius: 5 }}/></div>
            <p className="source-detail" style={{ marginBottom: 0 }}>Updated {new Date(task.updatedAt).toLocaleString()}</p>
          </div>
        </section>
        <section className="panel" style={{ background: '#171922' }}>
          <div className="card-body" style={{ display: 'flex', gap: 10 }}><ShieldCheck size={16} color="#9b96ff"/><div><div style={{ fontWeight: 600, fontSize: 11 }}>You stay in control</div><div className="source-detail">Butler researches and prepares. External actions wait for your approval.</div></div></div>
        </section>
      </aside>
    </div>
    {showLedger && <div className="modal-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) setShowLedger(false); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="ledger-title">
        <div className="card-head"><div><div className="eyebrow">Traceable research</div><h2 id="ledger-title" className="modal-title" style={{ marginTop: 5 }}>Source ledger</h2></div><button className="icon-action" aria-label="Close source ledger" onClick={() => setShowLedger(false)} data-testid="button-close-ledger"><X size={17}/></button></div>
        <div className="card-body">{sourceQuery.isLoading ? <LoadingRows/> : sources.length ? sources.map(s => <SourceRow key={s.id} source={s} onClick={() => setSource(s)}/>) : <div className="empty">No sources have been recorded yet.</div>}</div>
      </section>
    </div>}
    {source && <SourceDialog source={source} onClose={() => setSource(null)}/>}
  </div>;
}

function BranchFindings({ branch, onSource }: { branch: Branch | null; onSource: (source: Source) => void }) {
  if (!branch) return <div className="empty">Select a research branch to inspect its findings.</div>;
  return <>
    <p className="subtle" style={{ margin: '0 0 12px', lineHeight: 1.6 }}>{branch.summary || 'No summary is available yet.'}</p>
    {branch.openQuestions?.length > 0 && <div className="source-detail" style={{ marginBottom: 10 }}><strong style={{ color: '#c5c5cf' }}>Still checking</strong>{branch.openQuestions.map((q, i) => <div key={i} style={{ marginTop: 4 }}>· {q}</div>)}</div>}
    {branch.sources?.length > 0 && <div className="source-detail" style={{ marginBottom: 6 }}>Related evidence</div>}
    {branch.sources?.slice(0, 3).map(s => <SourceRow source={s} key={s.id} onClick={() => onSource(s)}/>)}
  </>;
}

function SourceRow({ source, onClick }: { source: Source; onClick: () => void }) {
  return <div className="source-row">
    <button onClick={onClick} className="source-title" style={{ display: 'block', textAlign: 'left', border: 0, background: 'none', padding: 0, cursor: 'pointer' }} data-testid={`button-source-${source.id}`}>{source.title} <ArrowDownRight size={11} style={{ verticalAlign: 'middle', color: '#858792' }}/></button>
    <div className="source-detail">{source.branchName} · {source.kind} · {source.provider}</div>
    <div className="source-detail">{source.supportsClaim}</div>
    <a href={source.url} target="_blank" rel="noreferrer" className="text-link" data-testid={`link-source-url-${source.id}`}>Open source <ExternalLink size={10}/></a>
  </div>;
}
function SourceDialog({ source, onClose }: { source: Source; onClose: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="source-title">
      <div className="card-head"><div><div className="eyebrow">{source.evidenceLabel} · {source.provider}</div><h2 id="source-title" className="modal-title" style={{ marginTop: 5 }}>{source.title}</h2></div><button className="icon-action" aria-label="Close source details" onClick={onClose} data-testid="button-close-source"><X size={17}/></button></div>
      <div className="card-body"><div className="eyebrow">Supported claim</div><p className="subtle">{source.supportsClaim}</p><div className="eyebrow" style={{ marginTop: 20 }}>Retrieved excerpt</div><p className="source-snippet">{source.snippet}</p><div className="source-detail">Retrieved {new Date(source.retrievedAt).toLocaleString()} · {source.branchName}</div><a href={source.url} target="_blank" rel="noreferrer" className="primary-btn" style={{ marginTop: 16 }} data-testid={`link-open-source-${source.id}`}>Visit original source <ExternalLink size={12}/></a></div>
    </section>
  </div>;
}

function QuestionCard({ taskId, question }: { taskId: string; question: StructuredQuestion | null }) {
  const [answer, setAnswer] = useState(question?.answer ?? '');
  const [consent, setConsent] = useState<'once' | 'this_task' | 'always' | 'never'>('once');
  const [selected, setSelected] = useState('');
  const mutation = useAnswerQuestion();
  const qc = useQueryClient();
  if (!question) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const finalAnswer = selected || answer;
    if (!finalAnswer.trim()) return;
    mutation.mutate({ taskId, questionId: question.id, data: { answer: finalAnswer.trim(), consent } }, {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetTaskQueryKey(taskId) });
        qc.invalidateQueries({ queryKey: getListTasksQueryKey() });
        qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
        qc.invalidateQueries({ queryKey: getListMemoryQueryKey() });
      },
    });
  };
  if (question.status === 'answered') return <section className="panel"><div className="card-head"><h2>Decision captured</h2><Check size={14} color="#70bd91"/></div><div className="card-body"><div className="subtle">{question.prompt}</div><div style={{ marginTop: 10, color: '#dddde5' }}>{question.answer}</div><div className="source-detail" style={{ marginTop: 7 }}>Consent: {consentCopy[question.consent ?? 'once']}</div></div></section>;
  return <section className="question-box">
    <div className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><CircleHelp size={12}/> Butler needs your input</div>
    <div className="question-title">{question.prompt}</div><div className="source-detail">{question.why}</div>
    <form onSubmit={submit}>
      {question.options.length > 0 && <div className="option-list">{question.options.map(option => <button type="button" key={option} onClick={() => { setSelected(option); setAnswer(option); }} className={`option-btn ${selected === option ? 'selected' : ''}`} data-testid={`button-answer-option-${question.id}`}>{option}</button>)}</div>}
      <label className="source-detail" htmlFor={`answer-${question.id}`}>Your answer</label>
      <div className="answer-tools">
        <input className="answer-input" id={`answer-${question.id}`} value={answer} onChange={e => { setAnswer(e.target.value); setSelected(''); }} placeholder="Type a different answer…" maxLength={500} data-testid={`input-answer-${question.id}`}/>
        <VoiceCapture onTranscript={transcript => { setAnswer(current => `${current}${current.trim() ? ' ' : ''}${transcript}`); setSelected(''); }} testId={`button-voice-answer-${question.id}`}/>
      </div>
      <label htmlFor={`consent-${question.id}`} className="source-detail" style={{ display: 'block', marginTop: 12 }}>How should Butler remember this choice?</label>
      <select className="consent-select" id={`consent-${question.id}`} value={consent} onChange={e => setConsent(e.target.value as typeof consent)} data-testid={`select-consent-${question.id}`}>
        <option value="once">Use once</option><option value="this_task">Remember for this task</option><option value="always">Remember always</option><option value="never">Don’t ask again</option>
      </select>
      <button type="submit" className="primary-btn" disabled={mutation.isPending || !(selected || answer).trim()} data-testid={`button-submit-answer-${question.id}`}>{mutation.isPending ? 'Saving…' : 'Answer question'} <ArrowRight size={12}/></button>
      {mutation.isError && <div role="alert" className="source-detail" style={{ color: '#e69b9b', marginTop: 8 }}>Your answer wasn’t saved. Try again.</div>}
    </form>
  </section>;
}

function VoiceCapture({ onTranscript, testId }: { onTranscript: (transcript: string) => void; testId: string }) {
  const [listening, setListening] = useState(false);
  const [message, setMessage] = useState('');
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  useEffect(() => () => recognitionRef.current?.stop(), []);
  const start = () => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const speechWindow = window as SpeechWindow;
    const SpeechRecognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setMessage('Voice input is not supported in this browser.');
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-GB';
    recognition.interimResults = false;
    recognition.onresult = event => {
      const transcript = event.results[0]?.[0]?.transcript?.trim();
      if (transcript) onTranscript(transcript);
    };
    recognition.onerror = () => {
      setMessage('Check microphone permission and try again.');
      setListening(false);
      recognitionRef.current = null;
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = recognition;
    setMessage('');
    setListening(true);
    try {
      recognition.start();
    } catch {
      setMessage('Voice input could not start. Check your microphone permission.');
      setListening(false);
      recognitionRef.current = null;
    }
  };
  return <span className="voice-capture">
    <button type="button" className="icon-action" onClick={start} title={listening ? 'Listening…' : 'Speak your answer'} aria-label={listening ? 'Stop voice input' : 'Speak your answer'} data-testid={testId}><Mic size={13}/></button>
    {message && <span className="source-detail" role="status">{message}</span>}
  </span>;
}

function HandoffCard({ taskId, handoff }: { taskId: string; handoff: { status: string; message: string } }) {
  const mutation = useUpdateHandoff();
  const qc = useQueryClient();
  const decide = (decision: 'hand_to_user' | 'cancel') => mutation.mutate({ taskId, data: { decision } }, {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: getGetTaskQueryKey(taskId) });
      qc.invalidateQueries({ queryKey: getListTasksQueryKey() });
      qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    },
  });
  const isPending = handoff.status === 'pending';
  return <section className="panel handoff">
    <div className="card-head"><h2>Safe handoff</h2><Status status={handoff.status}/></div>
    <div className="card-body"><div className="subtle">{handoff.message}</div>
      {isPending && <><p className="source-detail" style={{ marginTop: 10 }}>Review what Butler prepared, then decide whether to continue. Butler will never enter payment details.</p>
        <div className="handoff-actions"><button className="primary-btn" onClick={() => decide('hand_to_user')} disabled={mutation.isPending} data-testid={`button-approve-handoff-${taskId}`}>Approve handoff <ArrowRight size={12}/></button><button className="danger-btn" onClick={() => decide('cancel')} disabled={mutation.isPending} data-testid={`button-cancel-handoff-${taskId}`}>Cancel</button></div></>}
      {handoff.status === 'handed_to_user' && <div className="source-detail" style={{ marginTop: 9 }}>The next step is yours to complete on the provider’s site.</div>}
      {handoff.status === 'cancelled' && <div className="source-detail" style={{ marginTop: 9 }}>This handoff was cancelled.</div>}
      {mutation.isError && <div className="source-detail" role="alert" style={{ color: '#e69b9b', marginTop: 8 }}>Could not update the handoff. Try again.</div>}
    </div>
  </section>;
}

function SettingsPage() {
  const query = useListMemory();
  const remove = useDeleteMemory();
  const qc = useQueryClient();
  const forget = (fact: MemoryFact) => {
    if (!window.confirm(`Revoke remembered fact “${fact.fact}”?`)) return;
    remove.mutate({ memoryId: fact.id }, { onSuccess: () => qc.invalidateQueries({ queryKey: getListMemoryQueryKey() }) });
  };
  return <div className="page" data-testid="settings-screen">
    <div className="page-head"><div><div className="eyebrow">Your preferences</div><h1 className="page-title">Remembered facts</h1><div className="subtle">Manage what Butler may carry between tasks. Revoke any fact at any time.</div></div></div>
    <section className="panel">
      <div className="card-head"><h2>Consent-based memory</h2><span className="eyebrow">{query.data?.length ?? '—'} saved</span></div>
      {query.isLoading ? <div style={{ padding: 14, display: 'grid', gap: 9 }}><div className="skeleton"/><div className="skeleton"/></div> : query.isError ? <div className="card-body"><QueryError onRetry={() => query.refetch()}/></div> : query.data?.length ? query.data.map(fact => <div className="memory-row" key={fact.id} data-testid={`row-memory-${fact.id}`}>
        <div><div className="eyebrow">{fact.consentMode === 'always' ? 'Remember always' : 'Don’t ask again'}</div><div className="memory-value"><strong>{fact.fact}</strong> — {fact.value}</div><div className="memory-provenance">{fact.provenance} · Added {new Date(fact.createdAt).toLocaleDateString()}</div></div>
        <button className="danger-btn" onClick={() => forget(fact)} disabled={remove.isPending} data-testid={`button-revoke-memory-${fact.id}`}>Revoke</button>
      </div>) : <div className="empty"><ShieldCheck size={22}/><p>No remembered facts yet.</p><div className="source-detail">When you choose “Remember always,” your choices will appear here.</div></div>}
      {remove.isError && <div role="alert" className="source-detail" style={{ padding: 12, color: '#e69b9b' }}>Could not revoke that fact. Please retry.</div>}
    </section>
    <div className="source-detail" style={{ marginTop: 14, display: 'flex', gap: 7 }}><ShieldCheck size={13}/> Butler only remembers details you explicitly allow.</div>
  </div>;
}

function NotFound() {
  return <div className="page"><div className="panel empty"><h1>That page isn’t here.</h1><Link href="/" className="text-link">Return to your inbox <ArrowRight size={12}/></Link></div></div>;
}
function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}
function Router() {
  return <RoutedErrorBoundary><Shell><Switch>
    <Route path="/" component={Home}/>
    <Route path="/dashboard" component={Dashboard}/>
    <Route path="/tasks/:taskId" component={TaskDetailPage}/>
    <Route path="/settings" component={SettingsPage}/>
    <Route component={NotFound}/>
  </Switch></Shell></RoutedErrorBoundary>;
}
function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router/></WouterRouter><Toaster/></TooltipProvider></QueryClientProvider>;
}
export default App;
