import type {
  ChatMessage,
  ModelDescriptor,
  ProviderSummary,
  ToolCallDisplaySchema,
} from '@jupiter/contracts';
import type { z } from 'zod';

export type CredentialVault = {
  get: (providerId: string) => Promise<string | undefined>;
  set: (providerId: string, credential: string) => Promise<string>;
  delete: (providerId: string) => Promise<void>;
};

export type ProviderCompletion = {
  content: string;
  toolCalls: z.infer<typeof ToolCallDisplaySchema>[];
  usage?: ChatMessage['usage'];
};

export type ProviderAdapter = {
  provider: ProviderSummary;
  discoverModels: (
    credential: string | undefined,
    signal: AbortSignal,
  ) => Promise<ModelDescriptor[]>;
  streamChat: (
    input: {
      modelId: string;
      messages: readonly Pick<ChatMessage, 'role' | 'content'>[];
      credential: string | undefined;
    },
    onDelta: (delta: string) => void,
    signal: AbortSignal,
  ) => Promise<ProviderCompletion>;
};

export type FetchLike = typeof fetch;
