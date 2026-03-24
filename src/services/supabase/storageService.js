import { supabase } from './core.js';

export const userFilesService = {
  async getLatestFile(userId) {
    const { data, error } = await supabase
      .from('user_files')
      .select('data')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) throw error;
    return data && data.length > 0 ? data[0] : null;
  },

  async getFileById(userId, fileId, { includeData = true } = {}) {
    const columns = includeData ? '*' : 'id, user_id, filename, created_at';
    const { data, error } = await supabase
      .from('user_files')
      .select(columns)
      .eq('user_id', userId)
      .eq('id', fileId)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  },

  async saveFile(userId, filename, data) {
    const payload = {
      user_id: userId,
      filename,
      data: { rows: data, version: `v-${Date.now()}` },
    };

    const { data: insertedData, error } = await supabase
      .from('user_files')
      .insert([payload])
      .select()
      .single();

    if (error) throw error;
    return insertedData;
  },

  async getAllFiles(userId) {
    const { data, error } = await supabase
      .from('user_files')
      .select('id, user_id, filename, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },
};

