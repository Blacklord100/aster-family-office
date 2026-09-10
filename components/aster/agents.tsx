'use client';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeading, Panel } from './primitives';

/** Kept for existing imports; the main navigation renders ProcessingView. */
export function AgentsView({
  onTimeline,
}: {
  onSource: (id: string) => void;
  onTimeline: () => void;
}) {
  return (
    <>
      <PageHeading
        title="Document pipeline"
        subtitle="Local document extraction with a reviewable record of each step."
      />
      <Panel title="Review before recording">
        <p className="method-note">
          Import a document in Documents, inspect the extracted candidates, and
          link accepted updates to a holding.
        </p>
        <Button variant="outline" onClick={onTimeline}>
          Open timeline
          <ArrowRight data-icon="inline-end" />
        </Button>
      </Panel>
    </>
  );
}

export { ConnectionsView } from './connections-view';
