/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import AIEmployeeConversationSidebar from './AIEmployeeConversationSidebar';

const formatTime = () => 'now';

describe('AIEmployeeConversationSidebar', () => {
  it('groups conversations by recency buckets', () => {
    const now = new Date();
    const today = now.toISOString();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const older = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();

    render(
      <AIEmployeeConversationSidebar
        conversations={[
          { id: '1', title: 'Today chat', updated_at: today, messages: [{ content: 'Latest' }] },
          { id: '2', title: 'Yesterday chat', updated_at: yesterday, messages: [{ content: 'Earlier' }] },
          { id: '3', title: 'Older chat', updated_at: older, messages: [{ content: 'Oldest' }] },
        ]}
        currentConversationId="1"
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        onNewConversation={vi.fn()}
        formatTime={formatTime}
        searchQuery=""
        onSearchQueryChange={vi.fn()}
        isLoading={false}
      />
    );

    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
    expect(screen.getByText('Older')).toBeInTheDocument();
  });
});
