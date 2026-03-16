import { ASSISTANT_NAME } from '../../config/branding';
import { supabase } from './core.js';

export const conversationsService = {
  async getConversations(userId) {
    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  async createConversation(userId, title = 'New Conversation') {
    const newConversation = {
      id: Date.now().toString(),
      user_id: userId,
      title,
      messages: [{
        role: 'ai',
        content: `Hello! I am your ${ASSISTANT_NAME}. How can I help you today?`,
      }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('conversations')
      .insert([newConversation]);

    if (error) throw error;
    return newConversation;
  },

  async updateConversation(conversationId, userId, updates) {
    const { data, error } = await supabase
      .from('conversations')
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversationId)
      .eq('user_id', userId)
      .select();

    if (error) throw error;
    return data[0];
  },

  async deleteConversation(conversationId, userId) {
    const { error } = await supabase
      .from('conversations')
      .delete()
      .eq('id', conversationId)
      .eq('user_id', userId);

    if (error) throw error;
    return { success: true };
  },
};

export const authService = {
  async signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;
    return data;
  },

  async signUp(email, password) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
    });

    if (error) throw error;
    return data;
  },

  async signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    return { success: true };
  },

  async getSession() {
    const {
      data: { session },
      error,
    } = await supabase.auth.getSession();
    if (error) throw error;
    return session;
  },

  onAuthStateChange(callback) {
    return supabase.auth.onAuthStateChange(callback);
  },
};

export const uploadMappingsService = {
  async saveMapping(userId, uploadType, originalColumns, mappingJson) {
    const payload = {
      user_id: userId,
      upload_type: uploadType,
      original_columns: originalColumns,
      mapping_json: mappingJson,
    };

    const { data, error } = await supabase
      .from('upload_mappings')
      .upsert(payload, {
        onConflict: 'user_id,upload_type',
        returning: 'representation',
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async getMapping(userId, uploadType) {
    const { data, error } = await supabase
      .from('upload_mappings')
      .select('*')
      .eq('user_id', userId)
      .eq('upload_type', uploadType)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }
    return data;
  },

  async getAllMappings(userId) {
    const { data, error } = await supabase
      .from('upload_mappings')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  async deleteMapping(userId, uploadType) {
    const { error } = await supabase
      .from('upload_mappings')
      .delete()
      .eq('user_id', userId)
      .eq('upload_type', uploadType);

    if (error) throw error;
    return { success: true };
  },

  async smartMapping(userId, uploadType, currentColumns) {
    const savedMapping = await this.getMapping(userId, uploadType);

    if (!savedMapping) {
      return {};
    }

    const { original_columns: savedColumns, mapping_json: savedMappingJson } = savedMapping;
    const smartMappingResult = {};

    currentColumns.forEach((currentCol) => {
      if (savedColumns.includes(currentCol) && savedMappingJson[currentCol]) {
        smartMappingResult[currentCol] = savedMappingJson[currentCol];
      } else {
        const lowerCurrentCol = currentCol.toLowerCase();
        const matchedCol = savedColumns.find(
          (savedCol) => savedCol.toLowerCase() === lowerCurrentCol,
        );

        if (matchedCol && savedMappingJson[matchedCol]) {
          smartMappingResult[currentCol] = savedMappingJson[matchedCol];
        }
      }
    });

    return smartMappingResult;
  },
};

