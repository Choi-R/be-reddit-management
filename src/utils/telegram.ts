import { Env } from '../types';

/**
 * Sends a notification message to a Telegram group using the Telegram Bot API.
 */
export async function sendTelegramNotification(
  env: Env,
  text: string,
  targetChatId?: string | number
): Promise<{ success: boolean; reason: string }> {
  const token = env.TELEGRAM_BOT_TOKEN || env.VITE_TELEGRAM_BOT_TOKEN;
  const chatId = targetChatId || env.TELEGRAM_CHAT_ID || env.VITE_TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    const missing: string[] = [];
    if (!token) missing.push('TELEGRAM_BOT_TOKEN');
    if (!chatId) missing.push('TELEGRAM_CHAT_ID');
    const reason = `Telegram credentials missing in Cloudflare environment secrets: ${missing.join(', ')}`;
    console.warn(`⚠️ [Telegram Bot Dev Mode]: ${reason}`);
    return { success: false, reason };
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      let migrateChatId: number | string | null = null;
      try {
        const errJson = JSON.parse(errText);
        if (errJson?.parameters?.migrate_to_chat_id) {
          migrateChatId = errJson.parameters.migrate_to_chat_id;
        }
      } catch {}

      if (migrateChatId && String(migrateChatId) !== String(chatId)) {
        console.warn(`[Telegram Bot]: Group upgraded to supergroup. Retrying with migrated chat_id: ${migrateChatId}`);
        return await sendTelegramNotification(env, text, migrateChatId);
      }

      const reason = `Telegram API Error (HTTP ${response.status}): ${errText}`;
      console.error('[Telegram Bot Error]:', reason);
      return { success: false, reason };
    }

    console.log('✅ [Telegram Bot]: Notification sent successfully.');
    return { success: true, reason: 'Notification sent successfully to Telegram group.' };
  } catch (error: any) {
    const reason = `Fetch exception: ${error?.message || String(error)}`;
    console.error('❌ [Telegram Bot Error]:', reason);
    return { success: false, reason };
  }
}

/**
 * Checks if 12+ hours have passed since the latest task was created.
 * If so, fires a notification to the Telegram group.
 */
export async function checkAndNotifyTelegramTaskCreated(
  pool: any,
  env: Env,
  taskCount: number = 1
): Promise<{ notified: boolean; reason: string }> {
  try {
    // Query the timestamp of the latest task currently in the DB before inserting new task
    const latestTaskRes = await pool.query(
      `SELECT created_at FROM tasks ORDER BY created_at DESC LIMIT 1`
    );

    let shouldNotify = false;
    let hoursSinceLast = 0;

    if (latestTaskRes.rows.length === 0) {
      // First task ever in system
      shouldNotify = true;
    } else {
      const lastCreatedAt = new Date(latestTaskRes.rows[0].created_at).getTime();
      const now = Date.now();
      hoursSinceLast = (now - lastCreatedAt) / (1000 * 60 * 60);

      if (hoursSinceLast >= 12) {
        shouldNotify = true;
      }
    }

    if (shouldNotify) {
      const frontendUrl = env.FRONTEND_URL || env.VITE_FRONTEND_URL || 'https://reddit-management.pages.dev';
      const taskText = taskCount > 1 ? `${taskCount} new tasks have` : 'A new task has';
      const message = `📢 <b>New Task Available!</b>\n\n${taskText} been added to the platform!\n\n👉 <a href="${frontendUrl}">Log in to claim tasks</a>`;

      const sendResult = await sendTelegramNotification(env, message);
      return { notified: sendResult.success, reason: sendResult.reason };
    } else {
      const reason = `Cooldown active: The most recent existing task was created ${hoursSinceLast.toFixed(2)} hours ago (less than 12-hour required cooldown).`;
      console.log(`ℹ️ [Telegram Bot]: ${reason}`);
      return { notified: false, reason };
    }
  } catch (err: any) {
    const reason = `Cooldown check error: ${err?.message || String(err)}`;
    console.error('❌ [Telegram Bot Error]:', reason);
    return { notified: false, reason };
  }
}
