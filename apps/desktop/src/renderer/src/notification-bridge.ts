export type NotificationDeliveryResult =
  { status: 'delivered' } | { status: 'unavailable'; reason: string };

export type SystemNotificationBridge = {
  availability: 'unavailable';
  deliver: (title: string, message: string) => Promise<NotificationDeliveryResult>;
};

export const windowsNotificationBridge: SystemNotificationBridge = Object.freeze({
  availability: 'unavailable',
  deliver: () =>
    Promise.resolve<NotificationDeliveryResult>({
      status: 'unavailable',
      reason: 'Native notification delivery belongs to SET 19.',
    }),
});
