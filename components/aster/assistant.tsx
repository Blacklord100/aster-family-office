'use client';
import { useState } from 'react';
import {
  Sparkles,
  ArrowUp,
  ArrowUpRight,
  PieChart,
  Wallet,
  Clock3,
  FileText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Field, FieldLabel } from '@/components/ui/field';
import { useWorkspace } from './workspace-context';
import { answerWorkspaceQuestion, type DemoAnswer } from '@/lib/demo-engine';
import { AS_OF_DATE } from '@/data';
import { Status } from './primitives';
const prompts = [
  { text: 'How is our portfolio allocated?', icon: PieChart },
  { text: 'How much cash do we have?', icon: Wallet },
  { text: 'What are our unfunded commitments?', icon: FileText },
  { text: 'What changed recently?', icon: Clock3 },
];
export function AssistantPanel({
  family,
  onSource,
}: {
  family: string;
  onSource: (id: string) => void;
}) {
  const { state, data } = useWorkspace();
  const [input, setInput] = useState(''),
    [messages, setMessages] = useState<
      { question: string; answer: DemoAnswer }[]
    >([]);
  function ask(question: string) {
    const text = question.trim();
    if (!text) return;
    const answer = answerWorkspaceQuestion(
      text,
      {
        asOfDate: AS_OF_DATE,
        holdings: data.holdings,
        timelineEvents: data.events,
      },
      state.engine,
      family === 'all' ? undefined : family,
    );
    setMessages((m) => [...m, { question: text, answer }]);
    setInput('');
  }
  return (
    <div className="assistant-panel">
      <div className="assistant-intro">
        <span className="assistant-orb">
          <Sparkles />
        </span>
        <h2>Your office, in context.</h2>
        <p>
          Ask about the portfolio, commitments or latest developments. Every
          answer stays connected to its evidence.
        </p>
        <Status tone="violet">Grounded demo answers</Status>
      </div>
      {messages.length ? (
        <div className="assistant-messages" aria-live="polite">
          {messages.map((m, i) => (
            <div className="assistant-exchange" key={i}>
              <div className="user-message">{m.question}</div>
              <div className="assistant-answer">
                <Sparkles />
                <div>
                  <p>{m.answer.answer}</p>
                  {m.answer.evidenceCitationIds.length ? (
                    <div className="answer-sources">
                      {m.answer.evidenceCitationIds.slice(0, 5).map((id, j) => (
                        <button key={id} onClick={() => onSource(id)}>
                          <FileText />
                          Source {j + 1}
                          <ArrowUpRight />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="assistant-suggestions">
          {prompts.map((p) => (
            <button key={p.text} onClick={() => ask(p.text)}>
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
          ask(input);
        }}
      >
        <Field>
          <FieldLabel className="sr-only" htmlFor="ask-question">
            Ask about your office
          </FieldLabel>
          <Textarea
            id="ask-question"
            placeholder="Ask about your office…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                ask(input);
              }
            }}
          />
        </Field>
        <Button
          type="submit"
          size="icon"
          disabled={!input.trim()}
          aria-label="Send question"
        >
          <ArrowUp />
        </Button>
      </form>
      <p className="assistant-footnote">
        Synthetic records · Fixed demo query rules · No live AI connection
      </p>
    </div>
  );
}
