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
import { Status, money, percent } from './primitives';
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
      {
        question: string;
        answer: { answer: string; evidenceCitationIds: string[] };
      }[]
    >([]);
  function ask(question: string) {
    const text = question.trim();
    if (!text) return;
    const query = text.toLocaleLowerCase();
    const named = data.families.filter((f) =>
      query.includes(f.name.toLocaleLowerCase()),
    );
    const selected = named.length === 1 ? named[0].id : family;
    const holdings = data.holdings.filter(
      (h) => selected === 'all' || h.familyId === selected,
    );
    const events = data.events.filter(
      (e) => selected === 'all' || e.familyId === selected,
    );
    const scope =
      selected === 'all'
        ? 'All families'
        : (data.families.find((f) => f.id === selected)?.name ??
          'Selected family');
    let response = '',
      citations: string[] = [];
    if (!holdings.length)
      response =
        'No holdings are recorded in this scope. Add an opening holding in Investments, then import and review its source documents in Processing.';
    else if (/return|performance|volatility|benchmark/.test(query))
      response =
        'This assistant does not calculate investment returns or risk measures. Complete dated valuations and external cash flows are needed; recorded marks alone are insufficient.';
    else if (/cash|liquidity/.test(query)) {
      const cash = holdings.filter((h) => h.assetClass === 'Cash');
      response =
        scope +
        ' · Recorded cash positions total ' +
        money(
          cash.reduce((sum, h) => sum + h.valueEUR, 0),
          2,
        ) +
        '. This reflects recorded accounts only; source coverage and availability require review.';
      citations = cash.map((h) => h.sourceId);
    } else if (/commitment|unfunded/.test(query)) {
      const committed = holdings.filter((h) => h.unfundedCommitmentEUR > 0);
      response =
        scope +
        ' · Recorded unfunded commitments total ' +
        money(
          committed.reduce((sum, h) => sum + h.unfundedCommitmentEUR, 0),
          2,
        ) +
        ' across ' +
        committed.length +
        ' holdings. Notices do not establish payment or settlement.';
      citations = committed.map((h) => h.sourceId);
    } else if (/change|recent|update|latest/.test(query)) {
      const recent = [...events]
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
        .slice(0, 3);
      response = recent.length
        ? scope +
          ' · ' +
          recent
            .map((e) => e.title + ' (' + e.date + '): ' + e.summary)
            .join(' ')
        : 'No source-linked developments are recorded in this scope yet.';
      citations = recent.map((e) => e.sourceId);
    } else if (/allocat|portfolio|holding|value/.test(query)) {
      const total = holdings.reduce((sum, h) => sum + h.valueEUR, 0);
      const groups = new Map<string, number>();
      for (const h of holdings)
        groups.set(h.assetClass, (groups.get(h.assetClass) ?? 0) + h.valueEUR);
      response =
        scope +
        ' · ' +
        holdings.length +
        ' recorded holdings total ' +
        money(total, 2) +
        '. ' +
        [...groups]
          .map(
            ([name, value]) =>
              name +
              ': ' +
              money(value, 2) +
              (total ? ' (' + percent(value / total) + ')' : ''),
          )
          .join('; ') +
        '. Values use each position’s latest recorded mark.';
      citations = holdings.map((h) => h.sourceId);
    } else
      response =
        'This assistant supports recorded allocation, cash, commitments and recent updates using fixed workspace queries. Open Processing for local AI document extraction.';
    const answer = {
      answer: response,
      evidenceCitationIds: [...new Set(citations)].filter((id) =>
        data.evidence.some((s) => s.id === id),
      ),
    };
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
        <Status tone="violet">Workspace record queries</Status>
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
        {state.sampleData ? 'Includes sample records · ' : ''}Fixed queries over
        recorded data · AI document extraction is in Processing
      </p>
    </div>
  );
}
