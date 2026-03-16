// approvalService.js — Poll discord_approval_queue + send Discord embeds with buttons
// ─────────────────────────────────────────────────────────────────────────────

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getSupabase } from './supabaseClient.js';
import { config } from './config.js';

const SEVERITY_COLORS = {
  critical: 0xFF0000,
  high:     0xFF8C00,
  medium:   0xFFD700,
  low:      0x32CD32,
};

const PRIORITY_EMOJI = {
  urgent: '🔴',
  high:   '🟠',
  medium: '🟡',
  low:    '🟢',
};

/**
 * Build a Discord embed + buttons for an approval request.
 */
function buildApprovalMessage(item) {
  const embed = new EmbedBuilder()
    .setTitle('🔔 任務需要核准')
    .setColor(SEVERITY_COLORS[item.severity] || 0x5865F2)
    .addFields(
      { name: '📋 任務', value: item.title || 'Unknown', inline: false },
      { name: '🏷️ 優先級', value: `${PRIORITY_EMOJI[item.priority] || '⚪'} ${item.priority || 'medium'}`, inline: true },
      { name: '⚠️ 嚴重度', value: item.severity || 'unknown', inline: true },
      { name: '📌 類型', value: item.alert_type || 'manual', inline: true },
    )
    .setTimestamp(new Date(item.created_at));

  if (item.description) {
    embed.setDescription(item.description.slice(0, 4096));
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve_${item.id}`)
      .setLabel('✅ 核准執行')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`deny_${item.id}`)
      .setLabel('❌ 拒絕')
      .setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row] };
}

/**
 * Poll for pending approvals and send Discord messages.
 * Called on interval from bot.js.
 *
 * @param {import('discord.js').Client} client - Discord client
 */
export async function pollAndNotify(client) {
  const supabase = getSupabase();
  if (!supabase) return;

  const channelId = config.approvalChannelId;
  if (!channelId) return;

  try {
    // Fetch pending items that haven't been sent to Discord yet
    const { data: pending, error } = await supabase
      .from('discord_approval_queue')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(10);

    if (error) {
      console.warn('[approvalService] Query error:', error.message);
      return;
    }
    if (!pending || pending.length === 0) return;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      console.warn('[approvalService] Cannot find approval channel:', channelId);
      return;
    }

    for (const item of pending) {
      try {
        // Check expiry
        if (item.expires_at && new Date(item.expires_at) < new Date()) {
          await supabase.from('discord_approval_queue')
            .update({ status: 'expired' })
            .eq('id', item.id);
          continue;
        }

        const message = await channel.send(buildApprovalMessage(item));

        // Mark as sent + store Discord message ID
        await supabase.from('discord_approval_queue')
          .update({
            status: 'sent',
            discord_message_id: message.id,
            discord_channel_id: channelId,
          })
          .eq('id', item.id);

        console.log(`[approvalService] 📤 Sent approval request: ${item.title} (${item.id})`);
      } catch (err) {
        console.warn('[approvalService] Failed to send approval:', item.id, err.message);
      }
    }
  } catch (err) {
    console.warn('[approvalService] pollAndNotify error:', err.message);
  }
}

/**
 * Expire stale approvals that have passed their expires_at.
 */
export async function expireStaleApprovals() {
  const supabase = getSupabase();
  if (!supabase) return;

  try {
    const { data, error } = await supabase
      .from('discord_approval_queue')
      .update({ status: 'expired' })
      .in('status', ['pending', 'sent'])
      .lt('expires_at', new Date().toISOString())
      .select('id');

    if (error) {
      console.warn('[approvalService] expireStaleApprovals error:', error.message);
      return;
    }
    if (data?.length > 0) {
      console.log(`[approvalService] Expired ${data.length} stale approvals`);
    }
  } catch (err) {
    console.warn('[approvalService] expireStaleApprovals error:', err.message);
  }
}

export default { pollAndNotify, expireStaleApprovals };
