'use client';
import { useEffect, useRef, useState } from 'react';
import {
  Sparkles,
  ArrowUp,
  ArrowUpRight,
  PieChart,
  Wallet,
  FileText,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Field, FieldLabel } from '@/components/ui/field';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import type { KnowledgeAnswer } from '@/lib/intelligence-contract';
import type { EnginesResponse } from '@/lib/engine-contract';
import { useWorkspace } from './workspace-context';
import { Status, Picker, money } from './primitives';
import styles from './intelligence.module.css';
const prompts = [
  { text: 'What is our recorded portfolio value?', icon: PieChart },
  { text: 'How much cash is recorded?', icon: Wallet },
  { text: 'What are our unfunded commitments?', icon: FileText },
];
export function AssistantPanel({
  family,
  onSource,
}: {
  family: string;
  onSource: (id: string) => void;
}) {
  const { state } = useWorkspace();
  return (
    <AssistantConversation
      key={(state.identity?.organizationId ?? '') + ':' + family}
      family={family}
      onSource={onSource}
    />
  );
}
function AssistantConversation({
  family,
  onSource,
}: {
  family: string;
  onSource: (id: string) => void;
}) {
  const { state, data } = useWorkspace();
  const [input, setInput] = useState(''),
    [messages, setMessages] = useState<
      { question: string; answer: KnowledgeAnswer }[]
    >([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [mode, setMode] = useState<'workflow' | 'agentic'>('workflow'),
    [engine, setEngine] = useState<EnginesResponse['active'] | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/engines', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (r) => {
        if (r.ok) setEngine(((await r.json()) as EnginesResponse).active);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [state.identity?.organizationId]);
  useEffect(() => {
    return () => pending.current?.abort();
  }, []);
  async function ask(question: string) {
    const text = question.trim();
    if (text.length < 2 || busy) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/intelligence/ask', {
        method: 'POST',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text, familyId: family, mode }),
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(
          payload.message ?? 'The question could not be completed.',
        );
      if (!controller.signal.aborted) {
        setMessages((current) => [
          ...current.slice(-9),
          { question: text, answer: payload as KnowledgeAnswer },
        ]);
        setEngine(payload.engine);
        setInput('');
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : 'The question could not be completed.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <div className="assistant-panel">
      <div className="assistant-intro">
        <span className="assistant-orb">
          <Sparkles />
        </span>
        <h2>Your office, in context.</h2>
        <p>
          Retrieve sourced passages and calculate from recorded holdings.
          Answers remain read-only and connected to their evidence.
        </p>
        <Status tone="violet">
          {engine
            ? `${engine.name} · ${engine.execution}`
            : 'Selected workspace engine'}
        </Status>
      </div>
      <div className={styles.mode}>
        <Picker
          label="Question processing mode"
          value={mode}
          options={[
            { value: 'workflow', label: 'Workflow · one source pass' },
            { value: 'agentic', label: 'Agentic · bounded source tools' },
          ]}
          onChange={(value) => setMode(value as 'workflow' | 'agentic')}
        />
        <span className={styles.answerMeta}>
          {engine?.model ?? 'Engine resolved when you ask'}
        </span>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Question unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {messages.length ? (
        <div className="assistant-messages" aria-live="polite">
          {messages.map((m, i) => (
            <div className="assistant-exchange" key={i}>
              <div className="user-message">{m.question}</div>
              <div className="assistant-answer">
                <Sparkles />
                <div className={styles.answer}>
                  <p>
                    {m.answer.status === 'model_unavailable'
                      ? 'The selected model could not provide a validated answer. No fallback engine was used.'
                      : m.answer.status === 'insufficient_evidence'
                        ? 'The accessible indexed sources did not provide a supported answer. Try indexing the relevant original or asking a narrower question.'
                        : 'These source passages and recorded calculations support your question.'}
                  </p>
                  {m.answer.calculations.map((c) => (
                    <section className={styles.calculation} key={c.id}>
                      <span>{c.label}</span>
                      <strong>{money(c.valueEUR, 2)}</strong>
                      <p className={styles.answerMeta}>
                        {c.holdingIds.length} accessible holding records ·{' '}
                        {c.basis}
                      </p>
                      {c.holdingIds.slice(0, 8).map((id) => {
                        const h = data.holdings.find((h) => h.id === id);
                        const source = data.evidence.find(
                          (e) => e.id === h?.sourceId,
                        );
                        return h ? (
                          <p key={id} className={styles.answerMeta}>
                            {h.name} · mark {h.valuationDate}
                            {source ? (
                              <Button
                                size="sm"
                                variant="link"
                                onClick={() => onSource(source.id)}
                              >
                                Recorded source
                              </Button>
                            ) : null}
                          </p>
                        ) : null;
                      })}
                      {c.holdingIds.length > 8 ? (
                        <p className={styles.answerMeta}>
                          And {c.holdingIds.length - 8} more holdings in this
                          calculation; inspect Investments for the complete
                          records.
                        </p>
                      ) : null}
                    </section>
                  ))}
                  {m.answer.citations.map((c, j) => (
                    <section key={c.id + ':' + j}>
                      <blockquote>{c.quote}</blockquote>
                      <a
                        href={'/api/documents/' + c.documentId}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {c.filename} · {c.source} · page {c.page}
                      </a>
                    </section>
                  ))}
                  <p className={styles.answerMeta}>
                    {m.answer.engine.model} · {m.answer.engine.execution} ·{' '}
                    {m.answer.mode} · {m.answer.modelCalls} model calls.
                    Searched {m.answer.coverage.searchedDocuments} indexed
                    documents / {m.answer.coverage.searchedPages} decoded pages.
                    {m.answer.coverage.truncated ? ' Coverage capped.' : ''}
                  </p>
                  {[...m.answer.warnings, ...m.answer.coverage.warnings].map(
                    (w, j) => (
                      <p className={styles.answerMeta} key={j}>
                        {w}
                      </p>
                    ),
                  )}
                  <details>
                    <summary>Read-only processing steps</summary>
                    {m.answer.trace.map((t, j) => (
                      <p key={j}>
                        {t.stage}: {t.detail}
                      </p>
                    ))}
                  </details>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="assistant-suggestions">
          {prompts.map((p) => (
            <button key={p.text} disabled={busy} onClick={() => ask(p.text)}>
              <p.icon />
              <span>{p.text}</span>
              <ArrowUpRight />
            </button>
          ))}
        </div>
      )}
      <form
        className="assistant-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
      >
        <Field>
          <FieldLabel className="sr-only" htmlFor="ask-question">
            Ask about your office
          </FieldLabel>
          <Textarea
            id="ask-question"
            placeholder="Ask about your office…"
            maxLength={600}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask(input);
              }
            }}
          />
        </Field>
        <Button
          type="submit"
          size="icon"
          disabled={input.trim().length < 2 || busy}
          aria-label="Ask question"
        >
          {busy ? <Loader2 /> : <ArrowUp />}
        </Button>
      </form>
      {busy ? (
        <output className={styles.answerMeta}>
          Reading accessible evidence with the selected engine. Local inference
          may take several minutes.
        </output>
      ) : null}
      <p className="assistant-footnote">
        {state.sampleData ? 'Includes sample holding records · ' : ''}Family
        selection limits recorded calculations; document retrieval uses your
        source-access permissions. Only indexed originals are searched. No
        messages, trades or record changes.
      </p>
    </div>
  );
}
