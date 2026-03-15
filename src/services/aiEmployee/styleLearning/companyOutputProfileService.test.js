import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../supabaseClient', () => ({
  supabase: {
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
    from: () => {
      throw new Error('Unexpected default supabase usage in companyOutputProfileService test');
    },
  },
}));

import {
  approveOutputProfileProposal,
  createOutputProfileProposal,
  rollbackOutputProfile,
} from './companyOutputProfileService.js';

class MockQueryBuilder {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.action = 'select';
    this.filters = [];
    this.orders = [];
    this.limitCount = null;
    this.payload = null;
    this.returning = false;
  }

  select() {
    this.returning = true;
    return this;
  }

  insert(payload) {
    this.action = 'insert';
    this.payload = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  update(payload) {
    this.action = 'update';
    this.payload = payload;
    return this;
  }

  eq(column, value) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  is(column, value) {
    this.filters.push((row) => (value === null ? row[column] == null : row[column] === value));
    return this;
  }

  order(column, { ascending = true } = {}) {
    this.orders.push({ column, ascending });
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  async maybeSingle() {
    return this.execute({ maybeSingle: true });
  }

  async single() {
    return this.execute({ single: true });
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  async execute({ single = false, maybeSingle = false } = {}) {
    const tableRows = this.db.tables[this.table] || [];
    let rows = [];

    if (this.action === 'insert') {
      rows = this.payload.map((row) => {
        const id = row.id || `${this.table}-${++this.db.counters[this.table]}`;
        const inserted = { ...row, id };
        tableRows.push(inserted);
        return { ...inserted };
      });
    } else if (this.action === 'update') {
      const matched = tableRows.filter((row) => this.filters.every((filter) => filter(row)));
      matched.forEach((row) => Object.assign(row, this.payload));
      rows = matched.map((row) => ({ ...row }));
    } else {
      rows = tableRows
        .filter((row) => this.filters.every((filter) => filter(row)))
        .map((row) => ({ ...row }));
    }

    if (this.action === 'select') {
      for (const order of [...this.orders].reverse()) {
        rows.sort((left, right) => {
          const a = left[order.column];
          const b = right[order.column];
          if (a === b) return 0;
          if (a == null) return order.ascending ? 1 : -1;
          if (b == null) return order.ascending ? -1 : 1;
          return order.ascending ? (a > b ? 1 : -1) : (a > b ? -1 : 1);
        });
      }
      if (this.limitCount != null) {
        rows = rows.slice(0, this.limitCount);
      }
    }

    if (single) {
      return { data: rows[0] || null, error: null };
    }
    if (maybeSingle) {
      return { data: rows[0] || null, error: null };
    }

    return { data: rows, error: null };
  }
}

function createMockDb(seed = {}) {
  const tables = {
    company_output_profiles: seed.company_output_profiles ? [...seed.company_output_profiles] : [],
    company_output_profile_proposals: seed.company_output_profile_proposals ? [...seed.company_output_profile_proposals] : [],
    style_profiles: seed.style_profiles ? [...seed.style_profiles] : [],
  };

  return {
    tables,
    counters: {
      company_output_profiles: tables.company_output_profiles.length,
      company_output_profile_proposals: tables.company_output_profile_proposals.length,
      style_profiles: tables.style_profiles.length,
    },
    auth: {
      getUser: async () => ({ data: { user: { id: 'manager-1' } }, error: null }),
    },
    from(table) {
      if (!this.tables[table]) {
        this.tables[table] = [];
        this.counters[table] = 0;
      }
      return new MockQueryBuilder(this, table);
    },
  };
}

describe('companyOutputProfileService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a pending proposal with the next version number', async () => {
    const db = createMockDb({
      company_output_profiles: [
        {
          id: 'profile-1',
          employee_id: 'emp-1',
          team_id: 'sales_ops',
          doc_type: 'monthly_business_review',
          profile_name: 'apple_mbr_v1',
          version: 1,
          status: 'active',
          confidence: 0.81,
          sample_count: 6,
          canonical_structure: { sheets: ['Raw_Data', 'Dashboard'] },
        },
      ],
    });

    const proposal = await createOutputProfileProposal({
      employeeId: 'emp-1',
      teamId: 'sales_ops',
      docType: 'monthly_business_review',
      profileName: 'apple_mbr_v2',
      rationale: 'Tighten issue log and highlight three executive observations.',
      candidateProfile: {
        canonical: {
          textStyle: { tone: 'executive_brief' },
        },
      },
      db,
      now: () => '2026-03-15T10:00:00.000Z',
    });

    expect(proposal.status).toBe('pending_approval');
    expect(proposal.proposed_version).toBe(2);
    expect(proposal.base_profile_id).toBe('profile-1');
    expect(proposal.candidate_profile.profile_name).toBe('apple_mbr_v2');
    expect(proposal.candidate_profile.canonical_structure.sheets).toEqual(['Raw_Data', 'Dashboard']);
    expect(proposal.candidate_profile.canonical_text_style.tone).toBe('executive_brief');
  });

  it('approves a proposal into a new active baseline and supersedes the prior baseline', async () => {
    const db = createMockDb({
      company_output_profiles: [
        {
          id: 'profile-1',
          employee_id: 'emp-1',
          team_id: 'sales_ops',
          doc_type: 'monthly_business_review',
          profile_name: 'apple_mbr_v1',
          version: 1,
          status: 'active',
          confidence: 0.81,
          sample_count: 6,
          canonical_text_style: { tone: 'formal' },
        },
      ],
      company_output_profile_proposals: [
        {
          id: 'proposal-1',
          employee_id: 'emp-1',
          team_id: 'sales_ops',
          doc_type: 'monthly_business_review',
          proposal_name: 'apple_mbr_v2',
          status: 'pending_approval',
          base_profile_id: 'profile-1',
          source_style_profile_id: 'legacy-1',
          proposed_version: 2,
          rationale: 'Move KPI cards above issues log.',
          requested_by: 'manager-1',
          deliverable_type: 'monthly_business_review',
          audience: 'VP Sales',
          format: 'spreadsheet',
          channel: 'excel',
          candidate_profile: {
            profile_name: 'apple_mbr_v2',
            sample_count: 8,
            confidence: 0.9,
            canonical_text_style: { tone: 'executive' },
          },
        },
      ],
    });

    const result = await approveOutputProfileProposal({
      proposalId: 'proposal-1',
      reviewComment: 'Ship this as the new baseline.',
      db,
      now: () => '2026-03-15T11:00:00.000Z',
    });

    expect(result.profile.status).toBe('active');
    expect(result.profile.version).toBe(2);
    expect(result.profile.base_profile_id).toBe('profile-1');
    expect(result.profile.approved_by).toBe('manager-1');
    expect(result.proposal.status).toBe('approved');
    expect(result.proposal.activated_profile_id).toBe(result.profile.id);

    expect(db.tables.company_output_profiles.find((row) => row.id === 'profile-1')?.status).toBe('superseded');
    expect(db.tables.company_output_profiles.filter((row) => row.status === 'active')).toHaveLength(1);
  });

  it('rolls back to a prior version by cloning it into a new active version', async () => {
    const db = createMockDb({
      company_output_profiles: [
        {
          id: 'profile-1',
          employee_id: 'emp-1',
          team_id: 'sales_ops',
          doc_type: 'monthly_business_review',
          profile_name: 'apple_mbr_v1',
          version: 1,
          status: 'superseded',
          deliverable_type: 'monthly_business_review',
          audience: 'VP Sales',
          format: 'spreadsheet',
          channel: 'excel',
          confidence: 0.8,
          sample_count: 6,
          canonical_structure: { sheets: ['KPI_Summary', 'Dashboard'] },
        },
        {
          id: 'profile-2',
          employee_id: 'emp-1',
          team_id: 'sales_ops',
          doc_type: 'monthly_business_review',
          profile_name: 'apple_mbr_v2',
          version: 2,
          status: 'active',
          deliverable_type: 'monthly_business_review',
        },
      ],
    });

    const rollback = await rollbackOutputProfile({
      profileId: 'profile-1',
      reviewComment: 'Restore the prior sheet ordering.',
      db,
      now: () => '2026-03-15T12:00:00.000Z',
    });

    expect(rollback.status).toBe('active');
    expect(rollback.version).toBe(3);
    expect(rollback.base_profile_id).toBe('profile-1');
    expect(rollback.change_summary).toContain('Rollback to version 1');
    expect(rollback.canonical_structure.sheets).toEqual(['KPI_Summary', 'Dashboard']);
    expect(db.tables.company_output_profiles.find((row) => row.id === 'profile-2')?.status).toBe('superseded');
  });
});
