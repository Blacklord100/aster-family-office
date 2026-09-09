'use client';
import { useEffect, useEffectEvent, useState } from 'react';
import { FileText, Mail, Paperclip } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { EmailPreviewResponse } from '@/lib/email-preview-contract';
import { PdfPreview } from './pdf-preview';
import styles from './email-preview.module.css';

export function EmailPreview({
  documentId,
  onOpened,
}: {
  documentId: string;
  onOpened: () => void;
}) {
  const [data, setData] = useState<EmailPreviewResponse | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const opened = useEffectEvent(onOpened);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setError(
        'Email preview exceeded 20 seconds. Reopen it or download the original.',
      );
      controller.abort();
    }, 20_000);
    async function load() {
      try {
        const response = await fetch(
          '/api/documents/' + encodeURIComponent(documentId) + '/email',
          {
            cache: 'no-store',
            credentials: 'same-origin',
            redirect: 'error',
            signal: controller.signal,
          },
        );
        const result = await response.json().catch(() => {
          throw new Error('The source preview is temporarily unavailable.');
        });
        if (!response.ok)
          throw new Error(
            result.message ||
              'This email could not be previewed. Download its original.',
          );
        if (!controller.signal.aborted) {
          setData(result);
          setError('');
          if (
            result.attachments.length === 0 &&
            !result.bodyTruncated &&
            result.body.trim()
          )
            opened();
        }
      } catch (issue) {
        if (!controller.signal.aborted)
          setError(
            issue instanceof Error
              ? issue.message
              : 'Could not preview this email.',
          );
      } finally {
        clearTimeout(timer);
      }
    }
    void load();
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [documentId]);
  return (
    <div className={styles.root} aria-label="Decoded email source">
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Email preview unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {!data && !error ? <Skeleton className="h-40" /> : null}
      {data ? (
        <>
          <div className={styles.heading}>
            <Mail aria-hidden="true" />
            <strong>{data.subject}</strong>
          </div>
          <dl className={styles.headers}>
            <dt>From</dt>
            <dd>{data.from || 'Not present in source'}</dd>
            <dt>To</dt>
            <dd>{data.to.join(', ') || 'Not present in source'}</dd>
            <dt>Sent</dt>
            <dd>{data.sentAt || 'Not present in source'}</dd>
          </dl>
          <pre className={styles.body}>
            {data.body || 'No readable text body. Check the attachments below.'}
          </pre>
          {data.warnings.length ? (
            <p className={styles.note}>{data.warnings.join(' ')}</p>
          ) : null}
          <div className={styles.attachmentHeading}>
            <Paperclip aria-hidden="true" />
            <strong>
              {data.attachments.length}{' '}
              {data.attachments.length === 1 ? 'attachment' : 'attachments'}
            </strong>
          </div>
          {data.attachments.map((attachment) => (
            <div className={styles.attachment} key={attachment.index}>
              <FileText aria-hidden="true" />
              <div>
                <strong>{attachment.filename}</strong>
                <span>
                  {new Intl.NumberFormat('en-GB', {
                    maximumFractionDigits: 1,
                  }).format(attachment.byteSize / 1024)}{' '}
                  KB · {attachment.previewable ? 'PDF' : attachment.mimeType}
                </span>
                {attachment.reason ? <p>{attachment.reason}</p> : null}
              </div>
              {attachment.previewable ? (
                <Button
                  variant={
                    selected === attachment.index ? 'secondary' : 'outline'
                  }
                  size="sm"
                  onClick={() =>
                    setSelected((current) =>
                      current === attachment.index ? null : attachment.index,
                    )
                  }
                  aria-label={
                    (selected === attachment.index ? 'Close ' : 'Preview ') +
                    attachment.filename
                  }
                >
                  {selected === attachment.index ? 'Close PDF' : 'Preview PDF'}
                </Button>
              ) : (
                <Badge variant="outline">Original only</Badge>
              )}
            </div>
          ))}
          {selected !== null ? (
            <section aria-label="Email PDF attachment">
              <PdfPreview
                key={documentId + ':' + selected}
                documentId={documentId}
                attachmentIndex={selected}
                onOpened={onOpened}
              />
            </section>
          ) : null}
          <p className={styles.note}>
            Decoded from the retained email. Text is shown without active HTML,
            remote images or tracking. PDF previews disable scripts, forms and
            external assets. Download the original email to inspect other
            attachments. Verify each selected fact against its source body or
            attachment before accepting it.
          </p>
        </>
      ) : null}
    </div>
  );
}
