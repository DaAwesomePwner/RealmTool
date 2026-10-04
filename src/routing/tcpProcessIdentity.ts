// Ported from realm-engine-client client/src/native/tcpProcessIdentity.ts @ 9ab4f8f (MIT, see NOTICE).
import { createRequire } from 'node:module';
import { log } from '../util/log.ts';

export interface ProcessIdentity {
  readonly pid: number;
  /** Process creation FILETIME as a decimal string (pairs with the helper's hello in Phase 4). */
  readonly processStartTime: string;
}

/** One IPv4 row of GetExtendedTcpTable(TCP_TABLE_OWNER_PID_ALL), ports in host order. */
export interface TcpOwnerRow {
  state: number;
  localAddr: number;
  localPort: number;
  remoteAddr: number;
  remotePort: number;
  pid: number;
}

export interface TcpOwnerSource {
  tcpRows(): TcpOwnerRow[] | null;
  processCreationTime(pid: number): bigint | null;
}

const MIB_TCP_STATE_ESTAB = 5;
// 127.0.0.1 as the network-order DWORD GetExtendedTcpTable stores, read little-endian.
const LOOPBACK = 0x0100007f;

const validPort = (port: number) => Number.isInteger(port) && port > 0 && port <= 65535;

/**
 * The game process behind an established loopback connection to the proxy. Exactly
 * one row may match; anything else (none, several, a vanished process) is null.
 */
export function readTcpProcessIdentity(
  gamePort: number,
  proxyPort: number,
  source: TcpOwnerSource | null = win32TcpOwnerSource(),
): ProcessIdentity | null {
  if (!source || !validPort(gamePort) || !validPort(proxyPort)) return null;
  try {
    const rows = source.tcpRows();
    if (!rows) return null;
    const matches = rows.filter(row => row.state === MIB_TCP_STATE_ESTAB
      && row.localAddr === LOOPBACK && row.remoteAddr === LOOPBACK
      && row.localPort === gamePort && row.remotePort === proxyPort);
    if (matches.length !== 1) return null;
    const { pid } = matches[0];
    const created = source.processCreationTime(pid);
    if (created === null || created <= 0n || pid <= 0) return null;
    return Object.freeze({ pid, processStartTime: created.toString() });
  } catch {
    return null;
  }
}

let win32Source: TcpOwnerSource | null | undefined;
let win32LoadError: string | null = null;

/** Replace the OS source (tests); `undefined` restores lazy Win32 loading. */
export function setTcpOwnerSource(source: TcpOwnerSource | null | undefined): void {
  win32Source = source;
  win32LoadError = null;
}

/**
 * Load the TCP owner source now (startup preflight) and say why it is unavailable,
 * or null when it loaded. Without it no connection can be matched to the helper's target.
 */
export function tcpOwnerSourceError(): string | null {
  if (win32TcpOwnerSource()) return null;
  return win32LoadError ?? 'TCP owner lookup unavailable';
}

function win32TcpOwnerSource(): TcpOwnerSource | null {
  if (win32Source !== undefined) return win32Source;
  win32Source = null;
  if (process.platform !== 'win32') {
    win32LoadError = `TCP owner lookup needs Windows (running on ${process.platform})`;
    return null;
  }
  try {
    const koffi = createRequire(import.meta.url)('koffi');
    const iphlpapi = koffi.load('iphlpapi.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const GetExtendedTcpTable = iphlpapi.func('uint32_t __stdcall GetExtendedTcpTable(void *pTcpTable, _Inout_ uint32_t *pdwSize, int bOrder, uint32_t ulAf, int TableClass, uint32_t Reserved)');
    const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)');
    const GetProcessTimes = kernel32.func('int __stdcall GetProcessTimes(void *hProcess, void *lpCreationTime, void *lpExitTime, void *lpKernelTime, void *lpUserTime)');
    const CloseHandle = kernel32.func('int __stdcall CloseHandle(void *hObject)');
    const AF_INET = 2;
    const TCP_TABLE_OWNER_PID_ALL = 5;
    const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    win32Source = {
      tcpRows: () => readTcpTable((buffer, size) =>
        GetExtendedTcpTable(buffer, size, 0, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0)),
      processCreationTime(pid) {
        const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if (!handle) return null;
        try {
          const creation = Buffer.alloc(8);
          const unused = Buffer.alloc(8);
          if (!GetProcessTimes(handle, creation, unused, Buffer.alloc(8), Buffer.alloc(8))) return null;
          const filetime = creation.readBigUInt64LE(0);
          return filetime === 0n ? null : filetime;
        } finally {
          CloseHandle(handle);
        }
      },
    };
  } catch (error) {
    win32LoadError = `TCP owner lookup unavailable (koffi/Win32 load failed): ${(error as Error).message}`;
    log.warn('Routing', win32LoadError);
    win32Source = null;
  }
  return win32Source;
}

const ROW_BYTES = 24;
const NO_ERROR = 0;
const ERROR_INSUFFICIENT_BUFFER = 122;

/** Grow the buffer until GetExtendedTcpTable fits (the table can grow between calls). */
export function readTcpTable(getTable: (buffer: Buffer | null, size: number[]) => number): TcpOwnerRow[] | null {
  const size = [0];
  let buffer: Buffer | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const status = getTable(buffer, size);
    if (status === NO_ERROR && buffer) return parseTcpOwnerTable(buffer);
    if (status !== ERROR_INSUFFICIENT_BUFFER) return null;
    buffer = Buffer.alloc(size[0] + ROW_BYTES * 16);
    size[0] = buffer.length;
  }
  return null;
}

/** MIB_TCPTABLE_OWNER_PID: a DWORD count, then 24-byte rows; ports are network order. */
export function parseTcpOwnerTable(buffer: Buffer): TcpOwnerRow[] | null {
  if (buffer.length < 4) return null;
  const count = buffer.readUInt32LE(0);
  if (4 + count * ROW_BYTES > buffer.length) return null;
  const port = (raw: number) => ((raw & 0xff) << 8) | ((raw >>> 8) & 0xff);
  const rows: TcpOwnerRow[] = [];
  for (let i = 0, offset = 4; i < count; i++, offset += ROW_BYTES) {
    rows.push({
      state: buffer.readUInt32LE(offset),
      localAddr: buffer.readUInt32LE(offset + 4),
      localPort: port(buffer.readUInt32LE(offset + 8)),
      remoteAddr: buffer.readUInt32LE(offset + 12),
      remotePort: port(buffer.readUInt32LE(offset + 16)),
      pid: buffer.readUInt32LE(offset + 20),
    });
  }
  return rows;
}
