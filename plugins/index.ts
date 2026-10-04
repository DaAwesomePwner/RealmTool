import type { PluginDefinition } from '../src/plugins/api.ts';
import chatFilter from './chat-filter/index.ts';

/** Built-in plugins, loaded in this order. */
export const BUILTIN_PLUGINS: readonly PluginDefinition[] = [chatFilter];
