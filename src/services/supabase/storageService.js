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

  async getFileById(userId, fileId) {
    const { data, error } = await supabase
      .from('user_files')
      .select('*')
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
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },
};

