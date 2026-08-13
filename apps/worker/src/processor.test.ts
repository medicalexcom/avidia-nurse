import { ExtractedSection, MaterialExtension } from '@avidia/domain';
import { buildPdfFixture, buildPptxFixture } from '@avidia/ingestion';

import { GENERIC_FAILURE_MESSAGE } from './messages';
import { drainQueue, processNextDocument, WorkerClient } from './processor';

/**
 * Worker pipeline tests (spec T): queued -> processing -> ready/failed,
 * retry, idempotent section replacement, defensive failures, stale recovery,
 * and the guarantee that students never see internal error detail.
 */

interface FakeDocument {
  id: string;
  storage_key: string | null;
  file_extension: MaterialExtension;
  processing_status: string;
  processing_attempts: number;
  error_message: string | null;
  processing_detail: string | null;
  updated_at: string;
}

class FakeBackend implements WorkerClient {
  documents = new Map<string, FakeDocument>();
  objects = new Map<string, Uint8Array>();
  sections = new Map<string, ExtractedSection[]>();
  replaceCalls = 0;

  addDocument(doc: Partial<FakeDocument> & { id: string }): void {
    this.documents.set(doc.id, {
      storage_key: `user/course/${doc.id}/file`,
      file_extension: 'pdf',
      processing_status: 'queued',
      processing_attempts: 0,
      error_message: null,
      processing_detail: null,
      updated_at: new Date().toISOString(),
      ...doc,
    });
  }

  async claimQueuedDocument() {
    const doc = [...this.documents.values()].find((d) => d.processing_status === 'queued');
    if (!doc) return null;
    doc.processing_status = 'processing';
    doc.processing_attempts += 1;
    return { id: doc.id, storageKey: doc.storage_key, fileExtension: doc.file_extension };
  }

  async downloadObject(storageKey: string): Promise<Uint8Array> {
    const bytes = this.objects.get(storageKey);
    if (!bytes) throw new Error('object not found');
    return bytes;
  }

  async replaceSections(documentId: string, sections: ExtractedSection[]): Promise<number> {
    this.replaceCalls += 1;
    this.sections.set(documentId, sections); // replace, never append
    return sections.length;
  }

  async markReady(documentId: string): Promise<void> {
    const doc = this.documents.get(documentId)!;
    doc.processing_status = 'ready';
    doc.error_message = null;
    doc.processing_detail = null;
  }

  async markFailed(documentId: string, userMessage: string, detail: string): Promise<void> {
    const doc = this.documents.get(documentId)!;
    doc.processing_status = 'failed';
    doc.error_message = userMessage;
    doc.processing_detail = detail;
  }

  async recoverStaleProcessing(staleBeforeIso: string): Promise<number> {
    let recovered = 0;
    for (const doc of this.documents.values()) {
      if (doc.processing_status === 'processing' && doc.updated_at < staleBeforeIso) {
        doc.processing_status = 'failed';
        doc.error_message = GENERIC_FAILURE_MESSAGE;
        recovered += 1;
      }
    }
    return recovered;
  }
}

describe('document processing pipeline', () => {
  it('moves a queued PDF to ready with stored, provenance-bearing sections', async () => {
    const backend = new FakeBackend();
    backend.addDocument({ id: 'doc-1' });
    backend.objects.set(
      'user/course/doc-1/file',
      buildPdfFixture([['Wound care basics.'], ['Assess for infection daily.']])
    );

    const outcome = await processNextDocument(backend);

    expect(outcome).toEqual({ status: 'ready', documentId: 'doc-1', sectionCount: 2 });
    const doc = backend.documents.get('doc-1')!;
    expect(doc.processing_status).toBe('ready');
    expect(doc.processing_attempts).toBe(1);
    expect(doc.error_message).toBeNull();
    const stored = backend.sections.get('doc-1')!;
    expect(stored.map((s) => s.pageNumber)).toEqual([1, 2]);
    expect(stored[0]!.content).toContain('Wound care basics');
  });

  it('is idle when the queue is empty', async () => {
    const outcome = await processNextDocument(new FakeBackend());
    expect(outcome).toEqual({ status: 'idle' });
  });

  it('fails a scanned PDF with the OCR message and no internal detail leak', async () => {
    const backend = new FakeBackend();
    backend.addDocument({ id: 'doc-2' });
    backend.objects.set('user/course/doc-2/file', buildPdfFixture([[], []]));

    const outcome = await processNextDocument(backend);

    expect(outcome.status).toBe('failed');
    const doc = backend.documents.get('doc-2')!;
    expect(doc.processing_status).toBe('failed');
    expect(doc.error_message).toContain('no selectable text');
    // Internal detail is separated from the student-visible message.
    expect(doc.processing_detail).toContain('ocr_required');
    expect(doc.error_message).not.toContain('extraction_failed');
    expect(doc.error_message).not.toMatch(/stack|\.ts|Error:/);
  });

  it('fails corrupt bytes with a student-safe message and supports retry to ready', async () => {
    const backend = new FakeBackend();
    backend.addDocument({ id: 'doc-3', file_extension: 'pptx' });
    backend.objects.set('user/course/doc-3/file', new TextEncoder().encode('not a real pptx'));

    const first = await processNextDocument(backend);
    expect(first.status).toBe('failed');
    const doc = backend.documents.get('doc-3')!;
    expect(doc.processing_status).toBe('failed');
    expect(doc.error_message).toContain('could not be read');

    // Student fixes the file and retries: failed -> queued (legal transition),
    // object replaced with a valid deck.
    doc.processing_status = 'queued';
    backend.objects.set(
      'user/course/doc-3/file',
      await buildPptxFixture([{ title: 'Infection Control', bullets: [['Hand hygiene', 0]] }])
    );

    const second = await processNextDocument(backend);
    expect(second.status).toBe('ready');
    expect(doc.processing_status).toBe('ready');
    expect(doc.processing_attempts).toBe(2);
    expect(doc.error_message).toBeNull();
  });

  it('reprocessing replaces sections instead of duplicating them (idempotency)', async () => {
    const backend = new FakeBackend();
    backend.addDocument({ id: 'doc-4' });
    backend.objects.set(
      'user/course/doc-4/file',
      buildPdfFixture([['Pharmacology review of beta blockers and diuretics.']])
    );

    await processNextDocument(backend);
    backend.documents.get('doc-4')!.processing_status = 'queued'; // re-enqueue
    await processNextDocument(backend);

    expect(backend.replaceCalls).toBe(2);
    // Same document processed twice converges to the same single section set.
    expect(backend.sections.get('doc-4')!).toHaveLength(1);
  });

  it('fails defensively when a claimed document has no storage_key', async () => {
    const backend = new FakeBackend();
    backend.addDocument({ id: 'doc-5', storage_key: null });

    const outcome = await processNextDocument(backend);

    expect(outcome.status).toBe('failed');
    const doc = backend.documents.get('doc-5')!;
    expect(doc.processing_status).toBe('failed');
    expect(doc.error_message).toBe(GENERIC_FAILURE_MESSAGE);
  });

  it('drains the queue in order and reports every outcome', async () => {
    const backend = new FakeBackend();
    backend.addDocument({ id: 'a' });
    backend.objects.set(
      'user/course/a/file',
      buildPdfFixture([['Cardiac output equals stroke volume times heart rate.']])
    );
    backend.addDocument({ id: 'b' });
    backend.objects.set('user/course/b/file', buildPdfFixture([[]])); // scanned -> fails

    const outcomes = await drainQueue(backend);

    expect(outcomes.map((o) => o.status)).toEqual(['ready', 'failed']);
    expect(backend.documents.get('a')!.processing_status).toBe('ready');
    expect(backend.documents.get('b')!.processing_status).toBe('failed');
  });

  it('recovers stale processing documents so students can retry', async () => {
    const backend = new FakeBackend();
    backend.addDocument({
      id: 'stale',
      processing_status: 'processing',
      updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    backend.addDocument({ id: 'fresh', processing_status: 'processing' });

    const recovered = await backend.recoverStaleProcessing(
      new Date(Date.now() - 15 * 60 * 1000).toISOString()
    );

    expect(recovered).toBe(1);
    expect(backend.documents.get('stale')!.processing_status).toBe('failed');
    expect(backend.documents.get('fresh')!.processing_status).toBe('processing');
  });
});
