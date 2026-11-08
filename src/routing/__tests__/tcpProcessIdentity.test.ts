import { afterEach, describe, expect, it } from 'vitest';
import {
  parseTcpOwnerTable, readProcessIdentity, readTcpProcessIdentity, setTcpOwnerSource, tcpOwnerSourceError, type TcpOwnerRow, type TcpOwnerSource,
} from '../tcpProcessIdentity.ts';

const LOOPBACK = 0x0100007f;
const ESTABLISHED = 5;
const netPort = (port: number) => ((port & 0xff) << 8) | (port >>> 8);

function table(rows: TcpOwnerRow[]): Buffer {
  const buffer = Buffer.alloc(4 + rows.length * 24);
  buffer.writeUInt32LE(rows.length, 0);
  rows.forEach((row, i) => {
    const o = 4 + i * 24;
    buffer.writeUInt32LE(row.state, o);
    buffer.writeUInt32LE(row.localAddr, o + 4);
    buffer.writeUInt32LE(netPort(row.localPort), o + 8);
    buffer.writeUInt32LE(row.remoteAddr, o + 12);
    buffer.writeUInt32LE(netPort(row.remotePort), o + 16);
    buffer.writeUInt32LE(row.pid, o + 20);
  });
  return buffer;
}

const gameRow: TcpOwnerRow = { state: ESTABLISHED, localAddr: LOOPBACK, localPort: 50123, remoteAddr: LOOPBACK, remotePort: 2050, pid: 4242 };
const source = (rows: TcpOwnerRow[], created: bigint | null = 133_000_000_000_000_000n): TcpOwnerSource =>
  ({ tcpRows: () => rows, processCreationTime: () => created });

describe('TCP process identity', () => {
  it('revalidates process creation without a socket and tolerates unavailable processes', () => {
    expect(readProcessIdentity(4242, source([], 100n))).toEqual({ pid: 4242, processStartTime: '100' });
    expect(readProcessIdentity(4242, source([], 200n))).toEqual({ pid: 4242, processStartTime: '200' });
    expect(readProcessIdentity(4242, null)).toBeNull();
    expect(readProcessIdentity(4242, source([], null))).toBeNull();
    expect(readProcessIdentity(4242, source([], 0n))).toBeNull();
    expect(readProcessIdentity(-1, source([]))).toBeNull();
    expect(readProcessIdentity(4242, {
      tcpRows: () => { throw new Error('must not read TCP table'); },
      processCreationTime: () => { throw new Error('access denied'); },
    })).toBeNull();
  });

  it('parses MIB_TCPTABLE_OWNER_PID rows with network-order ports', () => {
    expect(parseTcpOwnerTable(table([gameRow]))).toEqual([gameRow]);
    expect(parseTcpOwnerTable(Buffer.alloc(2))).toBeNull();
  });

  it('identifies the single established loopback row', () => {
    expect(readTcpProcessIdentity(50123, 2050, source([gameRow])))
      .toEqual({ pid: 4242, processStartTime: '133000000000000000' });
  });

  it('refuses ambiguous, non-established or creation-less matches', () => {
    expect(readTcpProcessIdentity(50123, 2050, source([gameRow, { ...gameRow, pid: 9 }]))).toBeNull();
    expect(readTcpProcessIdentity(50123, 2050, source([{ ...gameRow, state: 2 }]))).toBeNull();
    expect(readTcpProcessIdentity(50123, 2050, source([gameRow], null))).toBeNull();
    expect(readTcpProcessIdentity(0, 2050, source([gameRow]))).toBeNull();
  });
});

describe('tcpOwnerSourceError', () => {
  afterEach(() => setTcpOwnerSource(undefined));

  it('reports a working source as null and a missing one with a reason', () => {
    setTcpOwnerSource(source([gameRow]));
    expect(tcpOwnerSourceError()).toBeNull();
    setTcpOwnerSource(null);
    expect(tcpOwnerSourceError()).toBe('TCP owner lookup unavailable');
  });

  it.runIf(process.platform === 'win32')('loads koffi and the Win32 TCP table on Windows', () => {
    setTcpOwnerSource(undefined);
    expect(tcpOwnerSourceError()).toBeNull();
  });
});
