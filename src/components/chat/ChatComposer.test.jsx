/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import ChatComposer from './ChatComposer';

describe('ChatComposer', () => {
  it('renders AI employee status without the legacy helper strip', () => {
    render(
      <ChatComposer
        input=""
        onInputChange={vi.fn()}
        onKeyDown={vi.fn()}
        onSubmit={vi.fn((event) => event.preventDefault())}
        textareaRef={{ current: null }}
        fileInputRef={{ current: null }}
        onFileInputChange={vi.fn()}
        onFilePicker={vi.fn()}
        isTyping={false}
        isUploading={false}
        uploadStatusText=""
        isDragOver={false}
        onDragEnter={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
        pendingAttachments={[
          {
            id: 'att_1',
            file_name: 'monthly_report.xlsx',
            kind: 'spreadsheet',
            size_bytes: 4096,
          },
        ]}
        onRemoveAttachment={vi.fn()}
        status={{ text: 'Attached dataset: monthly_report.xlsx', tone: 'neutral' }}
        variant="ai_employee"
      />
    );

    expect(screen.getByText(/attached dataset: monthly_report.xlsx/i)).toBeInTheDocument();
    expect(screen.getAllByText(/monthly_report.xlsx/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/shift\+enter for newline/i)).not.toBeInTheDocument();
  });
});
