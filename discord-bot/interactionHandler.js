// interactionHandler.js — Handle Discord button interactions (approve/deny)
// ─────────────────────────────────────────────────────────────────────────────

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getSupabase } from './supabaseClient.js';

/**
 * Handle button interaction for task approval/denial.
 *
 * @param {import('discord.js').Interaction} interaction
 */
export async function handleInteraction(interaction) {
  // Only handle button clicks
  if (!interaction.isButton()) return;

  const customId = interaction.customId;
  const isApprove = customId.startsWith('approve_');
  const isDeny = customId.startsWith('deny_');

  if (!isApprove && !isDeny) return;

  const queueId = customId.replace(/^(approve|deny)_/, '');
  const action = isApprove ? 'approved' : 'denied';
  const decidedBy = interaction.user.tag;

  const supabase = getSupabase();
  if (!supabase) {
    await interaction.reply({ content: '⚠️ 資料庫連線失敗', ephemeral: true });
    return;
  }

  try {
    // Update queue status
    const { data: row, error } = await supabase
      .from('discord_approval_queue')
      .update({
        status: action,
        decided_by: decidedBy,
        decided_at: new Date().toISOString(),
      })
      .eq('id', queueId)
      .in('status', ['pending', 'sent'])  // Only update if still pending/sent
      .select()
      .single();

    if (error || !row) {
      await interaction.reply({
        content: '⚠️ 此核准請求已過期或已處理',
        ephemeral: true,
      });
      return;
    }

    // Update the original message: disable buttons + show result
    const statusEmoji = isApprove ? '✅' : '❌';
    const statusText = isApprove ? '已核准' : '已拒絕';

    const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
      .setColor(isApprove ? 0x00FF00 : 0xFF0000)
      .addFields({
        name: `${statusEmoji} 決定`,
        value: `${statusText} by ${decidedBy} at ${new Date().toLocaleString('zh-TW')}`,
        inline: false,
      });

    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve_${queueId}`)
        .setLabel('✅ 核准執行')
        .setStyle(ButtonStyle.Success)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`deny_${queueId}`)
        .setLabel('❌ 拒絕')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(true),
    );

    await interaction.update({
      embeds: [updatedEmbed],
      components: [disabledRow],
    });

    console.log(`[interactionHandler] ${statusEmoji} Task ${row.task_id} ${action} by ${decidedBy}`);

    // If approved, also update the task status directly in ai_employee_tasks
    if (isApprove && row.task_id) {
      const { error: taskErr } = await supabase
        .from('ai_employee_tasks')
        .update({ status: 'queued', updated_at: new Date().toISOString() })
        .eq('id', row.task_id)
        .eq('status', 'waiting_approval');

      if (taskErr) {
        console.warn('[interactionHandler] Failed to queue task:', taskErr.message);
      } else {
        console.log(`[interactionHandler] 🚀 Task ${row.task_id} queued for execution`);
      }
    }

    // If denied, cancel the task
    if (isDeny && row.task_id) {
      const { error: taskErr } = await supabase
        .from('ai_employee_tasks')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', row.task_id);

      if (taskErr) {
        console.warn('[interactionHandler] Failed to cancel task:', taskErr.message);
      } else {
        console.log(`[interactionHandler] 🛑 Task ${row.task_id} cancelled`);
      }
    }
  } catch (err) {
    console.error('[interactionHandler] Error:', err.message);
    try {
      await interaction.reply({ content: '⚠️ 處理失敗，請稍後再試', ephemeral: true });
    } catch { /* already replied */ }
  }
}

export default { handleInteraction };
