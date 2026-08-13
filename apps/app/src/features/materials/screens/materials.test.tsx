import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { MaterialsScreen } from './MaterialsScreen';
import { AddMaterialScreen } from './AddMaterialScreen';
import type { DocumentRow } from '../documentsApi';

/**
 * Materials screen tests (M3, spec S: UI). Router, auth, supabase client and
 * every data-access module are mocked; these tests verify the screen flows —
 * empty state, list metadata, delete confirmation, upload success/failure,
 * duplicate handling, PHI warning, and double-submit prevention.
 */

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual('react');
  return {
    router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
    useFocusEffect: (cb: () => void) => {
      useEffect(() => {
        cb();
      }, [cb]);
    },
  };
});

import { router } from 'expo-router';
const mockRouter = router as unknown as { push: jest.Mock; replace: jest.Mock; back: jest.Mock };

jest.mock('../../auth/AuthProvider', () => {
  // Stable identity: a fresh object each render would retrigger load effects.
  const user = { id: 'user-1', email: 'student@example.com' };
  return { useAuth: () => ({ user }) };
});

jest.mock('../../../lib/supabase', () => ({
  getSupabase: () => ({ mocked: true }),
}));

jest.mock('../../profile/useTimezone', () => ({
  useUserTimezone: () => 'America/Chicago',
  deviceTimeZone: () => 'America/Chicago',
}));

jest.mock('../../courses/coursesApi', () => ({
  fetchOwnCourse: jest.fn(),
}));
jest.mock('../documentsApi', () => ({
  listDocuments: jest.fn(),
}));
jest.mock('../materialStorage', () => ({
  createMaterialSignedUrl: jest.fn(),
}));
jest.mock('../uploadService', () => ({
  uploadMaterial: jest.fn(),
  deleteMaterial: jest.fn(),
  notesToFile: jest.requireActual('../uploadService').notesToFile,
  removeCourseMaterialObjects: jest.fn(),
}));
jest.mock('../filePicker', () => ({
  pickMaterialFile: jest.fn(),
}));

import * as coursesApi from '../../courses/coursesApi';
import * as documentsApi from '../documentsApi';
import * as uploadService from '../uploadService';
import * as filePicker from '../filePicker';

const mocked = <T,>(fn: T) => fn as jest.Mock;

const course = {
  id: 'course-1',
  user_id: 'user-1',
  title: 'Adult Health I',
  term: 'Fall 2026',
  institution_name: null,
  status: 'active',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
};

const uploadedDoc: DocumentRow = {
  id: 'doc-1',
  course_id: 'course-1',
  uploaded_by: 'user-1',
  filename: 'Cardiac Week 3.pdf',
  original_filename: 'Cardiac Week 3.pdf',
  mime_type: 'application/pdf',
  file_extension: 'pdf',
  file_size: 2 * 1024 * 1024,
  storage_key: 'user-1/course-1/doc-1/Cardiac Week 3.pdf',
  document_type: 'lecture',
  processing_status: 'uploaded',
  error_message: null,
  content_hash: 'a'.repeat(64),
  created_at: '2026-08-10T15:00:00.000Z',
  updated_at: '2026-08-10T15:00:00.000Z',
};

const pickedPdf = {
  kind: 'picked' as const,
  file: {
    name: 'Renal.pdf',
    size: 1024,
    mimeType: 'application/pdf',
    bytes: new ArrayBuffer(1024),
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mocked(coursesApi.fetchOwnCourse).mockResolvedValue(course);
});

describe('MaterialsScreen', () => {
  it('shows the empty state and routes to Add Material', async () => {
    mocked(documentsApi.listDocuments).mockResolvedValue([]);
    await render(<MaterialsScreen courseId="course-1" />);
    await screen.findByText('No materials yet');
    await fireEvent.press(screen.getByText('Add your first material'));
    expect(mockRouter.push).toHaveBeenCalledWith('/course/course-1/add-material');
  });

  it('lists a material with type, size, date and status metadata', async () => {
    mocked(documentsApi.listDocuments).mockResolvedValue([uploadedDoc]);
    await render(<MaterialsScreen courseId="course-1" />);
    await screen.findByText('Cardiac Week 3.pdf');
    expect(screen.getByText(/Lecture · 2\.0 MB ·/)).toBeTruthy();
    expect(screen.getByText('Uploaded')).toBeTruthy();
  });

  it('deletes a material after confirmation and reloads', async () => {
    mocked(documentsApi.listDocuments).mockResolvedValueOnce([uploadedDoc]).mockResolvedValue([]);
    mocked(uploadService.deleteMaterial).mockResolvedValue(undefined);
    await render(<MaterialsScreen courseId="course-1" />);
    await fireEvent.press(await screen.findByText('Cardiac Week 3.pdf'));
    await fireEvent.press(screen.getByText('Delete'));
    expect(uploadService.deleteMaterial).not.toHaveBeenCalled();
    expect(screen.getByText(/The stored file will be removed permanently/)).toBeTruthy();
    await fireEvent.press(screen.getByText('Delete material'));
    await waitFor(() => {
      expect(uploadService.deleteMaterial).toHaveBeenCalledWith(
        { mocked: true },
        expect.objectContaining({ id: 'doc-1' })
      );
    });
    await screen.findByText('No materials yet');
  });

  it('does not delete when the confirmation is cancelled', async () => {
    mocked(documentsApi.listDocuments).mockResolvedValue([uploadedDoc]);
    await render(<MaterialsScreen courseId="course-1" />);
    await fireEvent.press(await screen.findByText('Cardiac Week 3.pdf'));
    await fireEvent.press(screen.getByText('Delete'));
    await fireEvent.press(screen.getByText('Cancel'));
    expect(uploadService.deleteMaterial).not.toHaveBeenCalled();
  });

  it('offers Try again for a failed upload and replaces it on success', async () => {
    const failedDoc: DocumentRow = {
      ...uploadedDoc,
      id: 'doc-2',
      storage_key: null,
      processing_status: 'failed',
      error_message: 'The upload did not complete.',
    };
    mocked(documentsApi.listDocuments).mockResolvedValueOnce([failedDoc]).mockResolvedValue([]);
    mocked(filePicker.pickMaterialFile).mockResolvedValue(pickedPdf);
    mocked(uploadService.uploadMaterial).mockResolvedValue({
      kind: 'uploaded',
      document: { ...uploadedDoc, id: 'doc-3' },
    });
    mocked(uploadService.deleteMaterial).mockResolvedValue(undefined);

    await render(<MaterialsScreen courseId="course-1" />);
    await fireEvent.press(await screen.findByText('Cardiac Week 3.pdf'));
    await fireEvent.press(screen.getByText('Try again'));
    await waitFor(() => {
      expect(uploadService.uploadMaterial).toHaveBeenCalledWith(
        { mocked: true },
        expect.objectContaining({ allowDuplicate: true, courseId: 'course-1', userId: 'user-1' })
      );
    });
    expect(uploadService.deleteMaterial).toHaveBeenCalledWith(
      { mocked: true },
      expect.objectContaining({ id: 'doc-2' })
    );
  });
});

describe('AddMaterialScreen', () => {
  it('shows the PHI warning', async () => {
    await render(<AddMaterialScreen courseId="course-1" />);
    expect(
      screen.getByText(/Do not upload patient-identifying information or protected health/)
    ).toBeTruthy();
  });

  it('requires a file before uploading', async () => {
    await render(<AddMaterialScreen courseId="course-1" />);
    await fireEvent.press(screen.getByText('Upload'));
    await screen.findByText('Please choose a file first.');
    expect(uploadService.uploadMaterial).not.toHaveBeenCalled();
  });

  it('keeps state untouched when file selection is cancelled', async () => {
    mocked(filePicker.pickMaterialFile).mockResolvedValue({ kind: 'cancelled' });
    await render(<AddMaterialScreen courseId="course-1" />);
    await fireEvent.press(screen.getByText('Choose file'));
    expect(screen.queryByText(/Renal\.pdf/)).toBeNull();
    expect(screen.getByText('Choose file')).toBeTruthy();
  });

  it('uploads a picked file with the selected type and navigates back', async () => {
    mocked(filePicker.pickMaterialFile).mockResolvedValue(pickedPdf);
    mocked(uploadService.uploadMaterial).mockResolvedValue({
      kind: 'uploaded',
      document: uploadedDoc,
    });
    await render(<AddMaterialScreen courseId="course-1" />);
    await fireEvent.press(screen.getByText('Choose file'));
    await screen.findByText(/Renal\.pdf/);
    await fireEvent.press(screen.getByLabelText('Type Lecture'));
    await fireEvent.press(screen.getByText('Upload'));
    await waitFor(() => {
      expect(uploadService.uploadMaterial).toHaveBeenCalledWith(
        { mocked: true },
        expect.objectContaining({
          userId: 'user-1',
          courseId: 'course-1',
          documentType: 'lecture',
          allowDuplicate: false,
          file: expect.objectContaining({ name: 'Renal.pdf' }),
        })
      );
    });
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('surfaces validation errors without navigating away', async () => {
    mocked(filePicker.pickMaterialFile).mockResolvedValue(pickedPdf);
    mocked(uploadService.uploadMaterial).mockResolvedValue({
      kind: 'invalid',
      error: 'That file is too large (60.0 MB). The limit is 50.0 MB.',
    });
    await render(<AddMaterialScreen courseId="course-1" />);
    await fireEvent.press(screen.getByText('Choose file'));
    await fireEvent.press(screen.getByText('Upload'));
    await screen.findByText(/too large/);
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('asks before uploading a duplicate and honors "Upload anyway"', async () => {
    mocked(filePicker.pickMaterialFile).mockResolvedValue(pickedPdf);
    mocked(uploadService.uploadMaterial)
      .mockResolvedValueOnce({ kind: 'duplicate', existing: uploadedDoc })
      .mockResolvedValueOnce({ kind: 'uploaded', document: uploadedDoc });
    await render(<AddMaterialScreen courseId="course-1" />);
    await fireEvent.press(screen.getByText('Choose file'));
    await fireEvent.press(screen.getByText('Upload'));
    await screen.findByText(/appears to have already been uploaded/);
    await fireEvent.press(screen.getByText('Upload anyway'));
    await waitFor(() => {
      expect(uploadService.uploadMaterial).toHaveBeenLastCalledWith(
        { mocked: true },
        expect.objectContaining({ allowDuplicate: true })
      );
    });
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('shows a friendly message when the upload fails', async () => {
    mocked(filePicker.pickMaterialFile).mockResolvedValue(pickedPdf);
    mocked(uploadService.uploadMaterial).mockResolvedValue({
      kind: 'failed',
      document: uploadedDoc,
      error: 'The upload did not complete. Please check your connection and try again.',
    });
    await render(<AddMaterialScreen courseId="course-1" />);
    await fireEvent.press(screen.getByText('Choose file'));
    await fireEvent.press(screen.getByText('Upload'));
    await screen.findByText(/did not complete/);
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('prevents duplicate submissions while an upload is in flight', async () => {
    mocked(filePicker.pickMaterialFile).mockResolvedValue(pickedPdf);
    let resolveUpload: (value: unknown) => void = () => undefined;
    mocked(uploadService.uploadMaterial).mockImplementation(
      () => new Promise((resolve) => (resolveUpload = resolve))
    );
    await render(<AddMaterialScreen courseId="course-1" />);
    await fireEvent.press(screen.getByText('Choose file'));
    // Two rapid presses while the upload promise is still pending: the second
    // must be swallowed by the disabled/uploading state.
    await fireEvent.press(screen.getByText('Upload'));
    // The upload promise is still pending: the button is now the disabled
    // busy state, and pressing it again must not start a second upload.
    await fireEvent.press(screen.getByText('Uploading…'));
    expect(uploadService.uploadMaterial).toHaveBeenCalledTimes(1);
    resolveUpload({ kind: 'uploaded', document: uploadedDoc });
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
  });

  it('uploads pasted notes as a private text file', async () => {
    mocked(uploadService.uploadMaterial).mockResolvedValue({
      kind: 'uploaded',
      document: uploadedDoc,
    });
    await render(<AddMaterialScreen courseId="course-1" />);
    await fireEvent.press(screen.getByText('Paste notes'));
    await fireEvent.changeText(screen.getByLabelText('Notes title'), 'Renal takeaways');
    await fireEvent.changeText(screen.getByLabelText('Notes text'), 'Watch the potassium.');
    await fireEvent.press(screen.getByText('Upload'));
    await waitFor(() => {
      expect(uploadService.uploadMaterial).toHaveBeenCalledWith(
        { mocked: true },
        expect.objectContaining({
          documentType: 'notes',
          file: expect.objectContaining({
            name: 'Renal takeaways.txt',
            mimeType: 'text/plain',
          }),
        })
      );
    });
    expect(mockRouter.back).toHaveBeenCalled();
  });
});
