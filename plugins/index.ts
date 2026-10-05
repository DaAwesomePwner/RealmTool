import type { PluginDefinition } from '../src/plugins/api.ts';
import chatFilter from './chat-filter/index.ts';
import serverSwitch from './server-switch/index.ts';
import autoNexus from './auto-nexus/index.ts';
import autoDrink from './auto-drink/index.ts';
import serverMessages from './server-messages/index.ts';

/** Built-in plugins, loaded in this order. */
export const BUILTIN_PLUGINS: readonly PluginDefinition[] = [chatFilter, serverSwitch, autoNexus, autoDrink, serverMessages];
