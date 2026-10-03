import { readFileSync } from 'node:fs';
import { PacketFactory, type DefsFile, type StatTypesFile } from './PacketFactory.ts';

export interface ProtocolSchema {
  definitions: DefsFile;
  stats: StatTypesFile;
}

const DATA_DIR = new URL('../../data/', import.meta.url);

/** Read the canonical packet and stat definitions from `data/`. */
export function loadSchema(dataDir: URL = DATA_DIR): ProtocolSchema {
  return {
    definitions: JSON.parse(readFileSync(new URL('packet-definitions.json', dataDir), 'utf8')) as DefsFile,
    stats: JSON.parse(readFileSync(new URL('stat-types.json', dataDir), 'utf8')) as StatTypesFile,
  };
}

export function createFactory(schema: ProtocolSchema = loadSchema(), quiet = true): PacketFactory {
  return new PacketFactory(schema.definitions, schema.stats, quiet);
}
