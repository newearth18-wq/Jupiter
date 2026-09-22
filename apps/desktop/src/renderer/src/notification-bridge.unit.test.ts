import { describe, expect, it } from 'vitest';
import { windowsNotificationBridge } from './notification-bridge.js';

describe('Windows notification bridge interface', () => {
  it('reports unavailable instead of simulating native delivery', async () => {
    expect(windowsNotificationBridge.availability).toBe('unavailable');
    await expect(windowsNotificationBridge.deliver('title', 'message')).resolves.toMatchObject({
      status: 'unavailable',
    });
  });
});
