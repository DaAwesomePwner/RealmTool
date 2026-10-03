import { afterEach, describe, expect, it } from 'vitest';
import { log, type LogRecord } from '../log.ts';

describe('log', () => {
  afterEach(() => { log.setConsole(true); log.setDebug(false); });

  it('delivers records to sinks until the sink is removed', () => {
    log.setConsole(false);
    const records: LogRecord[] = [];
    const remove = log.addSink(record => records.push(record));
    log.info('Test', 'hello');
    log.warn('Test', 'careful');
    remove();
    log.info('Test', 'after');
    expect(records.map(r => [r.level, r.module, r.message])).toEqual([
      ['info', 'Test', 'hello'],
      ['warn', 'Test', 'careful'],
    ]);
  });

  it('drops debug records unless debug is enabled', () => {
    log.setDebug(false);
    log.setConsole(false);
    const records: LogRecord[] = [];
    const remove = log.addSink(record => records.push(record));
    log.debug('Test', 'hidden');
    log.setDebug(true);
    log.debug('Test', 'shown');
    remove();
    expect(records.map(r => r.message)).toEqual(['shown']);
  });

  it('appends the error message to error records', () => {
    log.setConsole(false);
    const records: LogRecord[] = [];
    const remove = log.addSink(record => records.push(record));
    log.error('Test', 'failed', new Error('boom'));
    remove();
    expect(records[0].message).toMatch(/^failed: .*boom/s);
  });
});
