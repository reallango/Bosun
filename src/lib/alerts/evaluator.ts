import { rqlite, rowsToObjects } from '@/lib/db/rqlite-client';
import { sendAlertEmail } from '../notifications/email';
import { sendDiscordWebhook, sendSlackWebhook, sendGenericWebhook } from '../notifications/webhook';

export interface AlertRule {
  id: string;
  name: string;
  metric: string;
  condition: string;
  threshold: number;
  notification_channel_ids: string[];
  cooldown_seconds: number;
  enabled: boolean;
  last_triggered: string | null;
}

export interface NotificationChannel {
  id: string;
  type: 'email' | 'webhook' | 'discord' | 'slack';
  config: Record<string, string>;
}

export async function evaluateAlert(rule: AlertRule, currentValue: number): Promise<boolean> {
  if (!rule.enabled) return false;
  
  if (rule.last_triggered) {
    const lastTriggered = new Date(rule.last_triggered).getTime();
    const now = Date.now();
    if ((now - lastTriggered) < rule.cooldown_seconds * 1000) {
      return false;
    }
  }

  let triggered = false;
  switch (rule.condition) {
    case 'gt': triggered = currentValue > rule.threshold; break;
    case 'lt': triggered = currentValue < rule.threshold; break;
    case 'eq': triggered = currentValue === rule.threshold; break;
    case 'ne': triggered = currentValue !== rule.threshold; break;
    case 'gte': triggered = currentValue >= rule.threshold; break;
    case 'lte': triggered = currentValue <= rule.threshold; break;
  }

  return triggered;
}

export async function triggerAlert(rule: AlertRule, message: string): Promise<void> {
  await rqlite.execute(
    'UPDATE alert_rules SET last_triggered = ? WHERE id = ?',
    [new Date().toISOString(), rule.id]
  );

  const channels = await rqlite.query(
    'SELECT * FROM notification_channels WHERE id IN (' + rule.notification_channel_ids.map(() => '?').join(',') + ')',
    rule.notification_channel_ids
  );
  const channelRows = rowsToObjects(channels) as unknown[] as NotificationChannel[];

  for (const channel of channelRows) {
    try {
      switch (channel.type) {
        case 'email':
          await sendAlertEmail(channel.config.email, rule.name, message);
          break;
        case 'discord':
          await sendDiscordWebhook(channel.config.url, { content: `${rule.name}: ${message}` });
          break;
        case 'slack':
          await sendSlackWebhook(channel.config.url, `${rule.name}: ${message}`);
          break;
        case 'webhook':
          await sendGenericWebhook(channel.config.url, { alert: rule.name, message });
          break;
      }
    } catch (err) {
      console.error(`Failed to send to channel ${channel.id}:`, err);
    }
  }
}

export async function evaluateAllAlerts(): Promise<void> {
  const rules = await rqlite.query('SELECT * FROM alert_rules WHERE enabled = true');
  const ruleRows = rowsToObjects(rules) as unknown[] as AlertRule[];

  for (const rule of ruleRows) {
    if (rule.last_triggered) {
      const lastTriggered = new Date(rule.last_triggered).getTime();
      const now = Date.now();
      if ((now - lastTriggered) < rule.cooldown_seconds * 1000) {
        continue;
      }
    }

    const triggered = await evaluateAlert(rule, 0);
    if (triggered) {
      await triggerAlert(rule, `${rule.metric} threshold exceeded`);
    }
  }
}