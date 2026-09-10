'use client';

import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, X, Maximize2 } from 'lucide-react';
import type { PDFDocumentLoadingTask, RenderTask, PDFWorker } from 'pdfjs-dist';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  PDF_PREVIEW_PAGES,
  PDF_PREVIEW_PIXELS,
  PDF_PREVIEW_TIMEOUT,
  PDF_PREVIEW_WORKER,
  pdfPreviewPath,
  pdfPreviewScale,
  readPdfPreview,
} from '@/lib/pdf-preview';
import styles from './pdf-preview.module.css';
import { emailAttachmentPreviewPath } from '@/lib/email-preview-contract';
import { useWorkspace } from './workspace-context';

type PdfPreviewProps = {
  documentId: string;
  onOpened: () => void;
  expanded?: boolean;
  initialPage?: number;
  attachmentIndex?: number;
};
/** Canvas only: no annotation links, scripting manager, XFA, attachments or external asset URLs. */
export function PdfPreview(props: PdfPreviewProps) {
  const { state } = useWorkspace();
  const organizationId = state.identity?.organizationId;
  if (!organizationId)
    return (
      <output>Choose an authenticated office to preview this original.</output>
    );
  return (
    <ScopedPdfPreview
      key={JSON.stringify([
        organizationId,
        state.identity?.dataScope,
        props.documentId,
        props.attachmentIndex,
        props.initialPage,
      ])}
      {...props}
      organizationId={organizationId}
    />
  );
}
function ScopedPdfPreview({
  documentId,
  onOpened,
  expanded = false,
  initialPage = 1,
  attachmentIndex,
  organizationId,
}: PdfPreviewProps & { organizationId: string }) {
  const [page, setPage] = useState(initialPage),
    [count, setCount] = useState(0);
  const [wide, setWide] = useState(false);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [text, setText] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null),
    cancelRef = useRef<(() => void) | null>(null);
  const opened = useEffectEvent(onOpened);
  useEffect(() => {
    let disposed = false,
      worker: Worker | undefined,
      pdfWorker: PDFWorker | undefined;
    let loading: PDFDocumentLoadingTask | undefined,
      rendering: RenderTask | undefined;
    const controller = new AbortController(),
      canvas = canvasRef.current;
    const stop = () => {
      controller.abort();
      rendering?.cancel();
      worker?.terminate();
      pdfWorker?.destroy();
      void loading?.destroy().catch(() => undefined);
    };
    const fail = (message: string) => {
      if (disposed) return;
      setError(message);
      setBusy(false);
      setText('');
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      stop();
    };
    const timer = setTimeout(
      () =>
        fail(
          'Preview exceeded 20 seconds. Download the original to inspect it.',
        ),
      PDF_PREVIEW_TIMEOUT,
    );
    cancelRef.current = () => {
      clearTimeout(timer);
      fail('Preview cancelled. Reopen the source to try again.');
    };
    async function render() {
      setBusy(true);
      setError('');
      setText('');
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      try {
        const response = await fetch(
          attachmentIndex === undefined
            ? pdfPreviewPath(documentId)
            : emailAttachmentPreviewPath(documentId, attachmentIndex),
          {
            headers: { 'x-aster-organization': organizationId },
            credentials: 'same-origin',
            cache: 'no-store',
            redirect: 'error',
            signal: controller.signal,
          },
        );
        const bytes = await readPdfPreview(response, controller.signal);
        const pdfjs = await import('pdfjs-dist');
        controller.signal.throwIfAborted();
        // The build preparer copies the exact pinned module, without dev eval wrappers or external runtime assets.
        worker = new Worker(PDF_PREVIEW_WORKER, { type: 'module' });
        pdfWorker = pdfjs.PDFWorker.create({ port: worker });
        const parameters = {
          data: bytes,
          worker: pdfWorker,
          isEvalSupported: false,
          enableXfa: false,
          useWasm: false,
          useWorkerFetch: false,
          useSystemFonts: true,
          stopAtErrors: true,
          disableAutoFetch: true,
          disableStream: true,
          disableRange: true,
          maxImageSize: PDF_PREVIEW_PIXELS,
          canvasMaxAreaInBytes: PDF_PREVIEW_PIXELS * 4,
          isOffscreenCanvasSupported: false,
          isImageDecoderSupported: false,
        };
        loading = pdfjs.getDocument(parameters);
        loading.onPassword = () =>
          fail(
            'Password-protected PDFs must be inspected after downloading the original.',
          );
        const document = await loading.promise;
        controller.signal.throwIfAborted();
        setCount(document.numPages);
        if (page > PDF_PREVIEW_PAGES || page > document.numPages)
          throw new Error('This page is outside the preview limit.');
        const sourcePage = await document.getPage(page);
        const original = sourcePage.getViewport({ scale: 1 });
        const viewport = sourcePage.getViewport({
          scale: pdfPreviewScale(original.width, original.height),
        });
        if (!canvas) throw new Error('The preview canvas is unavailable.');
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const context = canvas.getContext('2d', { alpha: false });
        if (!context)
          throw new Error(
            'This browser cannot render the PDF. Download the original.',
          );
        rendering = sourcePage.render({
          canvas,
          canvasContext: context,
          viewport,
          annotationMode: pdfjs.AnnotationMode.DISABLE,
        });
        rendering.onContinue = (resume: () => void) => {
          if (!controller.signal.aborted)
            requestAnimationFrame(() => {
              if (!controller.signal.aborted) resume();
            });
        };
        await rendering.promise;
        const content = await sourcePage.getTextContent();
        controller.signal.throwIfAborted();
        const pageText = content.items
          .filter((item) => 'str' in item)
          .map((item) =>
            'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '',
          )
          .join('');
        setText(pageText.slice(0, 12_000));
        setBusy(false);
        opened();
        clearTimeout(timer);
        stop();
      } catch (reason) {
        if (!disposed && !controller.signal.aborted)
          fail(
            reason instanceof Error && reason.message.startsWith('This ')
              ? reason.message
              : 'This PDF could not be rendered within the preview limits. Download the original to inspect it.',
          );
      } finally {
        clearTimeout(timer);
      }
    }
    void render();
    return () => {
      disposed = true;
      clearTimeout(timer);
      cancelRef.current = null;
      stop();
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, [documentId, attachmentIndex, page, organizationId]);
  return (
    <div className={styles.preview} aria-label="PDF source preview">
      <div className={styles.toolbar}>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Previous PDF page"
          disabled={busy || page <= 1}
          onClick={() => setPage(page - 1)}
        >
          <ChevronLeft />
        </Button>
        <output>
          Page {page}
          {count ? ' of ' + count : ''}
        </output>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Next PDF page"
          disabled={
            busy || !count || page >= Math.min(count, PDF_PREVIEW_PAGES)
          }
          onClick={() => setPage(page + 1)}
        >
          <ChevronRight />
        </Button>
        {busy ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel PDF preview"
            onClick={() => cancelRef.current?.()}
          >
            <X />
          </Button>
        ) : null}
        {!expanded ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !!error}
            onClick={() => setWide(true)}
          >
            <Maximize2 data-icon="inline-start" /> Enlarge
          </Button>
        ) : null}
      </div>
      {busy ? (
        <p className={styles.loading}>
          <Loader2 className="animate-spin" /> Rendering original page…
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Preview unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        aria-label={'Original PDF, page ' + page}
        hidden={busy || !!error}
      />
      {count > PDF_PREVIEW_PAGES ? (
        <p className={styles.note}>
          Preview covers the first {PDF_PREVIEW_PAGES} of {count} pages.
          Download the original for the remaining pages.
        </p>
      ) : null}
      {!busy && !error ? (
        <p className={styles.note}>
          Visual preview only. Forms, annotations and embedded scripts are
          disabled; images above 4 million pixels are omitted. Compare important
          values with the downloaded original.
        </p>
      ) : null}
      {text ? (
        <details className={styles.text}>
          <summary>Selectable page text</summary>
          <pre>{text}</pre>
          <p>Text is limited to 12,000 characters per page.</p>
        </details>
      ) : null}
      {!expanded ? (
        <Dialog open={wide} onOpenChange={setWide}>
          <DialogContent className={styles.dialog}>
            <DialogHeader>
              <DialogTitle>Original PDF source</DialogTitle>
              <DialogDescription>
                Read the authenticated source at a larger size. Embedded
                scripts, forms and links remain disabled.
              </DialogDescription>
            </DialogHeader>
            <PdfPreview
              documentId={documentId}
              attachmentIndex={attachmentIndex}
              onOpened={onOpened}
              expanded
              initialPage={page}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
