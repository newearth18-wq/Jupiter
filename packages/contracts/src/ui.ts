import { z } from 'zod';

export const ScreenIdSchema = z.enum([
  'home',
  'chat',
  'missions',
  'skills',
  'memory',
  'files',
  'automations',
  'models',
  'devices',
  'plugins',
  'settings',
  'diagnostics',
]);

export const LanguageSchema = z.enum(['en', 'th']);
export const ThemeSchema = z.enum(['dark', 'midnight']);
export const AvatarModeSchema = z.enum(['animated', 'static', 'hidden']);
export const TextScaleSchema = z.union([
  z.literal(0.9),
  z.literal(1),
  z.literal(1.1),
  z.literal(1.25),
]);

export const UiPreferencesSchema = z
  .object({
    language: LanguageSchema,
    theme: ThemeSchema,
    reduceMotion: z.boolean(),
    avatarMode: AvatarModeSchema,
    compactMode: z.boolean(),
    textScale: TextScaleSchema,
    lastView: ScreenIdSchema,
  })
  .strict();

export const UiPreferencesUpdateSchema = UiPreferencesSchema.partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one preference is required.');

export const WindowStateSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().min(600),
    height: z.number().int().min(320),
    maximized: z.boolean(),
  })
  .strict();

export const DEFAULT_UI_PREFERENCES = Object.freeze({
  language: 'en',
  theme: 'dark',
  reduceMotion: false,
  avatarMode: 'animated',
  compactMode: false,
  textScale: 1,
  lastView: 'home',
}) satisfies UiPreferences;

export type ScreenId = z.infer<typeof ScreenIdSchema>;
export type Language = z.infer<typeof LanguageSchema>;
export type Theme = z.infer<typeof ThemeSchema>;
export type AvatarMode = z.infer<typeof AvatarModeSchema>;
export type TextScale = z.infer<typeof TextScaleSchema>;
export type UiPreferences = z.infer<typeof UiPreferencesSchema>;
export type UiPreferencesUpdate = z.infer<typeof UiPreferencesUpdateSchema>;
export type WindowState = z.infer<typeof WindowStateSchema>;
