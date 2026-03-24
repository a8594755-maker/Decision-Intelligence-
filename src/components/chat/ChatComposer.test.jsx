/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('renders a deep verify toggle and handles clicks', async () => {
    const user = userEvent.setup();
    const onToggleDeepVerify = vi.fn();

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
        pendingAttachments={[]}
        onRemoveAttachment={vi.fn()}
        deepVerifyEnabled
        onToggleDeepVerify={onToggleDeepVerify}
      />
    );

    await user.click(screen.getByRole('button', { name: /deep verify/i }));

    expect(onToggleDeepVerify).toHaveBeenCalledTimes(1);
  });

  it('shows auto label when deep verify is not enabled', () => {
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
        pendingAttachments={[]}
        onRemoveAttachment={vi.fn()}
        deepVerifyEnabled={false}
        onToggleDeepVerify={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /^auto$/i })).toBeInTheDocument();
  });
});
