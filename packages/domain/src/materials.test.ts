import {
  buildStorageKey,
  canTransitionStatus,
  DEFAULT_MAX_MATERIAL_BYTES,
  fileExtensionOf,
  formatBytes,
  sanitizeMaterialFilename,
  validateMaterialFile,
} from './materials';

describe('validateMaterialFile', () => {
  it('accepts the four supported formats with matching MIME types', () => {
    expect(
      validateMaterialFile({ filename: 'Cardiac.pdf', mimeType: 'application/pdf', size: 1000 })
    ).toEqual({ ok: true, extension: 'pdf', mimeType: 'application/pdf' });
    expect(
      validateMaterialFile({
        filename: 'Week 3.PPTX',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        size: 1000,
      })
    ).toMatchObject({ ok: true, extension: 'pptx' });
    expect(
      validateMaterialFile({
        filename: 'Guide.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 1000,
      })
    ).toMatchObject({ ok: true, extension: 'docx' });
    expect(
      validateMaterialFile({ filename: 'notes.txt', mimeType: 'text/plain', size: 10 })
    ).toMatchObject({ ok: true, extension: 'txt' });
  });

  it('rejects unsupported and legacy formats', () => {
    for (const filename of ['lecture.ppt', 'paper.doc', 'video.mp4', 'archive.zip', 'noext']) {
      const result = validateMaterialFile({ filename, mimeType: null, size: 100 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('not supported');
    }
  });

  it('rejects a MIME type that contradicts the extension', () => {
    const result = validateMaterialFile({
      filename: 'fake.pdf',
      mimeType: 'application/x-msdownload',
      size: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('.pdf');
  });

  it('tolerates missing or generic MIME types (extension + server enforce)', () => {
    expect(validateMaterialFile({ filename: 'a.pdf', mimeType: null, size: 1 }).ok).toBe(true);
    expect(
      validateMaterialFile({ filename: 'a.pdf', mimeType: 'application/octet-stream', size: 1 }).ok
    ).toBe(true);
  });

  it('enforces the size limit and rejects empty files', () => {
    const tooBig = validateMaterialFile({
      filename: 'deck.pptx',
      mimeType: null,
      size: DEFAULT_MAX_MATERIAL_BYTES + 1,
    });
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error).toContain('too large');

    expect(validateMaterialFile({ filename: 'x.pdf', mimeType: null, size: 0 }).ok).toBe(false);
    // Custom limit is honored.
    expect(validateMaterialFile({ filename: 'x.pdf', mimeType: null, size: 200 }, 100).ok).toBe(
      false
    );
    // Unknown size defers to the storage layer.
    expect(validateMaterialFile({ filename: 'x.pdf', mimeType: null, size: null }).ok).toBe(true);
  });
});

describe('processing-status state machine', () => {
  it('allows the M3 client transitions', () => {
    expect(canTransitionStatus('uploading', 'uploaded')).toBe(true);
    expect(canTransitionStatus('uploading', 'failed')).toBe(true);
    expect(canTransitionStatus('failed', 'uploading')).toBe(true);
  });

  it('reserves M4 transitions without allowing shortcuts', () => {
    expect(canTransitionStatus('uploaded', 'queued')).toBe(true);
    expect(canTransitionStatus('queued', 'processing')).toBe(true);
    expect(canTransitionStatus('processing', 'ready')).toBe(true);
    // No pretending extraction happened:
    expect(canTransitionStatus('uploading', 'ready')).toBe(false);
    expect(canTransitionStatus('uploaded', 'ready')).toBe(false);
    expect(canTransitionStatus('ready', 'uploading')).toBe(false);
  });
});

describe('storage keys and filenames', () => {
  it('builds the {user}/{course}/{document}/{filename} convention', () => {
    expect(buildStorageKey('u1', 'c1', 'd1', 'Cardiac Week 3.pdf')).toBe(
      'u1/c1/d1/Cardiac Week 3.pdf'
    );
  });

  it('sanitizes hostile or messy filenames while keeping the extension', () => {
    expect(sanitizeMaterialFilename('../../etc/passwd.pdf')).toBe('....etcpasswd.pdf');
    expect(sanitizeMaterialFilename('a/b\\c?.pptx')).toBe('abc.pptx');
    expect(sanitizeMaterialFilename('  lots   of    spaces .docx')).toBe('lots of spaces.docx');
    expect(sanitizeMaterialFilename('???.pdf')).toBe('file.pdf');
    const long = `${'x'.repeat(300)}.pdf`;
    const sanitized = sanitizeMaterialFilename(long);
    expect(sanitized.endsWith('.pdf')).toBe(true);
    expect(sanitized.length).toBeLessThanOrEqual(104);
  });

  it('extracts extensions case-insensitively', () => {
    expect(fileExtensionOf('A.PDF')).toBe('pdf');
    expect(fileExtensionOf('noext')).toBeNull();
  });
});

describe('formatBytes', () => {
  it('formats sizes for humans', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(DEFAULT_MAX_MATERIAL_BYTES)).toBe('50.0 MB');
  });
});
