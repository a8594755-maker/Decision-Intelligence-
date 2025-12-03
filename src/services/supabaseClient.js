import { createClient } from '@supabase/supabase-js';

// Supabase configuration
const supabaseUrl = "https://cbxvqqqulwytdblivtoe.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNieHZxcXF1bHd5dGRibGl2dG9lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ0NjQzNjUsImV4cCI6MjA4MDA0MDM2NX0.3PeFtqJAkoxrosFeAiXbOklRCDxaQjH2VjXWwEiFyYI";

export const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * User Files Operations
 */
export const userFilesService = {
  // 獲取用戶最新上傳的文件
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

  // 保存文件到雲端
  async saveFile(userId, filename, data) {
    const payload = {
      user_id: userId,
      filename,
      data: { rows: data, version: `v-${Date.now()}` }
    };

    const { error } = await supabase
      .from('user_files')
      .insert([payload]);

    if (error) throw error;
    return payload;
  },

  // 獲取所有文件
  async getAllFiles(userId) {
    const { data, error } = await supabase
      .from('user_files')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }
};

/**
 * Suppliers Operations
 */
export const suppliersService = {
  // 批量插入供應商
  async insertSuppliers(suppliers) {
    if (!suppliers || suppliers.length === 0) {
      return { success: true, count: 0 };
    }

    const { data, error } = await supabase
      .from('suppliers')
      .insert(suppliers)
      .select();

    if (error) throw error;
    return { success: true, count: data.length, data };
  },

  // 獲取所有供應商
  async getAllSuppliers() {
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  // 更新供應商
  async updateSupplier(id, updates) {
    const { data, error } = await supabase
      .from('suppliers')
      .update(updates)
      .eq('id', id)
      .select();

    if (error) throw error;
    return data[0];
  },

  // 刪除供應商
  async deleteSupplier(id) {
    const { error } = await supabase
      .from('suppliers')
      .delete()
      .eq('id', id);

    if (error) throw error;
    return { success: true };
  },

  // 搜索供應商
  async searchSuppliers(searchTerm) {
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .or(`supplier_name.ilike.%${searchTerm}%,contact_info.ilike.%${searchTerm}%,address.ilike.%${searchTerm}%`)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }
};

/**
 * Conversations Operations (AI Chat)
 */
export const conversationsService = {
  // 獲取所有對話
  async getConversations(userId) {
    const { data, error } = await supabase
      .from('conversations')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  // 創建新對話
  async createConversation(userId, title = 'New Conversation') {
    const newConversation = {
      id: Date.now().toString(),
      user_id: userId,
      title,
      messages: [{
        role: 'ai',
        content: 'Hello! I am your SmartOps Decision Assistant. How can I help you today?'
      }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from('conversations')
      .insert([newConversation]);

    if (error) throw error;
    return newConversation;
  },

  // 更新對話
  async updateConversation(conversationId, userId, updates) {
    const { data, error } = await supabase
      .from('conversations')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('id', conversationId)
      .eq('user_id', userId)
      .select();

    if (error) throw error;
    return data[0];
  },

  // 刪除對話
  async deleteConversation(conversationId, userId) {
    const { error } = await supabase
      .from('conversations')
      .delete()
      .eq('id', conversationId)
      .eq('user_id', userId);

    if (error) throw error;
    return { success: true };
  }
};

/**
 * Authentication Operations
 */
export const authService = {
  // 登入
  async signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) throw error;
    return data;
  },

  // 註冊
  async signUp(email, password) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password
    });

    if (error) throw error;
    return data;
  },

  // 登出
  async signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    return { success: true };
  },

  // 獲取當前 session
  async getSession() {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) throw error;
    return session;
  },

  // 監聽認證狀態變化
  onAuthStateChange(callback) {
    return supabase.auth.onAuthStateChange(callback);
  }
};
