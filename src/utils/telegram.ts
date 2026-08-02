import { Env } from '../types';

/**
 * Sends a notification message to a Telegram group using the Telegram Bot API.
 */
export async function sendTelegramNotification(env: Env, text: string): Promise<boolean> {
  const token = env.TELEGRAM_BOT_TOKEN || env.VITE_TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID || env.VITE_TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn('⚠️ [Telegram Bot Dev Mode]: Credentials missing (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID). Payload:');
    console.log('--------------------------------------------------');
    console.log(text);
    console.log('--------------------------------------------------');
    return false;
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
      const errBody = await response.text();
      console.error('❌ [Telegram Bot Error]: Failed to send message.', response.status, errBody);
      return false;
    }

    console.log('✅ [Telegram Bot]: Notification sent successfully.');
    return true;
  } catch (error) {
    console.error('❌ [Telegram Bot Error]: Exception during fetch call.', error);
    return false;
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
): Promise<void> {
  try {
    // Get the timestamp of the latest task currently in the DB (before or after insert)
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

      await sendTelegramNotification(env, message);
    } else {
      console.log(`ℹ️ [Telegram Bot]: Cooldown active (last task created ${hoursSinceLast.toFixed(2)}h ago < 12h). Notification skipped.`);
    }
  } catch (err) {
    console.error('❌ [Telegram Bot Error]: Failed during cooldown check or notification dispatch:', err);
  }
}
